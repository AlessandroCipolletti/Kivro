import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { IOContract } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { inspectFile } from '@kivro/storage';
import { inspectMedia, MEDIA_MIME_TYPES } from '@kivro/storage/media';
import { generateMediaFixtures } from '../../storage/src/media-fixtures.js';
import { collectResultDirectory, sniffFileMime, sniffMime, validateResultFiles } from './files.js';

// Real codecs/exporters inside the approved, network-none image. No host mounts,
// buyer files, provider credentials or production mock acceptance are involved.
describe.skipIf(process.env.KIVRO_MEDIA_INTEGRATION !== '1')('real ffmpeg/Blender media boundaries', () => {
  let fixtures: Map<string, Buffer>, root: string;
  const names = ['lossy.webp', 'lossless.webp', 'clip.mov', 'clip.mp4', 'faststart.mp4', 'clip.webm', 'tone.mp3', 'tone.m4a', 'cube.obj', 'cube.fbx'];
  const contract: IOContract = { schemaVersion: 1, inputs: [], output: { type: 'FILES', description: '', required: true, files: {
    allowedExtensions: Object.keys(MEDIA_MIME_TYPES), allowedMimeTypes: Object.values(MEDIA_MIME_TYPES), maxFiles: 10, maxTotalSizeBytes: 1024 ** 2,
  } } };
  beforeAll(async () => {
    fixtures = await generateMediaFixtures(); root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-real-media-')));
    for (const [name, data] of fixtures) await writeFile(join(root, name), data);
  }, 200000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  it.each(names)('accepts generated %s through cloud, worker input and output with matching byte hashes', async name => {
    const data = fixtures.get(name)!, mime = MEDIA_MIME_TYPES[extname(name)];
    expect(data.length).toBeGreaterThan(0);
    if (name === 'clip.mp4') expect(data.indexOf('moov')).toBeGreaterThan(data.indexOf('mdat'));
    if (name === 'faststart.mp4') expect(data.indexOf('moov')).toBeLessThan(data.indexOf('mdat'));
    expect(inspectMedia(data, name)).toBe(mime);
    await expect(inspectFile(data, name, 'application/octet-stream', data.length)).resolves.toBe(mime);
    expect(sniffMime(data, name)).toBe(mime);
    await expect(sniffFileMime(join(root, name), name, data.length)).resolves.toBe(mime);
    const result = validateResultFiles([{ path: name, data: data.toString('base64'), sizeBytes: data.length }], contract, data.length)[0]!;
    expect(result.mimeType).toBe(mime); expect(result.sha256).toBe(sha256(data)); expect(result.data).toEqual(data);
  });
  it('collects only approved generated files and rejects appended payloads on real binary containers', async () => {
    const files = await collectResultDirectory(root, contract, 1024 ** 2);
    expect(files.map(file => file.filename).sort()).toEqual([...names].sort());
    for (const [name, data] of fixtures) {
      const bad = Buffer.concat([data, Buffer.from(name.endsWith('.obj') ? '\nmtllib /private/other.mtl' : 'MZexecutable-tail')]);
      expect(() => sniffMime(bad, name), name).toThrow();
      await expect(inspectFile(bad, name, 'application/octet-stream', bad.length)).rejects.toThrow();
    }
  });
  it.each(['ftyp-only', 'no-tracks', 'missing-mdat'] as const)('rejects %s corruption of real FFmpeg MP4 before storage or result acceptance', async defect => {
    const valid = fixtures.get('clip.mp4')!;
    const data = defect === 'ftyp-only' ? Buffer.from(valid.subarray(0, valid.readUInt32BE(0))) : Buffer.from(valid);
    if (defect !== 'ftyp-only') {
      const type = defect === 'no-tracks' ? 'trak' : 'mdat', position = data.indexOf(type);
      expect(position).toBeGreaterThan(0); data.write('free', position);
    }
    expect(() => inspectMedia(data, 'invalid.mp4')).toThrow();
    await expect(inspectFile(data, 'invalid.mp4', 'video/mp4', data.length)).rejects.toThrow();
    const path = join(root, `invalid-${defect}.mp4`);
    try {
      await writeFile(path, data);
      await expect(sniffFileMime(path, 'invalid.mp4', data.length)).rejects.toThrow();
      expect(() => validateResultFiles([{ path: 'invalid.mp4', data: data.toString('base64'), sizeBytes: data.length }], contract, data.length)).toThrow();
    } finally { await rm(path, { force: true }); }
  });
});

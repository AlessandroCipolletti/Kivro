import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { WORKER_FILE_FORMATS, executionFileCompatibilityIssues, type IOContract } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { MAX_MEDIA_BYTES, MEDIA_MIME_TYPES } from '@kivro/storage/media';
import { atom, fbxFixture, invalidMp4Fixtures, movieFixture, mp3Fixture, objFixture, webmFixture, webpFixture } from '../../storage/src/media-test-fixtures.js';
import { collectResultDirectory, sniffFileMime, sniffMime, validateResultFiles } from './files.js';

const fixtures = new Map([['triangle.obj', objFixture], ['image.webp', webpFixture()], ['movie.mov', movieFixture('mov')], ['movie.mp4', movieFixture('mp4')],
  ['audio.m4a', movieFixture('m4a')], ['audio.mp3', mp3Fixture()], ['movie.webm', webmFixture()], ['mesh.fbx', fbxFixture()]]);
const contract: IOContract = { schemaVersion: 1, inputs: [], output: { type: 'FILES', description: '', required: true, files: {
  allowedExtensions: Object.keys(MEDIA_MIME_TYPES), allowedMimeTypes: Object.values(MEDIA_MIME_TYPES), maxFiles: 10, maxTotalSizeBytes: 1024 ** 2,
} } };
const roots: string[] = [];
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-media-unit-'))); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('media boundaries with authored structural fixtures', () => {
  it.each([...fixtures])('validates the complete input and output body of %s with matching canonical types', async (name, data) => {
    const root = await directory(), path = join(root, name), mime = MEDIA_MIME_TYPES[extname(name)];
    await writeFile(path, data);
    expect(WORKER_FILE_FORMATS[extname(name)]).toBe(mime);
    expect(sniffMime(data, name)).toBe(mime);
    await expect(sniffFileMime(path, name, data.length)).resolves.toBe(mime);
    const files = validateResultFiles([{ path: name, data: data.toString('base64'), sizeBytes: data.length }], contract, data.length);
    expect(files[0]).toMatchObject({ mimeType: mime, sizeBytes: data.length, sha256: sha256(data) });
    expect((await collectResultDirectory(root, contract, data.length))[0]?.data).toEqual(data);
    await writeFile(path, data.subarray(0, 8));
    await expect(sniffFileMime(path, name, data.length)).rejects.toThrow();
  });
  it('checks the entire file beyond 64 KiB, including external OBJ references and a truncated late movie atom', async () => {
    const root = await directory(), path = join(root, 'large.obj');
    const valid = Buffer.concat([Buffer.from('# harmless padding\n'.repeat(5000)), objFixture]);
    await writeFile(path, valid); await expect(sniffFileMime(path, 'large.obj', valid.length)).resolves.toBe('model/obj');
    const external = Buffer.concat([valid, Buffer.from('mtllib https://attacker.invalid/private.mtl\n')]);
    await writeFile(path, external); await expect(sniffFileMime(path, 'large.obj', external.length)).rejects.toThrow('OBJ_EXTERNAL_REFERENCE');
    const movie = movieFixture('mov'); await writeFile(path, movie.subarray(0, -1));
    await expect(sniffFileMime(path, 'movie.mov', movie.length)).rejects.toThrow();
  });
  it.each([...invalidMp4Fixtures()])('rejects %s MP4 at input, result projection and directory collection boundaries', async (_name, data) => {
    const root = await directory(), name = 'invalid.mp4', path = join(root, name);
    await writeFile(path, data);
    expect(() => sniffMime(data, name)).toThrow();
    await expect(sniffFileMime(path, name, data.length)).rejects.toThrow();
    expect(() => validateResultFiles([{ path: name, data: data.toString('base64'), sizeBytes: data.length }], contract, data.length)).toThrow();
    await expect(collectResultDirectory(root, contract, data.length)).rejects.toThrow();
  });
  it('reads MP4 metadata after 64 KiB and rejects late corruption rather than accepting its prefix', async () => {
    const root = await directory(), path = join(root, 'late.mp4'), movie = movieFixture('mp4');
    const moov = movie.indexOf('moov') - 4;
    const data = Buffer.concat([movie.subarray(0, moov), atom('free', Buffer.alloc(65536)), movie.subarray(moov)]);
    await writeFile(path, data);
    await expect(sniffFileMime(path, 'late.mp4', data.length)).resolves.toBe('video/mp4');
    await writeFile(path, data.subarray(0, -1));
    await expect(sniffFileMime(path, 'late.mp4', data.length)).rejects.toThrow();
  });
  it('denies input symlinks, hardlinks, parent-path aliases, empty files and invalid/insufficient byte approvals', async () => {
    const root = await directory(), path = join(root, 'mesh.obj'), alias = join(root, 'alias.obj');
    await writeFile(path, objFixture);
    for (const limit of [0, -1, NaN, Infinity, 1.5, MAX_MEDIA_BYTES + 1, objFixture.length - 1]) await expect(sniffFileMime(path, 'mesh.obj', limit)).rejects.toThrow();
    await symlink(path, alias); await expect(sniffFileMime(alias, 'mesh.obj', 10000)).rejects.toThrow(); await rm(alias);
    await link(path, alias); await expect(sniffFileMime(alias, 'mesh.obj', 10000)).rejects.toThrow(); await rm(alias);
    const parentAlias = `${root}-alias`; roots.push(parentAlias); await symlink(root, parentAlias);
    await expect(sniffFileMime(join(parentAlias, 'mesh.obj'), 'mesh.obj', 10000)).rejects.toThrow();
    await writeFile(path, Buffer.alloc(0)); await expect(sniffFileMime(path, 'mesh.obj', 10000)).rejects.toThrow();
  });
  it('keeps contract compatibility, type approval, count and total-byte enforcement for the added formats', () => {
    expect(executionFileCompatibilityIssues(contract)).toEqual([]);
    const file = { path: 'audio.mp3', data: mp3Fixture().toString('base64'), sizeBytes: mp3Fixture().length };
    for (const files of [[{ ...file, path: 'disguised.m4a' }], [{ ...file, sizeBytes: 1 }]]) expect(() => validateResultFiles(files, contract, 10000)).toThrow();
    const restricted = { ...contract, output: { ...contract.output, files: { ...contract.output.files!, allowedMimeTypes: ['model/obj'] } } };
    expect(() => validateResultFiles([file], restricted, 10000)).toThrow('OUTPUT_TYPE_NOT_ALLOWED');
    expect(() => validateResultFiles([file], contract, file.sizeBytes - 1)).toThrow();
    expect(() => validateResultFiles(Array.from({ length: 11 }, () => file), contract, 10000)).toThrow('OUTPUT_FILE_COUNT');
  });
});

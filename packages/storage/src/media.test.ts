import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { inspectFile } from './index.js';
import { inspectMedia, MEDIA_MIME_TYPES, MAX_MEDIA_BYTES } from './media.js';
import { atom, ebml, fbxFixture, invalidMp4Fixtures, movieFixture, mp3Fixture, objFixture, webmFixture, webpFixture } from './media-test-fixtures.js';

const fixtures = () => new Map([['triangle.obj', objFixture], ['image.webp', webpFixture()], ['movie.mov', movieFixture('mov')], ['movie.mp4', movieFixture('mp4')],
  ['audio.m4a', movieFixture('m4a')], ['audio.mp3', mp3Fixture()], ['movie.webm', webmFixture()], ['mesh.fbx', fbxFixture()]]);
describe('bounded media structure and references (authored adversarial fixtures)', () => {
  it('projects canonical types consistently through signature detection and structural policy', async () => {
    for (const [name, data] of fixtures()) {
      expect(inspectMedia(data, name)).toBe(MEDIA_MIME_TYPES[name.slice(name.lastIndexOf('.'))]);
      expect(await inspectFile(data, name, 'application/octet-stream', MAX_MEDIA_BYTES)).toBe(inspectMedia(data, name));
    }
    expect(inspectMedia(fbxFixture(undefined, 7500), 'model.fbx')).toBe('application/vnd.autodesk.fbx');
  });
  it('rejects executable/script disguises, signature-only bodies, truncation and trailing payloads for every new format', async () => {
    for (const [name, data] of fixtures()) {
      for (const bad of [Buffer.from('MZ\x90\0payload'), Buffer.from('\x7fELFpayload'), Buffer.from('#!/bin/sh\necho bad'), Buffer.from('<script>bad</script>'), data.subarray(0, 8)]) {
        expect(() => inspectMedia(bad, name), name).toThrow(); await expect(inspectFile(bad, name, 'application/octet-stream', 100000)).rejects.toThrow();
      }
      if (!name.endsWith('.obj')) {
        expect(() => inspectMedia(data.subarray(0, data.length - 1), name), name).toThrow();
        expect(() => inspectMedia(Buffer.concat([data, Buffer.from('MZtrailing')]), name), name).toThrow();
      }
    }
  });
  it.each(['mtllib ../private.mtl', 'mtllib https://example.invalid/a.mtl', 'usemtl external', 'maplib /etc/passwd', 'call other.obj', 'csh curl attacker', 'surf 0 1 0 1 1 2 3', 'f 1 2 999', 'v NaN 0 0', 'v Infinity 0 0', 'o ../../outside', 'g https://attacker.invalid', 'f 0 1 2', 'f 1/ 2/ 3/'])('rejects unsafe OBJ content: %s', suffix => {
    expect(() => inspectMedia(Buffer.concat([objFixture, Buffer.from(suffix)]), 'model.obj')).toThrow();
  });
  it('accepts negative OBJ indices but rejects embedded NUL/invalid UTF-8 and external directives after a long prefix', () => {
    expect(inspectMedia(Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n'), 'mesh.obj')).toBe('model/obj');
    for (const suffix of [Buffer.from('\0'), Buffer.from([0xff]), Buffer.from(`${'#'.repeat(64000)}\nmtllib secrets.mtl`)]) expect(() => inspectMedia(Buffer.concat([objFixture, suffix]), 'mesh.obj')).toThrow();
  });
  it('rejects broken WebP chunk lengths, excessive dimensions and unknown embedded chunks', () => {
    const huge = webpFixture(); huge.writeUInt32LE(0x0fffffff, 21);
    const wrongSize = webpFixture(); wrongSize.writeUInt32LE(12345, 16);
    const unknown = webpFixture(); unknown.write('EXE ', 12);
    for (const bad of [huge, wrongSize, unknown]) expect(() => inspectMedia(bad, 'bad.webp')).toThrow();
  });
  it('requires self-contained movie tracks and rejects external URLs, overflow, codec/track disguises and sample offsets', () => {
    for (const ext of ['mov', 'mp4', 'm4a'] as const) expect(() => inspectMedia(movieFixture(ext, true), `external.${ext}`)).toThrow();
    expect(() => inspectMedia(movieFixture('mov', 'extra-reference'), 'extra.mov')).toThrow('EXTERNAL_MEDIA_REFERENCE');
    const oversized = movieFixture('mov'); oversized.writeUInt32BE(0xffffffff, 0);
    const wrongTrack = movieFixture('m4a'); wrongTrack.write('vide', wrongTrack.indexOf('soun'));
    const externalOffset = movieFixture('mov'); externalOffset.writeUInt32BE(1, externalOffset.indexOf('stco') + 12);
    const encrypted = movieFixture('mov'); encrypted.write('encv', encrypted.indexOf('avc1'));
    for (const bad of [oversized, externalOffset, encrypted]) expect(() => inspectMedia(bad, 'bad.mov')).toThrow();
    expect(() => inspectMedia(wrongTrack, 'video.m4a')).toThrow();
    expect(() => inspectMedia(Buffer.concat([movieFixture('mov'), atom('uuid', Buffer.from('embedded'))]), 'bad.mov')).toThrow();
  });
  it.each([...invalidMp4Fixtures()])('rejects %s MP4 before storage acceptance', async (_name, data) => {
    expect(() => inspectMedia(data, 'invalid.mp4')).toThrow();
    await expect(inspectFile(data, 'invalid.mp4', 'video/mp4', data.length)).rejects.toThrow();
  });
  it('requires an approved MP4 brand and a video track rather than renamed QuickTime or audio', () => {
    expect(() => inspectMedia(movieFixture('mov'), 'renamed.mp4')).toThrow('MEDIA_BRAND_MISMATCH');
    expect(() => inspectMedia(movieFixture('m4a'), 'renamed.mp4')).toThrow('MEDIA_BRAND_MISMATCH');
    expect(() => inspectMedia(invalidMp4Fixtures().get('audio-only')!, 'audio.mp4')).toThrow('VIDEO_TRACK_REQUIRED');
    const valid = movieFixture('mp4');
    for (const brand of ['isom', 'iso2', 'mp41', 'mp42', 'avc1']) {
      valid.write(brand, 8); expect(inspectMedia(valid, 'video.mp4')).toBe('video/mp4');
    }
  });
  it('requires actual WebM doctype/tracks/blocks and rejects linked segments, attachments and malformed VINTs', () => {
    expect(() => inspectMedia(webmFixture(ebml('3c83ab', Buffer.from('/etc/passwd'))), 'external.webm')).toThrow();
    const wrongCodec = webmFixture(); wrongCodec.write('V_EXE', wrongCodec.indexOf('V_VP8'));
    const wrongType = webmFixture(); wrongType.write('matr', wrongType.indexOf('webm'));
    const brokenVint = webmFixture(); brokenVint[4] = 0;
    for (const bad of [wrongCodec, wrongType, brokenVint]) expect(() => inspectMedia(bad, 'bad.webm')).toThrow();
  });
  it('requires consecutive MPEG audio frames and rejects oversized ID3 or tag-only/embedded URL payloads', () => {
    const broken = mp3Fixture(); broken[417] = 0;
    const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f]);
    const id3 = Buffer.alloc(24); id3.write('ID3'); id3[3] = 4; id3[9] = 14; id3.write('WXXX', 10); id3[17] = 4; id3.write('http', 20);
    for (const bad of [broken, header, id3, Buffer.concat([id3, mp3Fixture()])]) expect(() => inspectMedia(bad, 'bad.mp3')).toThrow();
  });
  it('rejects FBX offsets/count overflow, active external/embedded objects, compression bombs and invalid mesh indices', () => {
    for (const name of ['Video', 'Texture', 'Content', 'RelativeFilename', 'Implementation']) expect(() => inspectMedia(fbxFixture({ name }), 'external.fbx')).toThrow();
    const offset = fbxFixture(); offset.writeUInt32LE(0xffffffff, 27);
    const count = fbxFixture(); count.writeUInt32LE(0xffffffff, 31);
    const array = fbxFixture(); const arrayAt = array.indexOf('Vertices') + 8; array.writeUInt32LE(0xffffffff, arrayAt + 1);
    const encoding = fbxFixture(); const encodingAt = encoding.indexOf('Vertices') + 8; encoding.writeUInt32LE(2, encodingAt + 5);
    const index = fbxFixture(); const indexAt = index.indexOf('PolygonVertexIndex') + 18 + 13; index.writeInt32LE(999999, indexAt);
    for (const bad of [offset, count, array, encoding, index]) expect(() => inspectMedia(bad, 'bad.fbx')).toThrow();
  });
  it('accepts declared conventional aliases only after structural validation, with no extension/content override', async () => {
    await expect(inspectFile(movieFixture('m4a'), 'audio.m4a', 'audio/x-m4a', 10000)).resolves.toBe('audio/mp4');
    await expect(inspectFile(objFixture, 'mesh.obj', 'text/plain', 10000)).resolves.toBe('model/obj');
    await expect(inspectFile(fbxFixture(), 'mesh.fbx', 'application/x.autodesk.fbx', 10000)).resolves.toBe('application/vnd.autodesk.fbx');
    await expect(inspectFile(mp3Fixture(), 'audio.m4a', 'audio/mp4', 10000)).rejects.toThrow();
    await expect(inspectFile(webpFixture(), 'image.webp', 'text/plain', 10000)).rejects.toThrow();
  });
  it('bounds actual FBX decompression and rejects bytes after a complete compressed stream', () => {
    const fixture = (payload: Buffer, count: number) => {
      const header = Buffer.alloc(13); header.write('b'); header.writeUInt32LE(count, 1); header.writeUInt32LE(1, 5); header.writeUInt32LE(payload.length, 9);
      return fbxFixture({ name: 'UserData', properties: [Buffer.concat([header, payload])] });
    };
    const compressed = deflateSync(Buffer.from([0, 1, 0]));
    expect(inspectMedia(fixture(compressed, 3), 'compressed.fbx')).toBe('application/vnd.autodesk.fbx');
    expect(() => inspectMedia(fixture(Buffer.concat([compressed, Buffer.from('MZhidden')]), 3), 'trailing.fbx')).toThrow('FBX_COMPRESSED_TRAILING_DATA');
    expect(() => inspectMedia(fixture(deflateSync(Buffer.alloc(65536)), 1), 'bomb.fbx')).toThrow();
    expect(() => inspectMedia(fixture(Buffer.from('not-zlib'), 3), 'corrupt.fbx')).toThrow();
  });
});

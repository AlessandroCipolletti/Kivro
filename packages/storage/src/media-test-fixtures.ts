// Authored structural fixtures for adversarial tests, not codec-acceptance evidence.
export const objFixture = Buffer.from('# Synthetic triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1\n');
export const uint32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
export const atom = (type: string, body: Buffer) => Buffer.concat([uint32(8 + body.length), Buffer.from(type), body]);
export function movieFixture(extension: 'mov' | 'mp4' | 'm4a', external: boolean | 'extra-reference' = false): Buffer {
  const ftyp = atom('ftyp', Buffer.concat([Buffer.from(extension === 'mov' ? 'qt  ' : extension === 'm4a' ? 'M4A ' : 'mp42'), uint32(0), Buffer.from(extension === 'mov' ? 'qt  ' : 'isom')]));
  const mdat = atom('mdat', Buffer.alloc(20));
  const entry = Buffer.alloc(8); entry.writeUInt16BE(1, 6);
  const stsd = atom('stsd', Buffer.concat([uint32(0), uint32(1), atom(extension === 'm4a' ? 'mp4a' : 'avc1', entry)]));
  const stco = atom('stco', Buffer.concat([uint32(0), uint32(1), uint32(ftyp.length + 8)]));
  const stsz = atom('stsz', Buffer.concat([uint32(0), uint32(20), uint32(1)]));
  const stbl = atom('stbl', Buffer.concat([stsd, stco, stsz]));
  const dref = atom('dref', Buffer.concat([uint32(0), uint32(1),
    ...(external === 'extra-reference' ? [atom('urn ', Buffer.concat([uint32(0), Buffer.from('file:///etc/passwd\0')]))] : []),
    atom('url ', external === true ? Buffer.concat([uint32(0), Buffer.from('file:///etc/passwd\0')]) : uint32(1))]));
  const handler = Buffer.alloc(24); handler.write(extension === 'm4a' ? 'soun' : 'vide', 8);
  const mdia = atom('mdia', Buffer.concat([atom('hdlr', handler), atom('minf', Buffer.concat([atom('dinf', dref), stbl]))]));
  return Buffer.concat([ftyp, mdat, atom('moov', Buffer.concat([atom('mvhd', Buffer.alloc(32)), atom('trak', mdia)]))]);
}
export function invalidMp4Fixtures(): Map<string, Buffer> {
  const header = atom('ftyp', Buffer.concat([Buffer.from('mp42'), uint32(0), Buffer.from('mp42isom')]));
  const noTracks = movieFixture('mp4'); noTracks.write('free', noTracks.indexOf('trak'));
  const missingData = movieFixture('mp4'); missingData.write('free', missingData.indexOf('mdat'));
  const badOffset = movieFixture('mp4'); badOffset.writeUInt32BE(1, badOffset.indexOf('stco') + 12);
  const audioOnly = movieFixture('m4a'); audioOnly.write('mp42', 8);
  return new Map([
    ['ftyp-only', header], ['missing-moov', Buffer.concat([header, atom('mdat', Buffer.alloc(20))])],
    ['no-tracks', noTracks], ['missing-mdat', missingData],
    ['empty-mdat', Buffer.concat([header, atom('mdat', Buffer.alloc(0)), atom('moov', atom('mvhd', Buffer.alloc(32)))])],
    ['audio-only', audioOnly], ['external-reference', movieFixture('mp4', true)], ['invalid-offset', badOffset],
  ]);
}
export function mp3Fixture(): Buffer {
  const frame = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0]).copy(frame);
  return Buffer.concat([frame, frame]);
}
export function webpFixture(): Buffer {
  const data = Buffer.alloc(26); data.write('RIFF'); data.writeUInt32LE(18, 4); data.write('WEBPVP8L', 8); data.writeUInt32LE(6, 16); data[20] = 0x2f;
  return data;
}
export function ebml(id: string, body: Buffer): Buffer {
  let width = 1; while (body.length >= 2 ** (7 * width) - 1) width++;
  const size = Buffer.alloc(width); size.writeUIntBE(body.length, 0, width); size[0] = size[0]! | (1 << (8 - width));
  return Buffer.concat([Buffer.from(id, 'hex'), size, body]);
}
export function webmFixture(extra: Buffer = Buffer.alloc(0)): Buffer {
  const number = (id: string, value: number) => ebml(id, Buffer.from([value]));
  const track = ebml('ae', Buffer.concat([number('d7', 1), number('83', 1), ebml('86', Buffer.from('V_VP8')), ebml('e0', Buffer.concat([number('b0', 16), number('ba', 16)]))]));
  return Buffer.concat([ebml('1a45dfa3', ebml('4282', Buffer.from('webm'))), ebml('18538067', Buffer.concat([
    ebml('1549a966', extra), ebml('1654ae6b', track), ebml('1f43b675', Buffer.concat([number('e7', 0), ebml('a3', Buffer.from([0x81, 0, 0, 0x80, 1]))])),
  ]))]);
}

type FbxNode = { name: string; properties?: Buffer[]; children?: FbxNode[] };
const fbxString = (value: string) => { const bytes = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([Buffer.from('S'), length, bytes]); };
const fbxArray = (type: 'd' | 'i', values: number[]) => {
  const width = type === 'd' ? 8 : 4, header = Buffer.alloc(13), body = Buffer.alloc(width * values.length);
  header.write(type); header.writeUInt32LE(values.length, 1); header.writeUInt32LE(body.length, 9);
  values.forEach((value, i) => type === 'd' ? body.writeDoubleLE(value, i * width) : body.writeInt32LE(value, i * width));
  return Buffer.concat([header, body]);
};
export function fbxFixture(extra?: FbxNode, version = 7400): Buffer {
  const width = version >= 7500 ? 8 : 4, size = 3 * width + 1;
  function encode(node: FbxNode, offset: number): Buffer {
    const name = Buffer.from(node.name), properties = Buffer.concat(node.properties ?? []), header = Buffer.alloc(size);
    let cursor = offset + size + name.length + properties.length;
    const children = (node.children ?? []).map(child => { const bytes = encode(child, cursor); cursor += bytes.length; return bytes; });
    if (children.length) { children.push(Buffer.alloc(size)); cursor += size; }
    for (const [i, value] of [cursor, node.properties?.length ?? 0, properties.length].entries()) {
      if (width === 4) header.writeUInt32LE(value, i * width); else header.writeBigUInt64LE(BigInt(value), i * width);
    }
    header[size - 1] = name.length; return Buffer.concat([header, name, properties, ...children]);
  }
  const header = Buffer.alloc(27); header.write('Kaydara FBX Binary  \0\x1a\0', 'binary'); header.writeUInt32LE(version, 23);
  const roots: FbxNode[] = [{ name: 'FBXHeaderExtension' }, { name: 'Objects', children: [{ name: 'Geometry', properties: [fbxString('1'), fbxString('triangle'), fbxString('Mesh')], children: [
    { name: 'Vertices', properties: [fbxArray('d', [0, 0, 0, 1, 0, 0, 0, 1, 0])] }, { name: 'PolygonVertexIndex', properties: [fbxArray('i', [0, 1, -3])] }, ...(extra ? [extra] : []),
  ] }] }, { name: 'Connections' }];
  let cursor = 27;
  const records = roots.map(root => { const bytes = encode(root, cursor); cursor += bytes.length; return bytes; });
  const footer = Buffer.alloc(160); Buffer.from('fabcab09d0c8d466b176fb831cf7267e', 'hex').copy(footer); footer.writeUInt32LE(version, 20);
  Buffer.from('f85a8c6adef5d97eece90ce3758f290b', 'hex').copy(footer, 144);
  return Buffer.concat([header, ...records, Buffer.alloc(size), footer]);
}

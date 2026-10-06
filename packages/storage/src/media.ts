import { extname } from 'node:path';
import { inflateSync } from 'node:zlib';

export const MEDIA_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.webp': 'image/webp', '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.obj': 'model/obj', '.fbx': 'application/vnd.autodesk.fbx',
});
export const MAX_MEDIA_BYTES = 100 * 1024 ** 2;
export class MediaValidationError extends Error {}
const reject = (reason: string): never => { throw new MediaValidationError(reason); };
function need(condition: unknown, reason = 'INVALID_MEDIA_STRUCTURE'): asserts condition { if (!condition) reject(reason); }
const utf8 = (data: Buffer): string => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return reject('INVALID_MEDIA_TEXT'); }
};
const zero = (data: Buffer) => data.every(byte => byte === 0);
function pixels(width: number, height: number) { need(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40000000, 'MEDIA_DIMENSION_LIMIT'); }

// These are bounded container/security checks, not codec decoders. The actual
// media engines remain sandboxed; this does not replace malware scanning.
export function inspectMedia(data: Buffer, filename: string): string | undefined {
  const extension = extname(filename).toLowerCase(), mime = MEDIA_MIME_TYPES[extension];
  if (!mime) return undefined;
  need(data.length > 0 && data.length <= MAX_MEDIA_BYTES, 'MEDIA_BYTE_LIMIT');
  try {
    if (extension === '.webp') webp(data);
    else if (extension === '.mov' || extension === '.mp4' || extension === '.m4a') movie(data, extension);
    else if (extension === '.webm') webm(data);
    else if (extension === '.mp3') mp3(data);
    else if (extension === '.obj') obj(data);
    else fbx(data);
  } catch (error) {
    if (error instanceof MediaValidationError) throw error;
    reject('INVALID_MEDIA_STRUCTURE');
  }
  return mime;
}

function webp(data: Buffer) {
  need(data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length);
  let chunks = 0, images = 0, frames = 0, extended = false, animation = false, canvas: [number, number] | undefined;
  function image(type: string, body: Buffer): [number, number] {
    let width: number, height: number;
    if (type === 'VP8 ') {
      need(body.length >= 11 && !(body[0]! & 1) && body.subarray(3, 6).equals(Buffer.from([0x9d, 1, 0x2a])));
      need((body.readUIntLE(0, 3) >> 5) + 10 <= body.length);
      width = body.readUInt16LE(6) & 0x3fff; height = body.readUInt16LE(8) & 0x3fff;
    } else {
      need(body.length >= 6 && body[0] === 0x2f && (body[4]! & 0xe0) === 0);
      const bits = body.readUInt32LE(1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
    pixels(width, height); return [width, height];
  }
  function walk(start: number, end: number, frame = false) {
    let localImages = 0;
    for (let offset = start; offset < end;) {
      need(++chunks <= 10000 && offset + 8 <= end);
      const type = data.toString('ascii', offset, offset + 4), size = data.readUInt32LE(offset + 4), begin = offset + 8, stop = begin + size;
      need(stop + (size % 2) <= end && (!(size % 2) || data[stop] === 0));
      const body = data.subarray(begin, stop);
      if (type === 'VP8 ' || type === 'VP8L') {
        const dimensions = image(type, body); localImages++;
        if (!frame) { images++; if (canvas) need(dimensions[0] === canvas[0] && dimensions[1] === canvas[1]); }
      } else if (type === 'ALPH') need(size > 1 && (body[0]! & 0xc0) === 0 && (body[0]! & 3) <= 1);
      else if (!frame && type === 'VP8X') {
        need(!extended && offset === 12 && size === 10 && (body[0]! & 0xc1) === 0 && zero(body.subarray(1, 4)));
        extended = true; animation = Boolean(body[0]! & 2); canvas = [body.readUIntLE(4, 3) + 1, body.readUIntLE(7, 3) + 1]; pixels(...canvas);
      } else if (!frame && type === 'ANIM') need(extended && animation && size === 6);
      else if (!frame && type === 'ANMF') {
        need(extended && animation && size > 24 && ++frames <= 1000 && (body[15]! & 0xfc) === 0);
        const x = body.readUIntLE(0, 3) * 2, y = body.readUIntLE(3, 3) * 2, w = body.readUIntLE(6, 3) + 1, h = body.readUIntLE(9, 3) + 1;
        pixels(w, h); need(x + w <= canvas![0] && y + h <= canvas![1]);
        need(walk(begin + 16, stop, true) === 1);
      } else need(!frame && extended && ['ICCP', 'EXIF', 'XMP '].includes(type) && size <= 1024 * 1024, 'UNSUPPORTED_WEBP_CHUNK');
      offset = stop + (size % 2);
    }
    return localImages;
  }
  walk(12, data.length);
  need(animation ? frames > 0 && images === 0 : images === 1 && frames === 0);
}

type Atom = { type: string; start: number; body: number; end: number };
function movie(data: Buffer, extension: '.mov' | '.mp4' | '.m4a') {
  let atomCount = 0;
  const atoms = (start: number, end: number): Atom[] => {
    const result: Atom[] = [];
    for (let offset = start; offset < end;) {
      need(++atomCount <= 20000 && offset + 8 <= end);
      let size = data.readUInt32BE(offset), header = 8;
      const type = data.toString('latin1', offset + 4, offset + 8);
      if (size === 1) { need(offset + 16 <= end); const large = data.readBigUInt64BE(offset + 8); need(large <= BigInt(data.length)); size = Number(large); header = 16; }
      if (size === 0) { need(type === 'mdat'); size = end - offset; }
      need(size >= header && offset + size <= end);
      result.push({ type, start: offset, body: offset + header, end: offset + size }); offset += size;
    }
    return result;
  };
  const children = (atom: Atom) => atoms(atom.body, atom.end);
  const one = (nodes: Atom[], type: string): Atom => { const matches = nodes.filter(node => node.type === type); need(matches.length === 1, 'MISSING_OR_DUPLICATE_MEDIA_ATOM'); return matches[0]!; };
  const roots = atoms(0, data.length);
  need(roots.length >= 3 && roots.every(node => ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(node.type)), 'UNSUPPORTED_MOVIE_CONTAINER');
  const ftyp = one(roots, 'ftyp'); need(ftyp.start === 0 && ftyp.end - ftyp.body >= 8 && (ftyp.end - ftyp.body) % 4 === 0);
  const brand = data.toString('ascii', ftyp.body, ftyp.body + 4);
  const brands = extension === '.mov' ? ['qt  '] : extension === '.mp4' ? ['isom', 'iso2', 'mp41', 'mp42', 'avc1'] : ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42'];
  need(brands.includes(brand), 'MEDIA_BRAND_MISMATCH');
  const payloads = roots.filter(node => node.type === 'mdat'); need(payloads.length > 0 && payloads.every(node => node.end > node.body));
  const payloadBytes = payloads.reduce((sum, node) => sum + node.end - node.body, 0);
  const moov = children(one(roots, 'moov')); one(moov, 'mvhd');
  need(!moov.some(node => ['cmov', 'rmra', 'mvex'].includes(node.type)), 'EXTERNAL_OR_FRAGMENTED_MOVIE_DENIED');
  const tracks = moov.filter(node => node.type === 'trak'); need(tracks.length > 0 && tracks.length <= 16);
  let hasVideo = false;
  for (const track of tracks) {
    const mdia = children(one(children(track), 'mdia')), handler = one(mdia, 'hdlr');
    need(handler.end - handler.body >= 24);
    const kind = data.toString('ascii', handler.body + 8, handler.body + 12);
    need(extension === '.m4a' ? kind === 'soun' : ['vide', 'soun'].includes(kind), 'UNSUPPORTED_MEDIA_TRACK');
    if (kind === 'vide') hasVideo = true;
    const minf = children(one(mdia, 'minf')), dinf = children(one(minf, 'dinf')), dref = one(dinf, 'dref');
    need(dref.end - dref.body >= 8 && data.readUInt32BE(dref.body) === 0 && data.readUInt32BE(dref.body + 4) === 1);
    const references = atoms(dref.body + 8, dref.end); need(references.length === 1, 'EXTERNAL_MEDIA_REFERENCE_DENIED');
    const ref = one(references, 'url ');
    need(ref.end - ref.body === 4 && data.readUInt32BE(ref.body) === 1, 'EXTERNAL_MEDIA_REFERENCE_DENIED');
    const table = children(one(minf, 'stbl')), stsd = one(table, 'stsd');
    need(stsd.end - stsd.body >= 8 && data.readUInt32BE(stsd.body) === 0);
    const descriptions = atoms(stsd.body + 8, stsd.end);
    need(descriptions.length > 0 && descriptions.length <= 16 && descriptions.length === data.readUInt32BE(stsd.body + 4));
    for (const description of descriptions) {
      need(description.end - description.body >= 8 && data.readUInt16BE(description.body + 6) === 1, 'EXTERNAL_MEDIA_REFERENCE_DENIED');
      need((kind === 'soun' ? ['mp4a', 'alac', 'sowt', 'twos', 'lpcm', 'in24', 'in32', 'fl32', 'fl64'] :
        ['avc1', 'hvc1', 'hev1', 'mp4v', 'jpeg', 'png ', 'raw ', 'yuv2', 'rle ', 'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x']).includes(description.type), 'UNSUPPORTED_MEDIA_CODEC');
    }
    const offsets = table.filter(node => ['stco', 'co64'].includes(node.type)); need(offsets.length === 1);
    const offsetTable = offsets[0]!, width = offsetTable.type === 'co64' ? 8 : 4;
    need(offsetTable.end - offsetTable.body >= 8 && data.readUInt32BE(offsetTable.body) === 0);
    const count = data.readUInt32BE(offsetTable.body + 4); need(count > 0 && count <= 1000000 && offsetTable.body + 8 + count * width === offsetTable.end);
    for (let i = 0; i < count; i++) {
      const position = offsetTable.body + 8 + i * width;
      const value = width === 8 ? data.readBigUInt64BE(position) : BigInt(data.readUInt32BE(position));
      need(payloads.some(node => value >= BigInt(node.body) && value < BigInt(node.end)), 'MEDIA_OFFSET_OUT_OF_BOUNDS');
    }
    const stsz = one(table, 'stsz'); need(stsz.end - stsz.body >= 12 && data.readUInt32BE(stsz.body) === 0);
    const fixed = data.readUInt32BE(stsz.body + 4), samples = data.readUInt32BE(stsz.body + 8);
    need(samples > 0 && samples <= 2000000 && stsz.body + 12 + (fixed ? 0 : samples * 4) === stsz.end);
    let bytes = fixed * samples;
    if (!fixed) for (let i = 0; i < samples; i++) bytes += data.readUInt32BE(stsz.body + 12 + i * 4);
    need(bytes > 0 && bytes <= payloadBytes, 'MEDIA_SAMPLE_SIZE_LIMIT');
  }
  need(extension !== '.mp4' || hasVideo, 'VIDEO_TRACK_REQUIRED');
}

type Element = { id: number; body: number; end: number };
function webm(data: Buffer) {
  let count = 0;
  function vint(offset: number, end: number, id = false) {
    need(offset < end && data[offset] !== 0);
    let width = 1, mask = 128; while (!(data[offset]! & mask)) { width++; mask >>= 1; }
    need(width <= (id ? 4 : 8) && offset + width <= end);
    let value = BigInt(id ? data[offset]! : data[offset]! & (mask - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(data[offset + i]!);
    const unknown = !id && value === (1n << BigInt(7 * width)) - 1n;
    need(unknown || value <= BigInt(Number.MAX_SAFE_INTEGER));
    return { value: Number(value), width, unknown };
  }
  function elements(start: number, end: number): Element[] {
    const values: Element[] = [];
    for (let offset = start; offset < end;) {
      need(++count <= 100000);
      const id = vint(offset, end, true), size = vint(offset + id.width, end), body = offset + id.width + size.width;
      need(!size.unknown || id.value === 0x18538067, 'UNSUPPORTED_STREAMING_WEBM');
      const stop = size.unknown ? end : body + size.value; need(stop <= end);
      values.push({ id: id.value, body, end: stop }); offset = stop;
    }
    return values;
  }
  const children = (element: Element) => elements(element.body, element.end);
  const one = (nodes: Element[], id: number): Element => { const found = nodes.filter(node => node.id === id); need(found.length === 1); return found[0]!; };
  const uint = (element: Element): number => { need(element.end - element.body > 0 && element.end - element.body <= 6); return data.readUIntBE(element.body, element.end - element.body); };
  const roots = elements(0, data.length); need(roots.length === 2 && roots[0]!.id === 0x1a45dfa3 && roots[1]!.id === 0x18538067);
  const doctype = one(children(roots[0]!), 0x4282); need(data.toString('ascii', doctype.body, doctype.end) === 'webm');
  const segment = children(roots[1]!);
  need(segment.every(node => [0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1254c367, 0xec, 0xbf].includes(node.id)), 'WEBM_ATTACHMENTS_OR_UNKNOWN_SEGMENT_DENIED');
  const info = children(one(segment, 0x1549a966));
  need(!info.some(node => [0x3cb923, 0x3c83ab, 0x3eb923, 0x3e83bb, 0x4444, 0x6924].includes(node.id)), 'EXTERNAL_MEDIA_REFERENCE_DENIED');
  const tracks = children(one(segment, 0x1654ae6b)).filter(node => node.id === 0xae); need(tracks.length > 0 && tracks.length <= 16);
  const numbers = new Set<number>();
  for (const track of tracks) {
    const fields = children(track), number = uint(one(fields, 0xd7)), type = uint(one(fields, 0x83)), codec = one(fields, 0x86);
    need(number > 0 && !numbers.has(number)); numbers.add(number);
    need(!fields.some(node => [0x6d80, 0x7446, 0x6fab, 0x6624].includes(node.id)), 'EXTERNAL_OR_ENCRYPTED_MEDIA_DENIED');
    const codecId = data.toString('ascii', codec.body, codec.end);
    need(type === 1 ? ['V_VP8', 'V_VP9', 'V_AV1'].includes(codecId) : type === 2 && ['A_VORBIS', 'A_OPUS'].includes(codecId), 'UNSUPPORTED_MEDIA_CODEC');
    if (type === 1) { const video = children(one(fields, 0xe0)); pixels(uint(one(video, 0xb0)), uint(one(video, 0xba))); }
  }
  let blocks = 0;
  function block(element: Element) {
    const track = vint(element.body, element.end); need(numbers.has(track.value) && element.end - element.body > track.width + 3);
    // Lacing requires codec-aware framing; fail closed instead of guessing lengths.
    need((data[element.body + track.width + 2]! & 6) === 0, 'UNSUPPORTED_WEBM_LACING'); blocks++;
  }
  for (const cluster of segment.filter(node => node.id === 0x1f43b675)) {
    const fields = children(cluster); one(fields, 0xe7);
    for (const field of fields) {
      if (field.id === 0xa3) block(field);
      else if (field.id === 0xa0) block(one(children(field), 0xa1));
      else need([0xe7, 0xab, 0xa7, 0xec, 0xbf].includes(field.id), 'UNSUPPORTED_WEBM_CLUSTER');
    }
  }
  need(blocks > 0);
}

function mp3(data: Buffer) {
  let offset = 0, frames = 0, versionSeen: number | undefined, sampleSeen: number | undefined;
  if (data.toString('ascii', 0, 3) === 'ID3') {
    need(data.length >= 10 && [3, 4].includes(data[3]!) && data[4] === 0 && data[5] === 0, 'UNSUPPORTED_ID3_ENCODING');
    const sync = (at: number) => { need(at + 4 <= data.length && data.subarray(at, at + 4).every(byte => byte < 128)); return data[at]! * 2097152 + data[at + 1]! * 16384 + data[at + 2]! * 128 + data[at + 3]!; };
    const end = 10 + sync(6); need(end <= data.length && end <= 4 * 1024 ** 2);
    for (let position = 10; position < end;) {
      if (data[position] === 0) { need(zero(data.subarray(position, end))); break; }
      need(position + 10 <= end);
      const id = data.toString('ascii', position, position + 4), length = data[3] === 4 ? sync(position + 4) : data.readUInt32BE(position + 4);
      need(/^(?:T[A-Z0-9]{3}|COMM|USLT)$/.test(id) && data.readUInt16BE(position + 8) === 0, 'ID3_ATTACHMENT_OR_URL_DENIED');
      need(length > 0 && position + 10 + length <= end); position += 10 + length;
    }
    offset = end;
  }
  const end = data.length - (data.length - offset >= 128 && data.toString('ascii', data.length - 128, data.length - 125) === 'TAG' ? 128 : 0);
  while (offset < end) {
    need(++frames <= 1000000 && offset + 4 <= end && data[offset] === 0xff && (data[offset + 1]! & 0xe0) === 0xe0);
    const version = (data[offset + 1]! >> 3) & 3, layer = (data[offset + 1]! >> 1) & 3, index = data[offset + 2]! >> 4, sample = (data[offset + 2]! >> 2) & 3;
    need(version !== 1 && layer === 1 && index > 0 && index < 15 && sample !== 3 && (data[offset + 3]! & 3) !== 2);
    need(versionSeen === undefined || versionSeen === version); need(sampleSeen === undefined || sampleSeen === sample); versionSeen = version; sampleSeen = sample;
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[index]! * 1000;
    const rate = [44100, 48000, 32000][sample]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + ((data[offset + 2]! >> 1) & 1);
    need(length >= 24 && offset + length <= end); offset += length;
  }
  need(frames >= 2 && offset === end, 'MISSING_MPEG_AUDIO_FRAMES');
}

function obj(data: Buffer) {
  const text = utf8(data); need(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text), 'UNSAFE_OBJ_CONTENT');
  let vertices = 0, normals = 0, uvs = 0, faces = 0, lines = 0;
  const numeric = (token: string) => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(token) && Number.isFinite(Number(token)) && Math.abs(Number(token)) <= 1e12;
  for (const raw of text.split(/\r?\n/)) {
    need(++lines <= 1000000 && raw.length <= 65536, 'OBJ_COMPLEXITY_LIMIT');
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const [command, ...args] = line.split(/\s+/);
    if (['v', 'vn', 'vt'].includes(command!)) {
      need(args.length >= (command === 'vt' ? 1 : 3) && args.length <= (command === 'v' ? 4 : 3) && args.every(numeric), 'INVALID_OBJ_VERTEX');
      if (command === 'v') vertices++; else if (command === 'vn') normals++; else uvs++;
    } else if (command === 'f') {
      need(args.length >= 3 && args.length <= 4096); faces++;
      for (const value of args) {
        need(/^-?\d+(?:\/-?\d*\/?-?\d*)?$/.test(value));
        const parts = value.split('/'); need(parts.length <= 3);
        for (const [i, index] of parts.entries()) {
          if (!index) { need(i === 1 && parts.length === 3 && !!parts[2]); continue; }
          const n = Number(index); need(Number.isSafeInteger(n) && n !== 0 && Math.abs(n) <= [vertices, uvs, normals][i]!, 'OBJ_INDEX_OUT_OF_BOUNDS');
        }
      }
    } else if (command === 'o' || command === 'g') need(args.length > 0 && args.every(name => /^[A-Za-z0-9_. -]{1,120}$/.test(name) && !name.includes('..')), 'UNSAFE_OBJ_NAME');
    else if (command === 's') need(args.length === 1 && /^(?:off|on|0|[1-9]\d{0,8})$/.test(args[0]!));
    else reject('OBJ_EXTERNAL_REFERENCE_OR_COMMAND_DENIED');
  }
  need(vertices >= 3 && faces > 0, 'OBJ_GEOMETRY_REQUIRED');
}

function fbx(data: Buffer) {
  need(data.length > 200 && data.subarray(0, 23).equals(Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'binary')), 'UNSUPPORTED_FBX_ENCODING');
  const version = data.readUInt32LE(23); need([7400, 7500].includes(version), 'UNSUPPORTED_FBX_VERSION');
  const width = version >= 7500 ? 8 : 4, header = 3 * width + 1;
  let nodes = 0, properties = 0, expanded = 0, geometries = 0;
  const forbidden = new Set(['Video', 'Texture', 'LayeredTexture', 'Implementation', 'BindingTable', 'BindingOperator', 'Content', 'Thumbnail', 'FileName', 'Filename', 'RelativeFilename', 'RelativeFileName', 'Media', 'Url', 'URL']);
  const integer = (offset: number) => { if (width === 4) return data.readUInt32LE(offset); const n = data.readBigUInt64LE(offset); need(n <= BigInt(data.length)); return Number(n); };
  type Property = string | number | bigint | { type: string; bytes: Buffer; count: number };
  function node(offset: number, parentEnd: number, depth: number): { end: number; name: string; props: Property[]; children: ReturnType<typeof node>[] } {
    need(depth <= 32 && ++nodes <= 100000 && offset + header <= parentEnd, 'FBX_COMPLEXITY_LIMIT');
    const end = integer(offset), count = integer(offset + width), size = integer(offset + 2 * width), nameLength = data[offset + 3 * width]!;
    need(end > offset + header && end <= parentEnd && nameLength > 0 && offset + header + nameLength + size <= end);
    const name = data.toString('ascii', offset + header, offset + header + nameLength); need(/^[A-Za-z0-9_]+$/.test(name) && !forbidden.has(name), 'FBX_EXTERNAL_OR_EMBEDDED_CONTENT_DENIED');
    let position = offset + header + nameLength;
    const propertyEnd = position + size, props: Property[] = [];
    for (let i = 0; i < count; i++) {
      need(++properties <= 500000 && position < propertyEnd, 'FBX_COMPLEXITY_LIMIT');
      const type = String.fromCharCode(data[position++]!);
      const primitive: Record<string, number> = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
      if (primitive[type]) {
        const bytes = primitive[type]!; need(position + bytes <= propertyEnd);
        const value = type === 'F' ? data.readFloatLE(position) : type === 'D' ? data.readDoubleLE(position) : type === 'L' ? data.readBigInt64LE(position) : data.readIntLE(position, bytes);
        need(typeof value === 'bigint' || Number.isFinite(value)); props.push(value); position += bytes;
      } else if (type === 'S' || type === 'R') {
        need(position + 4 <= propertyEnd); const length = data.readUInt32LE(position); position += 4;
        need(length <= 1024 * 1024 && position + length <= propertyEnd);
        if (type === 'R') need(name === 'FileId' && length === 16, 'FBX_EMBEDDED_BINARY_DENIED');
        props.push(type === 'S' ? utf8(data.subarray(position, position + length)) : ''); position += length;
      } else {
        const bytes = ({ f: 4, d: 8, l: 8, i: 4, b: 1, c: 1 } as Record<string, number>)[type];
        need(bytes && position + 12 <= propertyEnd);
        const length = data.readUInt32LE(position), encoding = data.readUInt32LE(position + 4), compressed = data.readUInt32LE(position + 8); position += 12;
        const expected = length * bytes; expanded += expected;
        need(expected <= 16 * 1024 ** 2 && expanded <= 64 * 1024 ** 2 && [0, 1].includes(encoding) && position + compressed <= propertyEnd, 'FBX_ARRAY_LIMIT');
        const source = data.subarray(position, position + compressed);
        let decoded = source;
        if (encoding === 1) {
          // Node's info:true returns consumption metadata; its Buffer-only type
          // declaration does not describe that runtime overload.
          const inflated = inflateSync(source, { maxOutputLength: Math.max(1, expected), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
          need(inflated.engine.bytesWritten === source.length, 'FBX_COMPRESSED_TRAILING_DATA'); decoded = inflated.buffer;
        }
        need(decoded.length === expected, 'FBX_ARRAY_LENGTH_MISMATCH'); position += compressed;
        if (type === 'd' || type === 'f') for (let j = 0; j < length; j++) need(Number.isFinite(type === 'd' ? decoded.readDoubleLE(j * bytes) : decoded.readFloatLE(j * bytes)));
        props.push({ type, bytes: decoded, count: length });
      }
    }
    need(position === propertyEnd);
    const nested: ReturnType<typeof node>[] = [];
    if (position < end) {
      need(end - position >= header && zero(data.subarray(end - header, end)));
      while (position < end - header) { const child = node(position, end - header, depth + 1); nested.push(child); position = child.end; }
      need(position === end - header);
    }
    if (name === 'References') need(count === 0 && nested.length === 0, 'FBX_EXTERNAL_REFERENCE_DENIED');
    if (name === 'Objects') need(nested.every(child => ['Geometry', 'Model', 'Material', 'Deformer', 'NodeAttribute', 'Pose', 'AnimationStack', 'AnimationLayer', 'AnimationCurve', 'AnimationCurveNode'].includes(child.name)), 'UNSUPPORTED_FBX_OBJECT');
    if (name === 'Geometry') {
      need(props[2] === 'Mesh', 'UNSUPPORTED_FBX_GEOMETRY');
      const vertices = nested.find(child => child.name === 'Vertices')?.props[0], indices = nested.find(child => child.name === 'PolygonVertexIndex')?.props[0];
      need(typeof vertices === 'object' && vertices.type === 'd' && vertices.count >= 9 && vertices.count % 3 === 0 && typeof indices === 'object' && indices.type === 'i');
      let polygon = 0, faces = 0;
      for (let i = 0; i < indices.count; i++) { const index = indices.bytes.readInt32LE(i * 4); need((index < 0 ? -index - 1 : index) < vertices.count / 3, 'FBX_INDEX_OUT_OF_BOUNDS'); polygon++; if (index < 0) { need(polygon >= 3); polygon = 0; faces++; } }
      need(polygon === 0 && faces > 0); geometries++;
    }
    return { end, name, props, children: nested };
  }
  let position = 27; const roots = new Set<string>();
  while (position + header <= data.length && !zero(data.subarray(position, position + header))) {
    const root = node(position, data.length, 0);
    need(['FBXHeaderExtension', 'FileId', 'CreationTime', 'Creator', 'GlobalSettings', 'Documents', 'References', 'Definitions', 'Objects', 'Connections', 'Takes'].includes(root.name), 'UNSUPPORTED_FBX_ROOT');
    need(!roots.has(root.name)); roots.add(root.name); position = root.end;
  }
  need(position + header < data.length && zero(data.subarray(position, position + header))); position += header;
  // Standard FBX footer: 16-byte identifier, zero alignment, version, reserved bytes and terminal magic.
  need(data.subarray(position, position + 16).equals(Buffer.from('fabcab09d0c8d466b176fb831cf7267e', 'hex'))); position += 16;
  const versionAt = data.length - 140;
  need(versionAt - position >= 4 && versionAt - position <= 20 && zero(data.subarray(position, versionAt)) && data.readUInt32LE(versionAt) === version);
  need(zero(data.subarray(versionAt + 4, data.length - 16)) && data.subarray(-16).equals(Buffer.from('f85a8c6adef5d97eece90ce3758f290b', 'hex')));
  need(roots.has('FBXHeaderExtension') && roots.has('Objects') && roots.has('Connections') && geometries > 0, 'FBX_GEOMETRY_REQUIRED');
}

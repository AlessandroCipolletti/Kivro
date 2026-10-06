import { describe, it, expect } from 'vitest';
import { inspectFile, safeFilename } from './index.js';
import { crc32, deflateRawSync } from 'node:zlib';
import { validateOfficeContainer } from './office.js';

// Minimal ZIP records keep hostile fixtures deterministic and independent of host tools.
function zipFixture(entries: { name: string; content: Buffer; mode?: number }[]): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = deflateRawSync(entry.content), checksum = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(entry.content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(entry.content.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe('untrusted uploads', () => {
  it('rejects path traversal, control characters and executable disguises', async () => {
    for (const name of ['../secret.txt', '/etc/passwd', 'C:\\secret', '.env', 'a\nb.txt']) expect(() => safeFilename(name)).toThrow();
    await expect(inspectFile(Buffer.from('MZ\0\0'), 'photo.jpg', 'image/jpeg', 100)).rejects.toThrow();
    await expect(inspectFile(Buffer.from('hello'), 'payload.exe', 'application/octet-stream', 100)).rejects.toThrow();
  });
  it('validates UTF-8, JSON and the declared type rather than browser MIME alone', async () => {
    await expect(inspectFile(Buffer.from('hello'), 'readme.md', 'text/markdown', 100)).resolves.toBe('text/markdown');
    await expect(inspectFile(Buffer.from('{"safe":true}'), 'data.json', 'application/json', 100)).resolves.toBe('application/json');
    await expect(inspectFile(Buffer.from('{'), 'data.json', 'application/json', 100)).rejects.toThrow();
    await expect(inspectFile(Buffer.from([0xff, 0xfe]), 'text.txt', 'text/plain', 100)).rejects.toThrow();
    await expect(inspectFile(Buffer.from('hello'), 'a.txt', 'image/png', 100)).rejects.toThrow();
    await expect(inspectFile(Buffer.from('too long'), 'a.txt', 'text/plain', 3)).rejects.toThrow();
  });
  it('accepts bounded DOCX/XLSX containers and rejects archive traversal, links, macros and bombs', async () => {
    for (const format of ['docx', 'xlsx'] as const) {
      const main = format === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
      const mime = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const entries = [{ name: '[Content_Types].xml', content: Buffer.from(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="${mime}.main+xml"/></Types>`) }, { name: main, content: Buffer.from('<document/>') }];
      const valid = zipFixture(entries);
      await expect(validateOfficeContainer(valid, format)).resolves.toBeUndefined();
      await expect(inspectFile(valid, `report.${format}`, 'application/octet-stream', 10000)).resolves.toContain('officedocument');
      for (const bad of [
        { name: '../outside.xml', content: Buffer.from('x') },
        { name: 'word/vbaProject.bin', content: Buffer.from('macro') },
        { name: 'word/linked.xml', content: Buffer.from('/etc/passwd'), mode: 0o120777 },
        { name: 'word/bomb.xml', content: Buffer.alloc(2 * 1024 ** 2) },
        { name: main, content: Buffer.from('duplicate') },
      ]) await expect(validateOfficeContainer(zipFixture([...entries, bad]), format)).rejects.toThrow();
      await expect(inspectFile(valid, 'archive.zip', 'application/zip', 10000)).rejects.toThrow();
    }
  });
});

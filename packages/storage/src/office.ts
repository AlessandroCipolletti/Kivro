import { fromBuffer, type Entry } from 'yauzl';

export async function validateOfficeContainer(data: Buffer, format: 'docx' | 'xlsx'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: true }, (openError, zip) => {
      if (openError || !zip) { reject(new Error('Invalid Office container')); return; }
      let count = 0, total = 0;
      const names = new Set<string>();
      const fail = (message: string) => { zip.close(); reject(new Error(message)); };
      zip.on('error', () => fail('Invalid Office container'));
      zip.on('entry', (entry: Entry) => {
        count++;
        const name = entry.fileName;
        const mode = entry.externalFileAttributes >>> 16;
        if (count > 2000 || names.has(name) || name.length > 500 || name.startsWith('/') || name.includes('\\') || /[\x00-\x1f]/.test(name) ||
          name.split('/').some(segment => segment === '..' || segment === '.') || (mode & 0o170000) === 0o120000 || (entry.generalPurposeBitFlag & 1) ||
          /(?:vbaProject|macros|embeddings|\.exe$|\.dll$|\.js$|\.zip$)/i.test(name)) { fail('Unsafe Office container entry'); return; }
        names.add(name);
        if (entry.uncompressedSize > 50 * 1024 ** 2 || entry.uncompressedSize > Math.max(1024 ** 2, entry.compressedSize * 100)) { fail('Office container expansion limit exceeded'); return; }
        if (name.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail('Invalid Office container stream'); return; }
          let entryBytes = 0;
          stream.on('data', chunk => {
            entryBytes += chunk.length; total += chunk.length;
            if (entryBytes > entry.uncompressedSize || total > 100 * 1024 ** 2) { stream.destroy(); fail('Office container expansion limit exceeded'); }
          });
          stream.once('error', () => fail('Office container decompression failed'));
          stream.once('end', () => { if (entryBytes !== entry.uncompressedSize) fail('Office container size mismatch'); else zip.readEntry(); });
        });
      });
      zip.once('end', () => {
        if (!names.has('[Content_Types].xml') || !names.has(format === 'docx' ? 'word/document.xml' : 'xl/workbook.xml')) fail('Office document is missing required entries');
        else resolve();
      });
      zip.readEntry();
    });
  });
}

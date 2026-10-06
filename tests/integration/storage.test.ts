import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { createObjectStore, inspectFile, type S3ObjectStore } from '../../packages/storage/src/index.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('real S3-compatible object pipeline', () => {
  let storage: S3ObjectStore;
  const keys: string[] = [];
  beforeAll(async () => {
    config({ path: '.env' });
    if (process.env.KIVRO_ENV !== 'development' || process.env.S3_BUCKET !== 'kivro-development') throw new Error('Integration tests require dedicated local infrastructure.');
    storage = createObjectStore();
    await storage.ready();
  });
  afterAll(async () => { for (const key of keys) await storage.delete(key); });
  it('stores original bytes, hashes them and generates bounded attachment downloads', async () => {
    const data = Buffer.from('company,revenue\nKivro,123\n');
    const mime = await inspectFile(data, 'input.csv', 'text/csv', 1024);
    const uploaded = await storage.put(data, 'input.csv', mime);
    keys.push(uploaded.key);
    expect(uploaded.key).not.toContain('input.csv');
    expect(uploaded.sizeBytes).toBe(data.byteLength);
    expect(uploaded.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await storage.get(uploaded.key)).toEqual(data);
    const signed = await storage.downloadUrl(uploaded.key, 'report.csv', 120);
    const response = await fetch(signed);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    const unsigned = new URL(signed); unsigned.search = '';
    expect((await fetch(unsigned)).ok).toBe(false);
  });
  it('rejects unsafe names and executable payloads before storage', async () => {
    await expect(inspectFile(Buffer.from('ok'), '../private.txt', 'text/plain', 1024)).rejects.toThrow();
    await expect(inspectFile(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]), 'safe.txt', 'text/plain', 1024)).rejects.toThrow();
  });
});

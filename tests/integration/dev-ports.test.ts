import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findDevelopmentPort } from '../../scripts/common.js';

describe.skipIf(process.env.KIVRO_INTEGRATION !== '1')('real development listeners', () => {
  it('skips occupied IPv4 loopback ports and previously selected service ports', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
    try {
      const address = occupied.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      const start = Math.min(address.port, 65516);
      const selected = await findDevelopmentPort(start);
      expect(selected).not.toBe(address.port);
      const excluded = await findDevelopmentPort(start, [selected]);
      expect(excluded).not.toBe(selected);
      expect(excluded).not.toBe(address.port);
    } finally { await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())); }
  });
});

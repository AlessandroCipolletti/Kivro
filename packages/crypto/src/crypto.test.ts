import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateDeviceIdentity, signMessage, verifyMessage, stableStringify, sealSecret, openSecret } from './index.ts';
import { stableStringify as sharedCanonical } from '@kivro/contracts';
describe('device crypto', () => {
  it('rejects forgery, mutation, malformed signatures and wrong keys', () => {
    const identity = generateDeviceIdentity(), other = generateDeviceIdentity();
    const signature = signMessage('payload', identity.privateKey);
    expect(verifyMessage('payload', signature, identity.publicKey)).toBe(true);
    expect(verifyMessage('changed', signature, identity.publicKey)).toBe(false);
    expect(verifyMessage('payload', signature, other.publicKey)).toBe(false);
    expect(verifyMessage('payload', signature + '\n', identity.publicKey)).toBe(false);
  });
  it('agrees with shared canonical JSON', () => {
    const value = { z: [1, null, { unicode: 'hello', a: true }], a: 'quote"\n' };
    expect(stableStringify(value)).toBe(sharedCanonical(value));
  });
  it('binds authenticated encryption to secret identity and rejects tampering', () => {
    const key = randomBytes(32), encrypted = sealSecret('private', key, 'device:secret');
    expect(openSecret(encrypted, key, 'device:secret')).toBe('private');
    expect(() => openSecret(encrypted, key, 'other:secret')).toThrow();
    expect(() => openSecret(encrypted, randomBytes(32), 'device:secret')).toThrow();
    expect(() => openSecret({ ...encrypted, ciphertext: Buffer.from('altered').toString('base64') }, key, 'device:secret')).toThrow();
  });
});

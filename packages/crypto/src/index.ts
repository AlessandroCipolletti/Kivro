import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// This canonicalization intentionally matches contracts.stableStringify JSON.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('NON_JSON_VALUE');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('NON_JSON_OBJECT');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function generateDeviceIdentity(): { publicKey: string; privateKey: string } {
  const keys = generateKeyPairSync('ed25519');
  return { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export function assertEd25519PublicKey(pem: string): void {
  if (pem.length > 1024 || createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('INVALID_SIGNING_KEY');
}

export function signMessage(message: string | Uint8Array, privateKey: string): string {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('INVALID_SIGNING_KEY');
  return sign(null, Buffer.from(message), key).toString('base64');
}

export function verifyMessage(message: string | Uint8Array, signature: string, publicKey: string): boolean {
  try {
    assertEd25519PublicKey(publicKey);
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    return verify(null, Buffer.from(message), publicKey, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

export function constantEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type SealedSecret = { version: 1; iv: string; ciphertext: string; tag: string };
export function sealSecret(plaintext: string, key: Uint8Array, context: string): SealedSecret {
  if (key.byteLength !== 32) throw new Error('INVALID_MASTER_KEY');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  return { version: 1, iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export function openSecret(sealed: SealedSecret, key: Uint8Array, context: string): string {
  if (sealed.version !== 1 || key.byteLength !== 32) throw new Error('INVALID_SEALED_SECRET');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

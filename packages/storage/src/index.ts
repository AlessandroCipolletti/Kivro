import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { safeFilename, FileValidationError } from './validation.js';
export { safeFilename, FileValidationError, inspectFile } from './validation.js';
export { scanWithClamAv, scanStreamWithClamAv, type ScanOptions, type ScanReceipt } from './scanner.js';

export interface StoredObject { key: string; sizeBytes: number; sha256: string; mimeType: string; filename: string }
export interface ObjectStore {
  put(data: Buffer, filename: string, mimeType: string): Promise<StoredObject>;
  putAt(key: string, data: Buffer, filename: string, mimeType: string): Promise<StoredObject>;
  get(key: string, maxBytes?: number): Promise<Buffer>;
  getStream?(key: string, maxBytes: number): Promise<Readable>;
  uploadUrl?(key: string, mimeType: string, sizeBytes: number, sha256: string, expiresIn?: number): Promise<string>;
  delete(key: string): Promise<void>;
  downloadUrl(key: string, filename: string, expiresIn?: number): Promise<string>;
  ready(): Promise<void>;
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export class S3ObjectStore implements ObjectStore {
  readonly client: S3Client;
  constructor(private readonly bucket: string, options: {
    endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean;
  }) {
    this.client = new S3Client({ ...options, credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
  }
  async ready() { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); }
  async ensureDevelopmentBucket() {
    try { await this.ready(); } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
  async ensureBucket() { await this.ensureDevelopmentBucket(); }
  async configureBrowserOrigin(origin: string) {
    if (new URL(origin).origin !== origin) throw new Error('Storage CORS requires an exact web origin');
    await this.client.send(new PutBucketCorsCommand({ Bucket: this.bucket, CORSConfiguration: { CORSRules: [
      { AllowedOrigins: [origin], AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['content-type', 'x-amz-checksum-sha256'], MaxAgeSeconds: 300 },
    ] } }));
  }
  async put(data: Buffer, filename: string, mimeType: string): Promise<StoredObject> {
    return this.putAt(`assets/${randomUUID()}`, data, filename, mimeType);
  }
  async putAt(key: string, data: Buffer, filename: string, mimeType: string): Promise<StoredObject> {
    safeFilename(filename);
    if (!/^assets\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key)) throw new FileValidationError('Invalid private object key');
    const hash = sha256(data);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data,
      ContentType: mimeType, ContentLength: data.length, Metadata: { sha256: hash }, IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(60_000) });
    return { key, sizeBytes: data.length, sha256: hash, filename, mimeType };
  }
  async getStream(key: string, maxBytes: number): Promise<Readable> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 ** 2) throw new FileValidationError('Invalid object size bound');
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(60_000) });
    if (!(object.Body instanceof Readable)) throw new Error('Object has no readable body');
    const body = object.Body;
    if (object.ContentLength !== undefined && object.ContentLength > maxBytes) { body.destroy(); throw new FileValidationError('Object exceeds its authorized size'); }
    return Readable.from((async function* () {
      let size = 0;
      try {
        for await (const part of body) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += bytes.length;
          if (size > maxBytes) throw new FileValidationError('Object exceeds its authorized size');
          yield bytes;
        }
      } finally { body.destroy(); }
    })());
  }
  async get(key: string, maxBytes = 100 * 1024 ** 2) {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.getStream(key, maxBytes)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  async uploadUrl(key: string, mimeType: string, sizeBytes: number, hash: string, expiresIn = 300) {
    if (!/^quarantine\/[a-f0-9-]{36}$/.test(key) || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 100 * 1024 ** 2) throw new FileValidationError('Invalid upload authorization');
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mimeType,
      ContentLength: sizeBytes, ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64') }),
    { expiresIn: Math.min(300, Math.max(1, expiresIn)), signableHeaders: new Set(['content-type', 'content-length']) });
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(60_000) }); }
  async downloadUrl(key: string, filename: string, expiresIn = 120) {
    safeFilename(filename);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key,
      ResponseContentType: 'application/octet-stream', ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }),
    { expiresIn: Math.min(300, Math.max(1, expiresIn)) });
  }
}

export function createObjectStore(env = process.env): S3ObjectStore {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) throw new Error('S3 bucket and credentials are required');
  return new S3ObjectStore(env.S3_BUCKET, { endpoint: env.S3_ENDPOINT, region: env.S3_REGION ?? 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY, forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true' });
}

export const createStorage = createObjectStore;
export async function ensureBucket(env = process.env): Promise<void> {
  if (env.NODE_ENV === 'production' || env.KIVRO_ENV === 'production') throw new Error('Production buckets must be provisioned explicitly');
  await createObjectStore(env).ensureBucket();
}

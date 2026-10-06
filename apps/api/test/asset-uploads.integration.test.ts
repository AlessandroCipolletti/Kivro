import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@kivro/database';
import { createObjectStore, sha256, type S3ObjectStore } from '@kivro/storage';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { expireAssetUploads } from '../src/asset-uploads.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('direct uploads with real S3 quarantine and immutable publication', () => {
  let app: FastifyInstance, db: PrismaClient, storage: S3ObjectStore;
  const users = [randomUUID(), randomUUID()], sessions = [randomUUID(), randomUUID()];
  const origin = 'http://localhost:3000';
  const headers = (index = 0) => ({ origin, cookie: `kivro_session=${sessions[index]}` });
  const body = Buffer.from('A private direct-upload integration fixture.\n');
  const create = (bytes = body, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/assets/uploads', headers: headers(),
    payload: { filename: 'private.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: sha256(bytes), ...extra } });
  const finish = (id: string, owner = 0) => app.inject({ method: 'POST', url: `/api/assets/uploads/${id}/finalize`, headers: headers(owner), payload: {} });
  const put = async (ticket: { uploadUrl: string; headers: Record<string, string> }, bytes = body) => {
    const response = await fetch(ticket.uploadUrl, { method: 'PUT', headers: ticket.headers, body: new Uint8Array(bytes), redirect: 'error' });
    expect(response.ok, `Storage PUT returned ${response.status}`).toBe(true);
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro') || process.env.S3_ENDPOINT !== 'http://127.0.0.1:59000') throw new Error('Requires local development storage and database');
    db = new PrismaClient(); storage = createObjectStore();
    await storage.configureBrowserOrigin(origin);
    for (const [index, id] of users.entries()) await db.user.create({ data: { id, name: 'Direct upload integration fixture', email: `${id}@uploads.kivro.local`, passwordHash: 'disabled-test-identity',
      sessions: { create: { tokenHash: hashSecret(sessions[index]!), expiresAt: new Date(Date.now() + 3600_000) } } } });
    app = await createApp({ db, storage, logger: false, mailer: null });
  });
  afterAll(async () => {
    await app?.close();
    if (db && storage) {
      const uploads = await db.assetUpload.findMany({ where: { ownerId: { in: users } } });
      const assets = await db.asset.findMany({ where: { ownerId: { in: users } } });
      for (const record of [...uploads, ...assets]) await storage.delete(record.objectKey);
      await db.assetUpload.deleteMany({ where: { ownerId: { in: users } } });
      await db.asset.deleteMany({ where: { ownerId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  });
  it('uploads directly, validates ownership, finalizes idempotently and keeps the published key immutable', async () => {
    const response = await create(); expect(response.statusCode, response.body).toBe(201);
    const ticket = response.json();
    expect(ticket.method).toBe('PUT'); expect(ticket.uploadUrl).toContain('quarantine');
    expect(await db.asset.count({ where: { ownerId: users[0] } })).toBe(0);
    await put(ticket);
    expect((await finish(ticket.id, 1)).statusCode).toBe(404);
    const result = await finish(ticket.id); expect(result.statusCode, result.body).toBe(200);
    const asset = result.json(); expect(asset).toMatchObject({ sizeBytes: body.length, sha256: sha256(body), filename: 'private.txt' });
    expect((await finish(ticket.id)).json()).toEqual(asset);
    const stored = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(stored.objectKey).not.toContain('quarantine');
    await put(ticket);
    expect(await storage.get(stored.objectKey)).toEqual(body);
    expect((await app.inject({ url: `/api/assets/${asset.id}/download`, headers: headers(1) })).statusCode).toBe(404);
    const download = await app.inject({ url: `/api/assets/${asset.id}/download`, headers: headers() });
    expect(download.statusCode).toBe(302);
    expect(Buffer.from(await (await fetch(download.headers.location!)).arrayBuffer())).toEqual(body);
  });
  it('refuses unverified hash, unauthorized filenames and oversized tickets', async () => {
    expect((await create(body, { filename: '../secret.txt' })).statusCode).toBe(400);
    expect((await create(body, { sizeBytes: 100 * 1024 ** 2 + 1 })).statusCode).toBe(400);
    const response = await create(body, { sha256: '0'.repeat(64) });
    const ticket = response.json();
    // Bypass presigned-client constraints as a malicious storage writer would;
    // finalize must verify actual bytes rather than trusting object metadata.
    const stored = await db.assetUpload.findUniqueOrThrow({ where: { id: ticket.id } });
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await storage.client.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: stored.objectKey, Body: body, ContentType: 'text/plain' }));
    const finalized = await finish(ticket.id);
    expect(finalized.statusCode).toBe(400); expect(finalized.json().error.code).toBe('UPLOAD_INTEGRITY_MISMATCH');
    expect((await db.assetUpload.findUniqueOrThrow({ where: { id: ticket.id } })).assetId).toBeNull();
  });
  it('rejects expiry and concurrent finalizers without publishing duplicate assets', async () => {
    const ticket = (await create()).json(); await put(ticket);
    const results = await Promise.all([finish(ticket.id), finish(ticket.id)]);
    expect(results.some(result => result.statusCode === 200)).toBe(true);
    for (const result of results) expect([200, 409]).toContain(result.statusCode);
    const finalized = (await finish(ticket.id)).json();
    expect(await db.asset.count({ where: { id: finalized.id } })).toBe(1);
    const expired = (await create()).json(); await put(expired);
    await db.assetUpload.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
    expect((await finish(expired.id)).statusCode).toBe(410);
    await expireAssetUploads(app.kivro);
    const row = await db.assetUpload.findUniqueOrThrow({ where: { id: expired.id } });
    expect(row.stagingDeletedAt).not.toBeNull();
    await expect(storage.get(row.objectKey)).rejects.toThrow();
  });
  it('enforces the actual read bound even when storage contains larger malicious bytes', async () => {
    const stored = await storage.put(Buffer.alloc(100, 65), 'bounded.txt', 'text/plain');
    try { await expect(storage.get(stored.key, 10)).rejects.toThrow('authorized size'); }
    finally { await storage.delete(stored.key); }
  });
  it('allows only the configured web origin in storage CORS', async () => {
    const ticket = (await create()).json();
    const preflight = await fetch(ticket.uploadUrl, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    const untrusted = await fetch(ticket.uploadUrl, { method: 'OPTIONS', headers: { Origin: 'https://attacker.invalid', 'Access-Control-Request-Method': 'PUT' } });
    expect(untrusted.headers.get('access-control-allow-origin')).not.toBe('https://attacker.invalid');
  });
  it('rechecks a lowered deployment upload limit before reading or publishing a pending object', async () => {
    const ticket = (await create()).json(); await put(ticket);
    const previous = app.kivro.config.maxUploadBytes;
    try {
      app.kivro.config.maxUploadBytes = body.length - 1;
      expect((await create()).statusCode).toBe(413);
      const result = await finish(ticket.id);
      expect(result.statusCode, result.body).toBe(413);
      expect((await db.assetUpload.findUniqueOrThrow({ where: { id: ticket.id } })).assetId).toBeNull();
    } finally { app.kivro.config.maxUploadBytes = previous; }
    expect((await finish(ticket.id)).statusCode).toBe(200);
  });
});

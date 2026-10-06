import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient, serializable, json } from '@kivro/database';
import { DEFAULT_SCHEDULE, WorkerWarningSnapshotSchema, executionManifestHash } from '@kivro/contracts';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { parseApiResponse, sellerWorkerResponseSchema, workerDiagnosticsResponseSchema, workerDiagnosticsV2ResponseSchema,
  workerHeartbeatResponseSchema, workerPairResponseSchema, pairingCodeResponseSchema } from '@kivro/contracts/responses';
import type { ApiContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { WorkerTransport } from '../../worker/src/transport.ts';
import { getWorkerWarnings, recordWorkerHealth, reconcileWorkerHealth } from '../src/worker-health.js';
import { SecurityPolicySchema } from '../src/security-policy.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('durable owner-scoped Worker warnings (isolated PostgreSQL)', () => {
  let db: PrismaClient, ctx: ApiContext, databaseUrl: string, app: FastifyInstance, pairedCount = 0;
  const schema = `worker_warnings_${randomBytes(8).toString('hex')}`;
  const origin = 'http://localhost:3000';
  beforeAll(async () => {
    process.loadEnvFile('.env'); const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development DB');
    url.searchParams.set('schema', schema); databaseUrl = url.toString();
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: databaseUrl } });
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    app = await createApp({ db, logger: false, mailer: null, background: false, env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'fake', WEB_ORIGIN: origin,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', PLATFORM_OPENAI_API_KEY: '', PLATFORM_ANTHROPIC_API_KEY: '', PLATFORM_INFERENCE_PROVIDER: '' } });
    ctx = app.kivro;
  });
  afterAll(async () => {
    vi.useRealTimers(); await app?.close();
    if (db) {
      if (!/^worker_warnings_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  async function fixture(ready = true) {
    const sellerId = randomUUID(), workerId = randomUUID();
    await db.user.create({ data: { id: sellerId, email: `${sellerId}@warnings.kivro.local`, name: 'Private fixture name', passwordHash: 'disabled' } });
    const worker = await db.workerDevice.create({ data: { id: workerId, sellerId, name: 'Private fixture device', publicKey: `private-${workerId}`, version: '0.1.0',
      openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: ready, lastSeenAt: new Date(), healthStatus: ready ? 'READY:HEARTBEAT_HEALTHY' : 'NOT_READY:RUNTIME_NOT_READY' } });
    const cap = await db.capability.create({ data: { sellerId, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Private fixture capability', summary: '', description: '', category: 'Writing', tags: [],
      priceTierId: 'USD_99', ioContract: {}, permissions: {}, dependencies: [], internalInstructions: 'private fixture instructions', manifestHash: 'a'.repeat(64), publishedAt: new Date() } });
    await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
    await db.workerBinding.create({ data: { workerId, capabilityVersionId: version.id, healthy: ready, validationStatus: 'PASSED', validatedManifestHash: version.manifestHash, validatedAt: new Date() } });
    const scope = { workerId, sellerId }, key = `worker-security-warnings:${workerId}`;
    return { worker, scope, key, cap, version, read: () => getWorkerWarnings(ctx, scope) };
  }
  it('hides foreign and missing devices before reading or creating warning snapshots', async () => {
    const f = await fixture(false), foreign = await fixture();
    await expect(getWorkerWarnings(ctx, { workerId: f.worker.id, sellerId: foreign.scope.sellerId })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(getWorkerWarnings(ctx, { workerId: randomUUID(), sellerId: f.scope.sellerId })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(await db.platformSetting.findUnique({ where: { key: f.key } })).toBeNull();
  });
  it('persists first detection across independent clients and deduplicates concurrent observation audits', async () => {
    const f = await fixture(false), first = await f.read();
    const otherDb = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const snapshots = await Promise.all(Array.from({ length: 5 }, (_, index) => getWorkerWarnings(index % 2 ? { ...ctx, db: otherDb } : ctx, f.scope)));
      for (const value of snapshots) {
        expect(value.items.map(item => [item.id, item.detectedAt])).toEqual(first.items.map(item => [item.id, item.detectedAt]));
        expect(WorkerWarningSnapshotSchema.safeParse(value).success).toBe(true);
      }
      expect(await db.auditEvent.count({ where: { workerId: f.worker.id, type: 'WORKER_WARNINGS_CHANGED' } })).toBe(1);
    } finally { await otherDb.$disconnect(); }
  });
  it('records a new episode only after authoritative recovery without clearing any security or financial fields', async () => {
    const f = await fixture(false); await f.read();
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { sandboxReady: true } });
    await db.workerBinding.update({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: f.version.id } }, data: { healthy: true } });
    expect((await f.read()).items).toEqual([]);
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { revokedAt: new Date(), paused: true } });
    const before = await db.workerDevice.findUniqueOrThrow({ where: { id: f.worker.id } });
    const repeated = await f.read(); await f.read();
    expect(repeated.items).toContainEqual(expect.objectContaining({ code: 'DEVICE_REVOKED', blocking: true }));
    expect(await db.workerDevice.findUniqueOrThrow({ where: { id: f.worker.id } })).toEqual(before);
    expect(await db.auditEvent.count({ where: { workerId: f.worker.id, type: 'WORKER_WARNINGS_CHANGED' } })).toBe(3);
    expect(await db.ledgerEntry.count()).toBe(0); expect(await db.workerCommand.count()).toBe(0);
  });
  it('observes changed capability validation even when the scalar health marker stays unchanged', async () => {
    const f = await fixture(); await f.read();
    await db.workerBinding.update({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: f.version.id } }, data: { validatedAt: new Date(0) } });
    await serializable(db, tx => recordWorkerHealth(tx, f.worker, SecurityPolicySchema.parse({}), 60000));
    const stored = await db.platformSetting.findUniqueOrThrow({ where: { key: f.key } });
    expect((stored.value as { snapshot: { items: unknown[] } }).snapshot.items).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_REVALIDATION_REQUIRED' }));
    expect(await db.auditEvent.count({ where: { workerId: f.worker.id, type: 'WORKER_HEALTH' } })).toBe(0);
  });
  it('rejects cached owner identity and regenerates fixed safe display text without leaking foreign bindings or diagnostics', async () => {
    const f = await fixture(false), foreign = await fixture();
    const first = await f.read(); first.items[0]!.description = 'private secret cached text';
    await db.platformSetting.update({ where: { key: f.key }, data: { value: json({ sellerId: foreign.scope.sellerId, workerId: f.worker.id, snapshot: first }) } });
    await db.workerBinding.create({ data: { workerId: f.worker.id, capabilityVersionId: foreign.version.id, healthy: false } });
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { health: { private: 'raw buyer input', warningSignals: [{ code: 'DEPENDENCY_UNAVAILABLE', capabilityVersionId: foreign.version.id }] } } });
    const value = await f.read();
    expect(value.coverage.ignoredSignalCount).toBe(1); expect(value.capabilityVersionsChecked).toBe(1);
    expect(JSON.stringify(value)).not.toMatch(/private secret|raw buyer input|Private fixture|private fixture instructions/);
    expect(JSON.stringify(value)).not.toContain(foreign.version.id);
    expect(await db.auditEvent.findMany({ where: { workerId: f.worker.id, type: 'WORKER_WARNINGS_CHANGED' } })).toEqual(expect.arrayContaining([expect.objectContaining({ sellerId: f.scope.sellerId })]));
  });
  it('retains fresh critical warnings while applying the existing 90-day history retention', async () => {
    const f = await fixture(false);
    const old = await db.auditEvent.create({ data: { sellerId: f.scope.sellerId, workerId: f.worker.id, type: 'WORKER_WARNINGS_CHANGED', createdAt: new Date(Date.now() - 91 * 86400_000), metadata: {} } });
    await reconcileWorkerHealth(ctx);
    expect(await db.auditEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.platformSetting.findUnique({ where: { key: f.key } })).not.toBeNull();
    const before = await db.workerDevice.findUniqueOrThrow({ where: { id: f.worker.id } }); await f.read();
    expect(await db.workerDevice.findUniqueOrThrow({ where: { id: f.worker.id } })).toEqual(before);
    expect((await f.read()).items.some(item => item.code === 'SANDBOX_NOT_READY')).toBe(true);
  });

  describe('signed API path with synthetic runtime reports (no Docker)', () => {
    type WireResponse = { statusCode: number; body: string; json(): unknown };
    function wire<S extends z.ZodTypeAny>(schema: S, response: WireResponse): z.infer<S> {
      expect(response.statusCode, response.body).toBe(200);
      const value = response.json(); expect(schema.parse(value)).toEqual(value); return schema.parse(value);
    }
    async function pairedFixture() {
      const sellerId = randomUUID(), token = randomUUID(), keys = generateKeyPairSync('ed25519');
      await db.user.create({ data: { id: sellerId, email: `${sellerId}@signed-warnings.kivro.local`, name: 'Signed warning fixture', passwordHash: 'disabled',
        emailVerifiedAt: new Date(), sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600_000) } } } });
      const headers = { origin, cookie: `kivro_session=${token}` };
      const pairing = wire(pairingCodeResponseSchema, await app.inject({ method: 'POST', url: '/api/seller/pairing-code', headers, payload: {} }));
      const { workerId, serverPublicKey } = wire(workerPairResponseSchema, await app.inject({ method: 'POST', url: '/api/worker/pair', remoteAddress: `127.0.1.${++pairedCount}`,
        payload: { code: pairing.code, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Signed warning fixture', version: '0.1.0' } }));
      const request = (method: 'GET' | 'POST', url: string, body?: unknown) => {
        const timestamp = String(Date.now()), nonce = randomUUID(), raw = body === undefined ? '' : JSON.stringify(body);
        return { method, url, ...(body === undefined ? {} : { payload: raw }), headers: { 'content-type': 'application/json', 'x-worker-id': workerId,
          'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce,
          'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, url, timestamp, nonce, Buffer.from(raw))), keys.privateKey).toString('base64') } };
      };
      const signed = (method: 'GET' | 'POST', url: string, body?: unknown) => app.inject(request(method, url, body));
      const health = (overrides: Record<string, unknown> = {}) => ({ version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)',
        sandboxReady: false, paused: false, capabilities: [], runningJobIds: [], health: { ready: false },
        warningSignals: [{ code: 'SANDBOX_SELF_TEST_FAILED' }], ...overrides });
      const heartbeat = async (overrides: Record<string, unknown> = {}) => wire(workerHeartbeatResponseSchema, await signed('POST', '/api/worker/heartbeat', health(overrides)));
      const diagnostics = async () => {
        const response = await signed('GET', '/api/worker/diagnostics/v2');
        const result = wire(workerDiagnosticsV2ResponseSchema, response);
        expect(parseApiResponse('GET', '/api/worker/diagnostics/v2', response.statusCode, response.json())).toEqual(result);
        expect(result.securityWarnings).toBeDefined(); return result;
      };
      const sellerList = async () => {
        const response = await app.inject({ url: '/api/seller/workers', headers });
        const result = wire(z.array(sellerWorkerResponseSchema), response);
        expect(parseApiResponse('GET', '/api/seller/workers', response.statusCode, response.json())).toEqual(result);
        expect(result).toHaveLength(1); expect(result[0]!.id).toBe(workerId);
        expect(result[0]!.securityWarnings).toBeDefined(); return result[0]!;
      };
      return { workerId, sellerId, headers, signed, request, health, heartbeat, diagnostics, sellerList, serverPublicKey,
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    }
    async function capability(sellerId: string) {
      const cap = await db.capability.create({ data: { sellerId, slug: randomUUID(), schedule: DEFAULT_SCHEDULE } });
      const manifest = { ioContract: { schemaVersion: 1, inputs: [], output: { type: 'TEXT', description: 'Result', required: true } },
        permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
          limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
        dependencies: [{ id: 'inference', name: 'Dedicated inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true,
          confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'] } }], internalInstructions: 'Synthetic warning route fixture, not runtime proof' };
      return db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Signed warning fixture', summary: '', description: '', category: 'Writing & documents',
        tags: [], priceTierId: 'USD_99', ioContract: json(manifest.ioContract), permissions: json(manifest.permissions), dependencies: json(manifest.dependencies),
        internalInstructions: manifest.internalInstructions, manifestHash: executionManifestHash(manifest) } });
    }

    it('projects a signed heartbeat warning to actual strict v2 diagnostics and the owning seller list', async () => {
      const f = await pairedFixture(); await f.heartbeat();
      const diagnostics = await f.diagnostics(), seller = await f.sellerList();
      expect(diagnostics).toMatchObject({ workerId: f.workerId, sellerId: f.sellerId });
      const warning = diagnostics.securityWarnings!.items.find(item => item.code === 'SANDBOX_SELF_TEST_FAILED');
      expect(warning).toMatchObject({ source: 'WORKER_REPORT', severity: 'CRITICAL', blocking: true,
        affectedEntity: { workerId: f.workerId, capabilityId: null, capabilityVersionId: null }, detectedAtBasis: 'FIRST_PLATFORM_OBSERVATION' });
      expect(seller.securityWarnings!.items).toEqual(diagnostics.securityWarnings!.items.map(item => ({ ...item, lastObservedAt: seller.securityWarnings!.observedAt })));
      expect(seller.sandboxReady).toBe(false); expect(seller.healthStatus).toBe('NOT_READY:RUNTIME_NOT_READY');
      expect(seller.health).not.toHaveProperty('warningSignals');
      const legacy = await f.signed('GET', '/api/worker/diagnostics'); wire(workerDiagnosticsResponseSchema, legacy);
      expect(legacy.json()).not.toHaveProperty('securityWarnings');
      expect(workerDiagnosticsV2ResponseSchema.safeParse({ ...diagnostics, securityWarnings: { ...diagnostics.securityWarnings, rawPath: '/private/fixture' } }).success).toBe(false);
    });
    it('preserves first detection across signed updates and refuses replay or forged authentication without mutation', async () => {
      const f = await pairedFixture(), request = f.request('POST', '/api/worker/heartbeat', f.health());
      wire(workerHeartbeatResponseSchema, await app.inject(request));
      const first = (await f.diagnostics()).securityWarnings!, before = await db.workerDevice.findUniqueOrThrow({ where: { id: f.workerId } });
      const replay = await app.inject(request); expect(replay.statusCode).toBe(409); expect(replay.json().error.code).toBe('WORKER_REPLAY');
      const forged = f.request('POST', '/api/worker/heartbeat', f.health({ sandboxReady: true, health: { ready: true }, warningSignals: [] }));
      forged.headers['x-worker-signature'] = Buffer.alloc(64).toString('base64');
      const rejected = await app.inject(forged); expect(rejected.statusCode).toBe(401);
      expect(await db.workerDevice.findUniqueOrThrow({ where: { id: f.workerId } })).toEqual(before);
      await f.heartbeat();
      const second = (await f.sellerList()).securityWarnings!;
      expect(second.items.map(item => [item.id, item.detectedAt])).toEqual(first.items.map(item => [item.id, item.detectedAt]));
      expect(await db.auditEvent.count({ where: { workerId: f.workerId, type: 'WORKER_WARNINGS_CHANGED' } })).toBe(1);
    });
    it('clears reported warnings only after a fresh signed healthy report and distinguishes an older client without signals', async () => {
      const f = await pairedFixture(); await f.heartbeat(); expect((await f.diagnostics()).securityWarnings!.items.length).toBeGreaterThan(0);
      await f.heartbeat({ sandboxReady: true, health: { ready: true }, warningSignals: [] });
      const healthy = await f.sellerList(); expect(healthy.sandboxReady).toBe(true);
      expect(healthy.securityWarnings).toMatchObject({ items: [], coverage: { localSignals: 'REPORTED' } });
      const legacyHeartbeat = f.health({ sandboxReady: true, health: { ready: true, warningSignals: true } });
      delete (legacyHeartbeat as Record<string, unknown>).warningSignals;
      wire(workerHeartbeatResponseSchema, await f.signed('POST', '/api/worker/heartbeat', legacyHeartbeat));
      expect((await f.diagnostics()).securityWarnings).toMatchObject({ items: [], coverage: { localSignals: 'UNAVAILABLE' } });
      expect((await f.sellerList()).health).not.toHaveProperty('warningSignals');
    });
    it('marks expired heartbeat reports stale using the API clock, then recovers through a new signed heartbeat', async () => {
      const f = await pairedFixture(); await f.heartbeat();
      const lastSeen = (await db.workerDevice.findUniqueOrThrow({ where: { id: f.workerId } })).lastSeenAt!;
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(lastSeen.getTime() + ctx.config.heartbeatTtlMs + 1);
      try {
        const stale = (await f.diagnostics()).securityWarnings!;
        expect(stale.coverage.localSignals).toBe('STALE');
        expect(stale.items).toContainEqual(expect.objectContaining({ code: 'HEARTBEAT_EXPIRED', blocking: true, source: 'PLATFORM_STATE' }));
        expect(stale.items.some(item => item.source === 'WORKER_REPORT')).toBe(false);
        expect((await f.sellerList()).securityWarnings!.coverage.localSignals).toBe('STALE');
        await f.heartbeat({ sandboxReady: true, health: { ready: true }, warningSignals: [] });
        expect((await f.diagnostics()).securityWarnings).toMatchObject({ items: [], coverage: { localSignals: 'REPORTED' } });
      } finally { vi.useRealTimers(); }
    });
    it('drops raw diagnostic paths and rejects caller-supplied warning text or authority fields', async () => {
      const f = await pairedFixture(), canary = '/Users/synthetic/private/credential-canary';
      await f.heartbeat({ health: { ready: false, rawPath: canary, nested: { credential: canary }, warningSignals: [{ code: 'NETWORK_POLICY_VIOLATION', description: canary }] } });
      expect(JSON.stringify(await f.diagnostics())).not.toContain(canary);
      expect(JSON.stringify(await f.sellerList())).not.toContain(canary);
      for (const extra of [{ description: canary }, { blocking: false }, { severity: 'INFO' }, { detectedAt: new Date(0).toISOString() }]) {
        const response = await f.signed('POST', '/api/worker/heartbeat', f.health({ warningSignals: [{ code: 'SANDBOX_SELF_TEST_FAILED', ...extra }] }));
        expect(response.statusCode, response.body).toBe(400); expect(response.body).not.toContain(canary);
      }
      const stored = await db.platformSetting.findUniqueOrThrow({ where: { key: `worker-security-warnings:${f.workerId}` } });
      expect(JSON.stringify(stored.value)).not.toContain(canary);
      expect(JSON.stringify(await db.auditEvent.findMany({ where: { workerId: f.workerId } }))).not.toContain(canary);
    });
    it('does not expose another seller device or foreign capability signals through either response object', async () => {
      const own = await pairedFixture(), foreign = await pairedFixture(), version = await capability(foreign.sellerId);
      await foreign.heartbeat();
      await own.heartbeat({ capabilities: [version.id], warningSignals: [{ code: 'DEPENDENCY_UNAVAILABLE', capabilityVersionId: version.id }] });
      const diagnostics = await own.diagnostics(), seller = await own.sellerList();
      expect(diagnostics.securityWarnings!.coverage.ignoredSignalCount).toBe(1);
      expect(seller.bindings).toEqual([]);
      for (const value of [diagnostics, seller]) {
        expect(JSON.stringify(value)).not.toContain(foreign.workerId); expect(JSON.stringify(value)).not.toContain(version.id);
      }
      const requested = await app.inject({ url: `/api/seller/workers?workerId=${foreign.workerId}&sellerId=${foreign.sellerId}`, headers: own.headers });
      expect(wire(z.array(sellerWorkerResponseSchema), requested).map(item => item.id)).toEqual([own.workerId]);
      const wrongIdentity = own.request('GET', '/api/worker/diagnostics/v2'); wrongIdentity.headers['x-worker-id'] = foreign.workerId;
      const denied = await app.inject(wrongIdentity); expect(denied.statusCode).toBe(401); expect(denied.body).not.toContain(foreign.workerId);
      expect((await app.inject('/api/seller/workers')).statusCode).toBe(401);
      const apiKey = randomUUID(); await db.apiKey.create({ data: { userId: own.sellerId, name: 'Denied fixture key', prefix: 'warn', secretHash: hashSecret(apiKey), scopes: ['jobs:read'] } });
      expect((await app.inject({ url: '/api/seller/workers', headers: { authorization: `Bearer ${apiKey}` } })).statusCode).toBe(403);
    });
    it('observes capability changes in the heartbeat transaction and clears validation warnings through the signed validation route', async () => {
      const f = await pairedFixture(), version = await capability(f.sellerId);
      const ready = { sandboxReady: true, health: { ready: true }, capabilities: [version.id], warningSignals: [] };
      await f.heartbeat(ready);
      const stored = await db.platformSetting.findUniqueOrThrow({ where: { key: `worker-security-warnings:${f.workerId}` } });
      const initial = WorkerWarningSnapshotSchema.parse((stored.value as { snapshot: unknown }).snapshot);
      expect(initial.items).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_REVALIDATION_REQUIRED', affectedEntity: { workerId: f.workerId, capabilityId: version.capabilityId, capabilityVersionId: version.id } }));
      expect(initial.items).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_NOT_READY' }));
      const validated = await f.signed('POST', `/api/worker/capabilities/${version.id}/validation`, { manifestHash: version.manifestHash, passed: true,
        proof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() },
          inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } });
      expect(validated.statusCode, validated.body).toBe(200);
      await f.heartbeat(ready); expect((await f.diagnostics()).securityWarnings!.items).toEqual([]);
      await f.heartbeat({ ...ready, capabilities: [] });
      const unavailable = await db.platformSetting.findUniqueOrThrow({ where: { key: `worker-security-warnings:${f.workerId}` } });
      expect(WorkerWarningSnapshotSchema.parse((unavailable.value as { snapshot: unknown }).snapshot).items).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_NOT_READY' }));
      expect((await f.sellerList()).bindings).toEqual([{ capabilityVersionId: version.id, healthy: false }]);
    });
    it('keeps device revocation authoritative and visible even if a signed client later claims healthy', async () => {
      const f = await pairedFixture(), foreign = await pairedFixture();
      await f.heartbeat({ sandboxReady: true, health: { ready: true }, warningSignals: [] });
      const rejected = await app.inject({ method: 'POST', url: `/api/seller/workers/${f.workerId}/revoke`, headers: foreign.headers, payload: {} });
      expect(rejected.statusCode).toBe(404);
      const revoked = await app.inject({ method: 'POST', url: `/api/seller/workers/${f.workerId}/revoke`, headers: f.headers, payload: {} });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const before = await db.workerDevice.findUniqueOrThrow({ where: { id: f.workerId } });
      expect((await f.signed('POST', '/api/worker/heartbeat', f.health({ sandboxReady: true, health: { ready: true }, warningSignals: [] }))).statusCode).toBe(401);
      expect((await f.signed('GET', '/api/worker/diagnostics/v2')).statusCode).toBe(401);
      const current = await f.sellerList(); expect(current.securityWarnings!.items).toContainEqual(expect.objectContaining({ code: 'DEVICE_REVOKED', blocking: true }));
      expect(await db.workerDevice.findUniqueOrThrow({ where: { id: f.workerId } })).toEqual(before);
      expect(await db.ledgerEntry.count()).toBe(0);
    });
    it('accepts real WorkerTransport heartbeat and strict diagnostics over loopback HTTP with the actual API and PostgreSQL', async () => {
      const f = await pairedFixture(), apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const transport = new WorkerTransport(apiUrl, { workerId: f.workerId, publicKey: f.publicKey, serverPublicKey: f.serverPublicKey, apiUrl }, f.privateKey, true);
      const nonceCount = await db.workerNonce.count({ where: { workerId: f.workerId } });
      await transport.heartbeat(f.health());
      const current = await transport.diagnostics();
      expect(current).toMatchObject({ workerId: f.workerId, sellerId: f.sellerId, deploymentEnvironment: ctx.config.deploymentEnvironment });
      expect(current.deploymentEnvironment).not.toBe('unknown');
      expect(current.securityWarnings?.items).toContainEqual(expect.objectContaining({ code: 'SANDBOX_SELF_TEST_FAILED', source: 'WORKER_REPORT', blocking: true }));
      const response = await fetch(new URL('/api/seller/workers', apiUrl), { headers: f.headers });
      expect(response.status).toBe(200);
      const seller = z.array(sellerWorkerResponseSchema).parse(await response.json())[0]!;
      expect(seller.id).toBe(f.workerId);
      expect(seller.securityWarnings!.items.map(item => [item.id, item.detectedAt])).toEqual(current.securityWarnings!.items.map(item => [item.id, item.detectedAt]));
      await transport.heartbeat(f.health({ sandboxReady: true, health: { ready: true }, warningSignals: [] }));
      expect((await transport.diagnostics()).securityWarnings).toMatchObject({ items: [], coverage: { localSignals: 'REPORTED' } });
      expect(await db.workerNonce.count({ where: { workerId: f.workerId } })).toBe(nonceCount + 4);
    });
  });
});

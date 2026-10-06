import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JobOfferSchema, JobNoticeSchema, SignedJobOfferSchema, hashManifest } from './index.ts';
import { workerResponseRoutes, workerDiagnosticsResponseSchema, workerDiagnosticsV2ResponseSchema,
  workerHeartbeatResponseSchema, sellerWorkerResponseSchema, workerOffersResponseSchema } from './response-worker.ts';
import { WorkerCommandSchema } from './worker-command.ts';

const id = 'a1000000-0000-4000-a000-000000000001', at = '2026-10-06T12:00:00.000Z';
const diagnostics = { serverTime: at, workerId: id, minimumWorkerVersion: '0.1.0', minimumOpenClawVersion: '2026.8.2',
  revokedWorkerVersions: [], revokedOpenClawVersions: [], policyReason: null };
const warnings = { schemaVersion: 1, observedAt: at, items: [], capabilityVersionsChecked: 0, truncated: false,
  coverage: { capabilityScope: 'BOUND_VERSIONS_ONLY', localSignals: 'UNAVAILABLE', ignoredSignalCount: 0, deviceRevocationSchedule: 'UNAVAILABLE' } };
const sellerWorker = { id, name: 'Worker', version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)',
  sandboxReady: true, paused: false, localPaused: false, revokedAt: null, lastSeenAt: at, health: { ready: true },
  healthStatus: 'READY:HEARTBEAT_HEALTHY', runningJobIds: [id], createdAt: at,
  bindings: [{ capabilityVersionId: id, healthy: true }], minimumWorkerVersion: '0.1.0', minimumOpenClawVersion: '2026.8.2',
  latestSupportedWorkerVersion: '0.1.0', latestSupportedOpenClawVersion: '2026.8.2', policyReason: null,
  healthHistory: [{ id, createdAt: at, metadata: { previous: 'UNKNOWN', status: 'READY', reason: 'HEARTBEAT_HEALTHY', version: '0.1.0', openclawVersion: '2026.8.2' } }] };

describe('browser-safe Worker response contracts', () => {
  it('describes all fifteen worker and worker-usage JSON routes without duplicates or upload ownership', () => {
    expect(workerResponseRoutes.map(route => `${route.method} ${route.path}`).sort()).toEqual([
      'POST /api/seller/pairing-code', 'POST /api/worker/pair', 'POST /api/worker/heartbeat',
      'GET /api/worker/diagnostics', 'GET /api/worker/diagnostics/v2', 'GET /api/worker/offers', 'GET /api/worker/jobs/:id/payload',
      'GET /api/seller/workers', 'POST /api/worker/capabilities/:versionId/validation', 'POST /api/worker/jobs/:id/events',
      'POST /api/worker/jobs/:id/result', 'POST /api/worker/jobs/:id/usage',
      'POST /api/seller/workers/:id/pause', 'POST /api/seller/workers/:id/resume', 'POST /api/seller/workers/:id/revoke',
    ].sort());
  });

  it('uses strict acknowledgement responses for every mutation that returns ok', () => {
    const paths = ['/validation', '/events', '/result', '/usage', '/pause', '/resume', '/revoke'];
    const routes = workerResponseRoutes.filter(route => paths.some(path => route.path.endsWith(path)));
    expect(routes).toHaveLength(7);
    for (const { schema } of routes) {
      expect(schema.parse({ ok: true })).toEqual({ ok: true });
      for (const value of [{}, { ok: false }, { ok: true, privateKey: 'must-not-be-stripped' }]) expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it('validates pairing code expiry and the explicit public pairing fields', () => {
    const code = workerResponseRoutes.find(route => route.path === '/api/seller/pairing-code')!.schema;
    const pair = workerResponseRoutes.find(route => route.path === '/api/worker/pair')!.schema;
    expect(code.parse({ code: 'A'.repeat(24), expiresAt: at })).toEqual({ code: 'A'.repeat(24), expiresAt: at });
    for (const expiresAt of [new Date(at), 'not-a-date', 1]) expect(code.safeParse({ code: 'A'.repeat(24), expiresAt }).success).toBe(false);
    expect(code.safeParse({ code: 'not-a-code', expiresAt: at }).success).toBe(false);
    expect(pair.parse({ workerId: id, serverPublicKey: 'public-pem' })).toEqual({ workerId: id, serverPublicKey: 'public-pem' });
    expect(pair.safeParse({ workerId: id, serverPublicKey: 'public-pem', publicKey: 'unprojected' }).success).toBe(false);
    expect(pair.safeParse({ workerId: 'not-a-uuid', serverPublicKey: '' }).success).toBe(false);
  });

  it('retains the protocol command refinement and its bounded heartbeat list', () => {
    for (const type of ['PAUSE_ALL', 'RESUME_ALL', 'PAUSE_JOB', 'RESUME_JOB', 'CANCEL_JOB']) {
      const command = { id, type, ...(type.endsWith('_JOB') ? { jobId: id } : {}) };
      expect(WorkerCommandSchema.parse(command)).toEqual(command);
    }
    const command = { id, jobId: id, type: 'RESUME_JOB', resumeWhilePaused: true };
    expect(workerHeartbeatResponseSchema.parse({ commands: [command] })).toEqual({ commands: [command] });
    for (const invalid of [{ ...command, type: 'PAUSE_JOB' }, { ...command, jobId: undefined }, { ...command, privateKey: 'secret' }]) {
      expect(workerHeartbeatResponseSchema.safeParse({ commands: [invalid] }).success).toBe(false);
    }
    expect(workerHeartbeatResponseSchema.safeParse({ commands: Array.from({ length: 101 }, () => command) }).success).toBe(false);
  });

  it('keeps legacy diagnostics exact while v2 requires seller and deployment identity', () => {
    expect(workerDiagnosticsResponseSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(workerDiagnosticsResponseSchema.safeParse({ ...diagnostics, sellerId: id }).success).toBe(false);
    expect(workerDiagnosticsResponseSchema.safeParse({ ...diagnostics, securityWarnings: warnings }).success).toBe(false);
    expect(workerDiagnosticsV2ResponseSchema.safeParse(diagnostics).success).toBe(false);
    const v2 = { ...diagnostics, sellerId: id, deploymentEnvironment: 'development' };
    expect(workerDiagnosticsV2ResponseSchema.parse(v2)).toEqual(v2);
    expect(workerDiagnosticsV2ResponseSchema.parse({ ...v2, securityWarnings: warnings })).toEqual({ ...v2, securityWarnings: warnings });
    expect(workerDiagnosticsV2ResponseSchema.safeParse({ ...v2, deploymentEnvironment: 'arbitrary' }).success).toBe(false);
    expect(workerDiagnosticsV2ResponseSchema.safeParse({ ...v2, securityWarnings: { ...warnings, credentials: {} } }).success).toBe(false);
    expect(workerDiagnosticsResponseSchema.safeParse({ ...diagnostics, policyReason: 'private-string' }).success).toBe(false);
  });

  it('requires the complete seller projection and ISO dates without accepting device secrets', () => {
    expect(sellerWorkerResponseSchema.parse(sellerWorker)).toEqual(sellerWorker);
    expect(sellerWorkerResponseSchema.parse({ ...sellerWorker, securityWarnings: warnings })).toEqual({ ...sellerWorker, securityWarnings: warnings });
    expect(sellerWorkerResponseSchema.safeParse({ id, name: 'partial web type' }).success).toBe(false);
    for (const extra of [{ sellerId: id }, { publicKey: 'private-record-field' }, { validationProof: {} }]) {
      expect(sellerWorkerResponseSchema.safeParse({ ...sellerWorker, ...extra }).success).toBe(false);
    }
    for (const key of ['createdAt', 'lastSeenAt', 'revokedAt']) expect(sellerWorkerResponseSchema.safeParse({ ...sellerWorker, [key]: new Date(at) }).success).toBe(false);
    expect(sellerWorkerResponseSchema.safeParse({ ...sellerWorker, bindings: [{ ...sellerWorker.bindings[0], validationProof: {} }] }).success).toBe(false);
    expect(sellerWorkerResponseSchema.safeParse({ ...sellerWorker, health: { invalid: Infinity } }).success).toBe(false);
    expect(sellerWorkerResponseSchema.safeParse({ ...sellerWorker, healthHistory: [{ ...sellerWorker.healthHistory[0], createdAt: 'invalid' }] }).success).toBe(false);
    expect(sellerWorkerResponseSchema.safeParse({ ...sellerWorker, healthHistory: [{ ...sellerWorker.healthHistory[0], metadata: { ...sellerWorker.healthHistory[0]!.metadata, input: 'private' } }] }).success).toBe(false);
  });

  it('reuses the signed schemas, preserving signed payloads and rejecting pre-acceptance buyer content', () => {
    const payload = JobOfferSchema.parse({ protocolVersion: 1, jobId: id, attemptId: id, workerId: id, sellerId: id, maxPauseMs: 900000,
      capabilityVersionId: id, expiresAt: at, paymentSecured: true, nonce: id, manifestHash: 'a'.repeat(64), input: { text: 'Private' },
      ioContract: { schemaVersion: 1, inputs: [], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
        limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [], internalInstructions: 'Private instructions', assets: [] });
    const notice = JobNoticeSchema.parse({ ...Object.fromEntries(Object.entries(payload).filter(([key]) => !['input', 'assets', 'internalInstructions'].includes(key))), payloadHash: hashManifest(payload) });
    const signed = { payload: notice, signature: 'signed-notice' };
    expect(workerOffersResponseSchema.parse({ offers: [signed] })).toEqual({ offers: [signed] });
    for (const extra of [{ input: payload.input }, { assets: [] }, { internalInstructions: 'private' }]) {
      expect(workerOffersResponseSchema.safeParse({ offers: [{ ...signed, payload: { ...notice, ...extra } }] }).success).toBe(false);
    }
    const full = workerResponseRoutes.find(route => route.path === '/api/worker/jobs/:id/payload')!.schema;
    expect(full).toBe(SignedJobOfferSchema);
    expect(full.parse({ payload, signature: 'signed-payload' })).toEqual({ payload, signature: 'signed-payload' });
  });

  it('bundles the entire response entrypoint for browsers without Node or server packages', async () => {
    const require = createRequire(import.meta.url);
    const bundler = createRequire(require.resolve('tsx'))('esbuild') as {
      build(options: object): Promise<{ metafile: { inputs: Record<string, unknown>; outputs: Record<string, { imports: { path: string }[] }> } }>;
    };
    const built = await bundler.build({ entryPoints: [fileURLToPath(new URL('./response-worker.ts', import.meta.url))],
      platform: 'browser', format: 'esm', bundle: true, write: false, metafile: true, logLevel: 'silent' });
    expect(Object.keys(built.metafile.inputs).some(path => /(?:job-protocol|database|billing|storage|apps\/api|apps\/worker)\//.test(path))).toBe(false);
    expect(Object.values(built.metafile.outputs).flatMap(output => output.imports)).toEqual([]);
  });
});

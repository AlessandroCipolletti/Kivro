import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executionManifestHash, hashManifest, type JobOffer } from '@kivro/contracts';
import { generateDeviceIdentity, sha256, signMessage, stableStringify } from '@kivro/crypto';
import { signOffer } from '@kivro/job-protocol';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { WorkerRuntime } from './runtime.ts';
import { SecretStore } from './secrets.ts';
import { approveCapability, LocalCapabilitySchema } from './capabilities.ts';
import { validateInferenceConfig } from './inference.ts';
import * as diagnostics from './readiness.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

// Actual Worker timers/SQLite, Docker freeze and pinned OpenClaw. Only cloud
// delivery/readiness and the HTTP inference provider are fixture substitutes.
describe.skipIf(process.env.KIVRO_PAUSE_INTEGRATION !== '1')('real pinned-runtime pause accounting', () => {
  it.each(['resume', 'expire', 'cancel'] as const)('enforces a lower signed cumulative budget in actual OpenClaw: %s', async mode => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-pause-proof-'))), state = new WorkerState(root);
    cleanup.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
    const secrets = new SecretStore(state), runtime = new WorkerRuntime(state, secrets, process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2-pause', true);
    cleanup.push(async () => { for (const active of runtime.active.values()) active.abort.abort(); await Promise.allSettled([...runtime.active.values()].map(active => active.task)); });
    const imageId = await runtime.docker.imageId(runtime.image), offer = fixtureOffer(), marker = `long-pause-${randomUUID()}`;
    offer.permissions.limits.timeoutSeconds = 30; offer.permissions.limits.maxTokens = 128000;
    offer.maxPauseMs = mode === 'resume' ? 90000 : 2000;
    offer.permissions.tools = ['write'];
    offer.dependencies.push({ id: 'write-tool', name: 'Reviewed write', type: 'TOOL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { tools: ['write'] } });
    offer.ioContract.output = { type: 'MIXED', required: true, description: 'Pause proof', files: { allowedExtensions: ['.txt'], allowedMimeTypes: ['text/plain'], maxFiles: 1, maxTotalSizeBytes: 10000 } };
    offer.manifestHash = executionManifestHash(offer);
    const entered = deferred(), reply = deferred(); let calls = 0;
    const provider = createServer(async (request, response) => {
      try {
        expect(request.url).toBe('/v1/chat/completions'); expect(request.headers.authorization).toBe('Bearer pause-fixture-credential');
        const parts: Buffer[] = []; for await (const part of request) parts.push(part);
        const body = JSON.parse(Buffer.concat(parts).toString()); expect(body.store).toBe(false); expect(body.stream).toBe(false);
        const call = ++calls; expect(call).toBeLessThanOrEqual(2);
        if (call === 1) { entered.resolve(); await reply.promise; }
        else expect(JSON.stringify(body.messages)).toContain('Successfully wrote');
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `pause-${call}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'test-model',
          choices: [{ index: 0, message: call === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'write_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'result/proof.txt', content: marker }) } }] } : { role: 'assistant', content: marker }, finish_reason: call === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      } catch { response.writeHead(400).end(); }
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => { reply.resolve(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_PORT');
    const config = validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference', baseUrl: `http://127.0.0.1:${address.port}/v1`, allowLocal: true, maxTokensPerJob: 128000, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
    const keys = generateDeviceIdentity();
    state.set('identity', { workerId: offer.workerId, publicKey: keys.publicKey, serverPublicKey: keys.publicKey, apiUrl: 'http://127.0.0.1:4000' });
    state.set('approvedImageId', imageId); state.set('inference', config); state.resume('LOCAL');
    const manifest = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, permissions: offer.permissions, ioContract: offer.ioContract, dependencies: offer.dependencies, internalInstructions: offer.internalInstructions });
    approveCapability(state, manifest, hashManifest(manifest));
    state.set(`capabilityProof:${offer.capabilityVersionId}`, { manifestHash: offer.manifestHash, imageId, inferenceHash: hashManifest(config), testedAt: Date.now() });
    state.set(`capabilityHealth:${offer.capabilityVersionId}`, { ready: true, checkedAt: Date.now() });
    vi.spyOn(secrets, 'get').mockResolvedValue('pause-fixture-credential');
    const report = { ready: true, imageId, sandboxReady: true, openclawVersion: 'OpenClaw 2026.8.2 (0965053)', checks: [], checkedAt: new Date().toISOString() };
    vi.spyOn(diagnostics, 'readiness').mockResolvedValue(report);
    const delivered: unknown[] = [], events: string[] = [];
    Object.assign(runtime, { report, transport: {
      acceptedPayload: async () => signOffer(offer, keys.privateKey),
      request: async (_method: string, path: string, body: { type?: string }) => { if (body.type) events.push(body.type); if (path.endsWith('/result')) delivered.push(body); return {}; },
      uploadFile: async (_jobId: string, _attemptId: string, file: Omit<JobOffer['assets'][number], 'id'>, path: string) => { const bytes = await readFile(path); expect(bytes.toString()).toBe(marker); expect(sha256(bytes)).toBe(file.sha256); return { id: randomUUID(), filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 }; },
    } });
    const { input: _input, assets: _assets, internalInstructions: _instructions, ...metadata } = offer;
    const notice = { ...metadata, payloadHash: hashManifest(offer) };
    expect(await runtime.accept({ payload: notice, signature: signMessage(stableStringify(notice), keys.privateKey) })).toBe(true);
    const active = runtime.active.get(offer.jobId)!;
    await Promise.race([entered.promise, active.task.then(() => { throw new Error(`BEFORE_PAUSE_${state.attempt(offer.jobId)?.state}`); })]);
    const command = (type: 'PAUSE_JOB' | 'RESUME_JOB' | 'CANCEL_JOB') => runtime.controlJob({ id: randomUUID(), jobId: offer.jobId, type });
    const pause = command('PAUSE_JOB');
    try {
      await vi.waitFor(async () => { const info = JSON.parse(await runtime.docker.call(['inspect', active.spec.name]))[0]; expect(info.State.Paused).toBe(true); }, { timeout: 5000, interval: 100 });
    } finally { reply.resolve(); }
    await pause;
    const before = state.attempt(offer.jobId)!; expect(before.state).toBe('PAUSED'); expect(before.pausedAt).not.toBeNull();
    const activeUsedMs = before.pausedAt! - before.createdAt;
    expect(activeUsedMs).toBeLessThan(25000);
    expect(before.maxPauseMs).toBe(offer.maxPauseMs);
    if (mode !== 'resume') {
      if (mode === 'cancel') await command('CANCEL_JOB');
      await active.task; await runtime.flush(); await runtime.flush();
      const terminal = mode === 'expire' ? 'TIMED_OUT' : 'CANCELLED';
      expect(state.attempt(offer.jobId)?.state).toBe(terminal); expect(delivered).toHaveLength(0); expect(calls).toBe(1);
      expect(events.filter(event => event === terminal)).toHaveLength(1); expect(events).not.toContain('RESUMING');
      expect(await runtime.docker.owned(active.spec)).toBe(false);
      process.stdout.write(JSON.stringify({ phase: `real-paused-${mode}`, imageId, jobId: offer.jobId, maxPauseMs: offer.maxPauseMs, wallAfterPauseMs: Date.now() - before.pausedAt!, calls, delivered: 0, terminal, cloudAndSettlement: 'NOT_EXERCISED', removed: true }) + '\n');
      return;
    }
    // Timers can wake before the equivalent wall-clock duration. Poll the same
    // persisted pause origin as production accounting; keep a modest jitter margin.
    const pausedUntil = before.pausedAt! + 75250, waitDeadline = performance.now() + 80000;
    while (Date.now() < pausedUntil) {
      if (performance.now() >= waitDeadline) throw new Error('FIXTURE_PAUSE_WALL_WAIT_TIMEOUT');
      expect(state.attempt(offer.jobId)).toMatchObject({ state: 'PAUSED', pausedAt: before.pausedAt });
      await sleep(Math.min(100, Math.max(1, pausedUntil - Date.now())));
    }
    expect(state.attempt(offer.jobId)?.state).toBe('PAUSED'); expect(calls).toBe(1); expect(delivered).toHaveLength(0);
    await command('RESUME_JOB'); await active.task;
    expect(state.attempt(offer.jobId)?.state).toBe('SUCCEEDED'); expect(calls).toBe(2); expect(delivered).toHaveLength(1);
    expect(await runtime.docker.owned(active.spec)).toBe(false);
    expect(events).toEqual(['ACCEPTED', 'RUNNING', 'PAUSED', 'RESUMING', 'RUNNING']);
    const attempt = state.attempt(offer.jobId)!;
    expect(attempt.pausedDurationMs).toBeGreaterThanOrEqual(75000);
    expect(Date.now() - attempt.createdAt - attempt.pausedDurationMs).toBeLessThan(30000);
    process.stdout.write(JSON.stringify({ phase: 'real-long-pause', imageId, jobId: offer.jobId, maxPauseMs: offer.maxPauseMs, activeUsedBeforePauseMs: activeUsedMs, pausedMs: attempt.pausedDurationMs, wallMs: Date.now() - attempt.createdAt, calls, resultSha256: sha256(marker), realOpenClaw: true, deterministicProvider: true, cloudAndSettlement: 'NOT_EXERCISED', removed: true }) + '\n');
  }, 180000);
});

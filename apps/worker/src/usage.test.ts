import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceIdentity } from '@kivro/crypto';
import { verifyRequest } from '@kivro/job-protocol';
import { WorkerUsageReceiptSchema } from '@kivro/contracts';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { WorkerRuntime } from './runtime.ts';
import { SecretStore } from './secrets.ts';
import { WorkerTransport, TransportError } from './transport.ts';
import { InferenceBroker, validateInferenceConfig } from './inference.ts';
import { initializeUsage, reserveUsage, reportUsage, tokenCostMicroUsd, usdToMicroUsd, usageReceipt } from './usage.ts';
import * as http from './http.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-usage-'))), offer = fixtureOffer();
  const config = validateInferenceConfig({ provider: offer.permissions.inference.provider, model: offer.permissions.inference.model, baseUrl: 'https://provider.example/v1', credentialRef: offer.permissions.inference.credentialRef, inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 7.5 });
  const context = { root, state: new WorkerState(root), offer, config };
  context.state.resume('LOCAL'); context.state.claim(offer, `kivro-job-${offer.attemptId}`);
  cleanups.push(async () => { context.state.close(); await rm(root, { recursive: true, force: true }); });
  return context;
}
function runtime(state: WorkerState, request = vi.fn().mockResolvedValue({})) {
  const worker = new WorkerRuntime(state, new SecretStore(state), 'test-only-image', true); Object.assign(worker, { transport: { request } }); return { worker, request };
}
function record(state: WorkerState, attemptId: string, reported = true) {
  initializeUsage(state, attemptId, { provider: 'openai-compatible', model: 'test-model', inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 7.5 });
  const id = state.transaction(() => reserveUsage(state, attemptId, 1000, 5000));
  if (reported) reportUsage(state, attemptId, id, 10, 2); return id;
}
function resultReady(state: WorkerState, jobId: string, attemptId: string) {
  state.transition(jobId, 'RUNNING'); state.transition(jobId, 'UPLOADING_RESULTS', false);
  state.enqueue(`/api/worker/jobs/${jobId}/result`, { attemptId, output: { text: 'result fixture' } }, 'result');
}
describe('durable sanitized inference receipts', () => {
  it('uses exact decimal microUSD arithmetic and conservative budget rounding', () => {
    const pricing = { provider: 'openai-compatible' as const, model: 'test-model', inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.2 };
    expect(tokenCostMicroUsd(10, 10, pricing)).toBe(3); expect(tokenCostMicroUsd(1, 1, pricing)).toBe(1);
    expect(tokenCostMicroUsd(10000000, 0, { ...pricing, inputUsdPerMillionTokens: 1e-7 })).toBe(1);
    expect(tokenCostMicroUsd(10, 10, pricing, 2)).toBe(4);
    expect(usdToMicroUsd(0.000001)).toBe(1); expect(usdToMicroUsd(0.0000009)).toBe(0); expect(usdToMicroUsd(0.0000009, true)).toBe(1);
    expect(() => usdToMicroUsd(Number.NaN)).toThrow(); expect(() => tokenCostMicroUsd(-1, 1, pricing)).toThrow();
  });
  it('records admitted attempts before transport and successful response tokens, never prompts, keys or endpoints', async () => {
    const { state, offer, config } = await fixture(), key = 'dedicated-secret-canary', prompt = 'private-input-canary';
    const broker = new InferenceBroker(config, key, offer.permissions, state, offer.attemptId);
    const spy = vi.spyOn(http, 'boundedRequest').mockImplementation(async () => {
      expect(usageReceipt(state, offer.attemptId)).toMatchObject({ attemptedCalls: 1, successfulCalls: 0, unpricedCalls: 1 });
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ id: 'completion', model: config.model, choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })) };
    });
    const input = { model: config.model, messages: [{ role: 'user', content: prompt }], max_tokens: 10 };
    await broker.request(input); spy.mockResolvedValue({ status: 429, body: Buffer.from(`${key} ${prompt}`), headers: {} });
    await expect(broker.request(input)).rejects.toThrow('INFERENCE_QUOTA_EXCEEDED');
    const receipt = usageReceipt(state, offer.attemptId);
    expect(receipt).toMatchObject({ attemptedCalls: 2, successfulCalls: 1, unpricedCalls: 1, inputTokens: 10, outputTokens: 2, estimatedCostMicroUsd: 40, costBasis: 'WORKER_CONFIGURED_RATES' });
    expect(receipt.reservedCostMicroUsd).toBeGreaterThan(40);
    const data = JSON.stringify(state.get(`inferenceUsage:${offer.attemptId}`)); expect(data).not.toContain(key); expect(data).not.toContain(prompt); expect(data).not.toContain(config.baseUrl);
    state.set('inference', { ...config, inputUsdPerMillionTokens: 999 }); expect(usageReceipt(state, offer.attemptId)).toEqual(receipt);
    expect(() => new InferenceBroker({ ...config, inputUsdPerMillionTokens: 999 }, key, offer.permissions, state, offer.attemptId)).toThrow('PRICING_CHANGED');
    broker.cancel();
  });
  it('does not count denied local requests as provider attempts or exceed the 32-call receipt bound', async () => {
    const { state, offer, config } = await fixture(); const broker = new InferenceBroker({ ...config, maxUsdPerJob: 0.000001 }, 'test-only-secret', offer.permissions, state, offer.attemptId);
    const spy = vi.spyOn(http, 'boundedRequest');
    await expect(broker.request({ model: config.model, messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow('INFERENCE_BUDGET_EXCEEDED');
    expect(usageReceipt(state, offer.attemptId)).toMatchObject({ attemptedCalls: 0, unpricedCalls: 0, reservedCostMicroUsd: 0 }); expect(spy).not.toHaveBeenCalled();
    for (let count = 0; count < 32; count++) state.transaction(() => reserveUsage(state, offer.attemptId, 1, 0));
    expect(() => state.transaction(() => reserveUsage(state, offer.attemptId, 1, 0))).toThrow(); expect(usageReceipt(state, offer.attemptId).attemptedCalls).toBe(32);
  });
  it.each([true, false])('queues exactly once only after result acknowledgement and frozen usage, freeze first=%s', async freezeFirst => {
    const { state, offer } = await fixture(); record(state, offer.attemptId); resultReady(state, offer.jobId, offer.attemptId);
    if (freezeFirst) state.finalizeUsage(offer.jobId); expect(state.pending().some(item => item.kind === 'usage')).toBe(false);
    const { worker, request } = runtime(state); await worker.flush(); expect(state.attempt(offer.jobId)?.state).toBe('SUCCEEDED');
    if (!freezeFirst) state.finalizeUsage(offer.jobId); state.finalizeUsage(offer.jobId);
    const queued = state.pending().filter(item => item.kind === 'usage'); expect(queued).toHaveLength(1); expect(WorkerUsageReceiptSchema.parse(queued[0]!.body)).toEqual(usageReceipt(state, offer.attemptId));
    expect(request.mock.calls.map(call => call[1])).not.toContain(`/api/worker/jobs/${offer.jobId}/usage`);
    await worker.flushUsage(); state.finalizeUsage(offer.jobId); expect(state.pending()).toEqual([]); expect(state.get(`usageDelivery:${offer.attemptId}`)).toBe('ACKNOWLEDGED');
    expect(() => reserveUsage(state, offer.attemptId, 1, 0)).toThrow('FINALIZED');
  });
  it('recovers an uncertain admitted call without inference replay and reports it unpriced after terminal acknowledgement', async () => {
    const context = await fixture(); record(context.state, context.offer.attemptId, false);
    context.state.acknowledgeDelivery(context.state.pending()[0]!); context.state.transition(context.offer.jobId, 'RUNNING');
    context.state.close(); context.state = new WorkerState(context.root);
    const { worker } = runtime(context.state); const remove = vi.spyOn(worker.docker, 'remove').mockResolvedValue(); const execute = vi.spyOn(worker.adapter, 'execute');
    await worker.recover(context.offer.workerId); expect(remove).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
    expect(context.state.attempt(context.offer.jobId)?.state).toBe('FAILED'); expect(context.state.pending().some(item => item.kind === 'usage')).toBe(false);
    await worker.flush(); const receipt = context.state.pending().find(item => item.kind === 'usage')!.body;
    expect(receipt).toMatchObject({ attemptedCalls: 1, successfulCalls: 0, unpricedCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: 0, reservedCostMicroUsd: 5000 });
  });
  it('does not invent a receipt for legacy token-only state or an unaccepted attempt', async () => {
    const { state, offer } = await fixture(); state.set(`inferenceUsage:${offer.attemptId}`, { calls: 1, inputTokens: 10, outputTokens: 2 }); state.transition(offer.jobId, 'FAILED');
    state.finalizeUsage(offer.jobId); expect(state.get(`usageReceipt:${offer.attemptId}`)).toBeUndefined(); expect(state.get(`usageUnavailable:${offer.attemptId}`)).toBe(true);
    state.delete(`inferenceUsage:${offer.attemptId}`); record(state, offer.attemptId, false); state.finalizeUsage(offer.jobId);
    for (const item of state.pending()) state.acknowledge(item.id); expect(state.pending()).toEqual([]);
  });
  it('keeps a slow/failing usage upload independent of new delivery events and persists backoff', async () => {
    const context = await fixture(); record(context.state, context.offer.attemptId); context.state.transition(context.offer.jobId, 'FAILED'); context.state.finalizeUsage(context.offer.jobId);
    const { worker, request } = runtime(context.state); await worker.flush(); const usage = context.state.pending()[0]!;
    let fail!: () => void;
    request.mockImplementation(async (_method, path) => path.endsWith('/usage') ? new Promise((_resolve, reject) => { fail = () => reject(new TransportError(500, 'UNAVAILABLE')); }) : {});
    const pending = worker.flushUsage(); const next = fixtureOffer(); context.state.claim(next, `kivro-job-${next.attemptId}`); await worker.flush();
    expect(request.mock.calls.some(call => call[1] === `/api/worker/jobs/${next.jobId}/events`)).toBe(true);
    fail(); await pending; expect(context.state.attempt(context.offer.jobId)?.state).toBe('FAILED'); expect(context.state.get(`usageRetry:${usage.id}`)).toMatchObject({ failures: 1 });
    const count = request.mock.calls.length; await worker.flushUsage(); expect(request).toHaveBeenCalledTimes(count);
    context.state.close(); context.state = new WorkerState(context.root); expect(context.state.pending().find(item => item.kind === 'usage')?.body).toEqual(usage.body); expect(context.state.get(`usageRetry:${usage.id}`)).toMatchObject({ failures: 1 });
  });
  it('retains receipts for an accepted historical attempt already terminated by the cloud', async () => {
    const { state, offer } = await fixture(); record(state, offer.attemptId, false); state.acknowledgeDelivery(state.pending()[0]!); state.transition(offer.jobId, 'FAILED'); state.finalizeUsage(offer.jobId);
    const { worker } = runtime(state, vi.fn().mockRejectedValue(new TransportError(409, 'JOB_TERMINAL'))); await worker.flush();
    expect(state.pending().map(item => item.kind)).toEqual(['usage']); expect(state.attempt(offer.jobId)?.state).toBe('FAILED');
  });
  it('quarantines invalid local receipts and permanent conflicts without blocking terminal acknowledgement', async () => {
    const { state, offer } = await fixture(); record(state, offer.attemptId); state.transition(offer.jobId, 'FAILED'); state.finalizeUsage(offer.jobId);
    const snapshot = state.get(`usageReceipt:${offer.attemptId}`); state.set(`usageReceipt:${offer.attemptId}`, { private: 'invalid-local-content' });
    const { worker, request } = runtime(state); await worker.flush(); expect(state.pending()).toEqual([]); expect(state.get(`usageDelivery:${offer.attemptId}`)).toBe('INVALID');
    state.set(`usageReceipt:${offer.attemptId}`, snapshot); state.delete(`usageDelivery:${offer.attemptId}`); state.finalizeUsage(offer.jobId);
    request.mockRejectedValue(new TransportError(409, 'USAGE_RECEIPT_CONFLICT')); await worker.flushUsage();
    expect(state.get(`usageDelivery:${offer.attemptId}`)).toBe('REJECTED'); expect(state.get(`usageReceipt:${offer.attemptId}`)).toEqual(snapshot); expect(state.pending()).toEqual([]); expect(state.attempt(offer.jobId)?.state).toBe('FAILED');
  });
  it('retries the identical strict receipt body with real signed transport and no settlement payload', async () => {
    const { state, offer } = await fixture(); record(state, offer.attemptId); state.transition(offer.jobId, 'CANCELLED'); state.finalizeUsage(offer.jobId);
    const keys = generateDeviceIdentity(), bodies: string[] = [], errors: unknown[] = []; let finalized = false;
    const server = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk); const body = Buffer.concat(parts);
        expect(verifyRequest(keys.publicKey, req.method!, req.url!, body, req.headers as Record<string, string>)).toBe(true);
        if (req.url!.endsWith('/usage')) {
          expect(finalized).toBe(true); const receipt = WorkerUsageReceiptSchema.parse(JSON.parse(body.toString())); expect(receipt.attemptId).toBe(offer.attemptId); bodies.push(body.toString()); res.writeHead(bodies.length === 1 ? 500 : 200).end('{}');
        } else { if (JSON.parse(body.toString()).type === 'CANCELLED') finalized = true; res.end('{}'); }
      } catch (error) { errors.push(error); res.writeHead(500).end('{}'); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_ADDRESS');
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); expect(errors).toEqual([]); });
    const apiUrl = `http://127.0.0.1:${address.port}`, transport = new WorkerTransport(apiUrl, { workerId: offer.workerId, publicKey: keys.publicKey, serverPublicKey: keys.publicKey, apiUrl }, keys.privateKey, true);
    const worker = new WorkerRuntime(state, new SecretStore(state), 'fixture', true); Object.assign(worker, { transport });
    await worker.flush(); await worker.flushUsage(); const item = state.pending()[0]!; state.delete(`usageRetry:${item.id}`); await worker.flushUsage();
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); expect(state.pending()).toEqual([]); expect(state.attempt(offer.jobId)?.state).toBe('CANCELLED');
    expect(bodies[0]).not.toMatch(/prompt|credential|https?:|priceVersion|capture|payment|invoice/i);
  });
});

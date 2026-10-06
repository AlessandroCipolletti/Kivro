import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashManifest } from '@kivro/contracts';
import type { LocalInferenceMetadata } from '@kivro/openclaw-adapter';
import { localInferenceMetadata } from '../../../packages/openclaw-adapter/src/discovery.ts';
import { checkLocalInference, discoverLocalInference } from './local-inference.ts';
import { inferenceReady, validateInferenceConfig } from './inference.ts';
import { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';
import * as http from './http.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const model = 'qwen/example-model', secret = 'test-only-dedicated-local-credential';
const metadata = (runtime: LocalInferenceMetadata['runtime'], port = 1234): LocalInferenceMetadata => ({ runtime, provider: 'openai-compatible', endpoint: `http://127.0.0.1:${port}/v1`, models: [model], requiredService: 'unused', hardwareRequirements: null });
function response(body: unknown, status = 200) { return { status, headers: {}, body: Buffer.from(JSON.stringify(body)) }; }
async function server(handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  const address = instance.address(); if (!address || typeof address === 'string') throw new Error('TEST_ADDRESS');
  cleanups.push(() => close(instance));
  return { instance, port: address.port };
}
async function close(instance: Server) { instance.closeAllConnections(); if (instance.listening) await new Promise<void>(resolve => instance.close(() => resolve())); }

describe('read-only supported local inference discovery', () => {
  it('projects only known loopback service/model metadata without exposing provider values', () => {
    const raw = { models: { providers: {
      ollama: { baseUrl: 'http://localhost:11434', apiKey: 'PERSONAL_KEY', headers: { authorization: 'PERSONAL_AUTH' }, models: [{ id: model, name: 'PRIVATE_LABEL', path: '/private/model' }] },
      lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'lm/model' }, { id: '../private/path' }] },
      arbitrary: { baseUrl: 'http://127.0.0.1:9000', models: [{ id: 'not-selected' }] },
    } }, env: { PERSONAL_KEY: 'PRIVATE_SECRET' } };
    const result = localInferenceMetadata(raw);
    expect(result).toHaveLength(2); expect(result[0]).toMatchObject({ runtime: 'OLLAMA', endpoint: 'http://127.0.0.1:11434/v1', models: [model] });
    expect(result[1]?.models).toEqual(['lm/model']); expect(JSON.stringify(result)).not.toMatch(/PERSONAL|PRIVATE|not-selected/);
  });
  it.each(['https://public.example/v1', 'http://192.168.1.4/v1', 'http://user:pass@127.0.0.1/v1', 'http://127.0.0.1/v1?key=secret', 'http://127.0.0.1/private', 'file:///tmp/config'])('rejects unsafe declared service %s', baseUrl => {
    expect(localInferenceMetadata({ models: { providers: { ollama: { baseUrl } } } })).toEqual([]);
  });
  it('probes only two fixed default metadata routes with no auth, generation, redirects, model loading or arbitrary scans', async () => {
    const request = vi.spyOn(http, 'boundedRequest').mockImplementation(async url => url.pathname === '/api/tags' ? response({ models: [{ name: model, details: { ignored: true } }] }) : response({ data: [{ id: model }] }));
    const result = await discoverLocalInference();
    expect(result.map(item => item.runtime)).toEqual(['OLLAMA', 'LM_STUDIO']);
    expect(result.every(item => item.availability === 'AVAILABLE' && !item.minimalInferenceVerified && item.hardwareRequirements === null)).toBe(true);
    expect(request.mock.calls.map(([url]) => url.href)).toEqual(['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:1234/v1/models']);
    for (const [, options] of request.mock.calls) expect(options).toEqual({ headers: { accept: 'application/json' }, localApproved: true, maxBytes: 65536, timeoutMs: 2000 });
  });
  it('distinguishes auth required, service offline and a declared model absent from the available list', async () => {
    const request = vi.spyOn(http, 'boundedRequest').mockResolvedValue(response({}, 401));
    expect((await discoverLocalInference([metadata('LM_STUDIO')]))[0]?.availability).toBe('AUTH_REQUIRED');
    request.mockRejectedValue(new Error('PRIVATE_PATH_OR_CREDENTIAL'));
    const offline = await discoverLocalInference([metadata('LM_STUDIO')]);
    expect(offline[0]?.availability).toBe('UNREACHABLE'); expect(JSON.stringify(offline)).not.toContain('PRIVATE_PATH');
    request.mockResolvedValue(response({ data: [{ id: 'different-model' }] }));
    expect((await discoverLocalInference([metadata('LM_STUDIO')]))[0]?.availability).toBe('MODEL_UNAVAILABLE');
  });
  it('bounds candidates, JSON and model metadata and never follows unsafe endpoints', async () => {
    const request = vi.spyOn(http, 'boundedRequest').mockResolvedValue(response({ data: Array(101).fill({ id: model }) }));
    await expect(discoverLocalInference(Array(3).fill(metadata('LM_STUDIO')))).rejects.toThrow('DISCOVERY_LIMIT');
    await expect(discoverLocalInference([{ ...metadata('LM_STUDIO'), endpoint: 'http://10.0.0.1/v1' }])).rejects.toThrow('UNSAFE_LOCAL');
    expect(request).not.toHaveBeenCalled();
    expect((await discoverLocalInference([metadata('LM_STUDIO')]))[0]?.availability).toBe('UNREACHABLE');
    request.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from([0xff]) });
    expect((await discoverLocalInference([metadata('LM_STUDIO')]))[0]?.availability).toBe('UNREACHABLE');
  });
});

describe('fresh local dependency health after an approved generation test', () => {
  it('requires the unchanged minimal inference proof, rechecks disappearance/model loss and recovers without modifying grants', async () => {
    const calls: string[] = []; let status = 200, availableModels = [model];
    const { instance, port } = await server((req, res) => {
      calls.push(`${req.method} ${req.url}`); expect(req.headers.authorization).toBe(`Bearer ${secret}`);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ data: availableModels.map(id => ({ id })) }));
    });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-local-health-'))), state = new WorkerState(root);
    cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
    const config = validateInferenceConfig({ provider: 'openai-compatible', model, credentialRef: 'local-dedicated', baseUrl: `http://127.0.0.1:${port}/v1`, allowLocal: true, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
    state.set('inference', config); const secrets = { get: vi.fn(async () => secret) } as unknown as SecretStore;
    expect(await inferenceReady(state, secrets)).toMatchObject({ ready: false, reason: 'RUN_INFERENCE_TEST' }); expect(calls).toEqual([]);
    const proof = { hash: hashManifest(config), testedAt: Date.now() }; state.set('inferenceProof', proof);
    expect((await inferenceReady(state, secrets)).ready).toBe(true);
    availableModels = []; expect(await inferenceReady(state, secrets)).toMatchObject({ ready: false, reason: 'LOCAL_INFERENCE_MODEL_UNAVAILABLE' });
    availableModels = [model]; status = 503;
    expect(await inferenceReady(state, secrets)).toMatchObject({ ready: false, reason: 'LOCAL_INFERENCE_OFFLINE' });
    status = 200; expect((await inferenceReady(state, secrets)).ready).toBe(true);
    await close(instance); expect(await inferenceReady(state, secrets)).toMatchObject({ ready: false, reason: 'LOCAL_INFERENCE_OFFLINE' });
    expect(state.get('localInferenceHealth')).toMatchObject({ available: false, modelAvailable: false, configHash: hashManifest(config) });
    expect(state.get('inferenceProof')).toEqual(proof); expect(state.get('inference')).toEqual(config);
    expect(calls).toEqual(Array(4).fill('GET /v1/models')); expect(JSON.stringify(state.get('localInferenceHealth'))).not.toContain(secret);
  });
  it('uses real unauthenticated metadata endpoints while refusing redirects and oversized responses', async () => {
    let mode = 'ok'; const paths: string[] = [];
    const { port } = await server((req, res) => {
      paths.push(req.url!); expect(req.headers.authorization).toBeUndefined();
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://192.168.1.1/private' }).end(); return; }
      if (mode === 'large') { res.writeHead(200, { 'content-length': '65537' }).end('x'.repeat(65537)); return; }
      res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: model }] } : { data: [{ id: model }] }));
    });
    expect((await discoverLocalInference([metadata('OLLAMA', port)]))[0]?.availability).toBe('AVAILABLE');
    expect((await discoverLocalInference([metadata('LM_STUDIO', port)]))[0]?.availability).toBe('AVAILABLE');
    mode = 'redirect'; expect((await discoverLocalInference([metadata('LM_STUDIO', port)]))[0]?.availability).toBe('UNREACHABLE');
    mode = 'large'; expect((await discoverLocalInference([metadata('LM_STUDIO', port)]))[0]?.availability).toBe('UNREACHABLE');
    expect(paths).toEqual(['/api/tags', '/v1/models', '/v1/models', '/v1/models']);
  });
  it('never polls a paid remote provider and never generates automatically', async () => {
    const state = { get: (key: string) => key === 'inference' ? config : { hash: hashManifest(config), testedAt: Date.now() } } as unknown as WorkerState;
    const config = validateInferenceConfig({ provider: 'openai-compatible', model, credentialRef: 'dedicated', baseUrl: 'https://provider.example/v1', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
    const request = vi.spyOn(http, 'boundedRequest');
    expect((await inferenceReady(state, { get: async () => secret } as unknown as SecretStore)).ready).toBe(true); expect(request).not.toHaveBeenCalled();
    expect(await checkLocalInference({ ...config, baseUrl: 'https://public.example/v1' }, secret)).toMatchObject({ available: false, reason: 'LOCAL_INFERENCE_OFFLINE' });
    expect(request).not.toHaveBeenCalled();
  });
});

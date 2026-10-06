import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashManifest } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { OpenClawAdapter } from '@kivro/openclaw-adapter';
import { reserveResearchUsage, type HttpTransport, type ReviewedPublicResearchPlan } from '@kivro/research-broker';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { JobToolBroker } from './tools.ts';
import { approveResearchPlan, researchPolicy, selectedResearchConsent } from './research-config.ts';
import { approveResearchScanner, verifyResearchScanner, selectedResearchScanner } from './research-scanner.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function fixture(options: { bytes?: string; infected?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-download-'))), state = new WorkerState(root), sockets = new Set<Socket>(); let scans = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffered = Buffer.alloc(0), header = false, bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!header) { if (buffered.length < 10) return; buffered = buffered.subarray(10); header = true; }
      while (buffered.length >= 4) {
        const size = buffered.readUInt32BE(); if (buffered.length < 4 + size) return;
        bytes = Buffer.concat([bytes, buffered.subarray(4, 4 + size)]); buffered = buffered.subarray(4 + size);
        if (!size) { scans++; socket.end(options.infected || bytes.includes('EICAR-STANDARD') ? 'stream: Test FOUND\0' : 'stream: OK\0'); }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); state.close(); await rm(root, { recursive: true, force: true }); });
  const scanner = { schemaVersion: 1, host: '127.0.0.1', port: (server.address() as { port: number }).port };
  approveResearchScanner(state, scanner, hashManifest(scanner));
  if (!options.infected) await verifyResearchScanner(state);
  else state.set('researchScannerProof', { configHash: hashManifest(scanner), testedAt: Date.now() });
  scans = 0;
  const offer = fixtureOffer(); offer.sellerId = randomUUID(); offer.permissions.tools = ['read', 'research.download', 'resource.query'];
  offer.permissions.network = { mode: 'RESEARCH', allowedDomains: ['example.com'], researchLimits: { maxQueries: 0, maxPages: 2, maxResponseBytes: 1000, maxTotalBytes: 2000, maxDurationMs: 5000 }, downloads: { schemaVersion: 1, allowedMimeTypes: ['text/csv'], maxFiles: 2, maxFileBytes: 1000, maxTotalBytes: 2000 } };
  offer.permissions.resources = [{ id: 'private-db', type: 'DATABASE', access: 'READ_ONLY' }];
  state.set(`capability:${offer.capabilityVersionId}`, offer); state.set('capabilityIds', [offer.capabilityVersionId]); state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`);
  const plan: ReviewedPublicResearchPlan = { schemaVersion: 1, capabilityVersionId: offer.capabilityVersionId, dependencyBindingHash: hashManifest(offer.dependencies), limits: {}, sources: [{ id: 'public-data', operation: 'DOWNLOAD', request: { url: 'https://example.com/fixed.csv', expectedMimeType: 'text/csv' }, provenance: { kind: 'REVIEWED_PUBLIC_LITERAL', sourceUrl: 'https://example.com/fixed.csv', reviewedAt: new Date().toISOString(), reviewedBy: offer.sellerId } }] };
  const preview = approveResearchPlan(state, plan, offer.sellerId); approveResearchPlan(state, plan, offer.sellerId, preview.approvalHash);
  const data = Buffer.from(options.bytes ?? 'label,value\npublic,42\n');
  const download = vi.fn<NonNullable<HttpTransport['download']>>(async (request, sink) => {
    expect(request.url).toBe('https://example.com/fixed.csv'); expect(state.attempt(offer.jobId)?.state).toBe('ACCEPTED');
    await pipeline(Readable.from([data]), sink);
    return { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=../../secret.sh' }, contentBytes: data.length, bytesReceived: data.length, sha256: sha256(data), finalUrl: request.url };
  });
  const resource = { execute: vi.fn().mockResolvedValue({ rows: [{ secret: 'private-seller-canary' }] }), close: vi.fn() };
  const broker = new JobToolBroker(offer, state, offer.dependencies, undefined, resource, [], { http: { request: vi.fn(), download } }); cleanups.push(async () => broker.cancel());
  const jobRoot = join(root, 'job'); await mkdir(jobRoot);
  return { state, offer, plan, root, jobRoot, broker, download, resource, data, scans: () => scans };
}
describe('scanned public file admission', () => {
  it('quarantines, validates, scans and stages generated read-only filenames before any private call', async () => {
    const f = await fixture(); await f.broker.preparePublicResearch(f.jobRoot);
    expect(f.scans()).toBe(1); expect(f.resource.execute).not.toHaveBeenCalled(); expect(await readdir(f.jobRoot)).toEqual([]);
    const files = f.broker.downloadedFiles(); expect(files).toHaveLength(1); expect(files[0]!.path).toMatch(/^skills\/kivro-public-data\/[a-f0-9-]{36}\.csv$/);
    const env = await new OpenClawAdapter().buildWorkerEnvironment(f.jobRoot, f.offer, [], f.broker.researchTools(), files);
    await f.broker.installResearchFiles(env.inputDir); const path = join(env.inputDir, 'research', files[0]!.path.split('/').at(-1)!);
    expect(await readFile(path)).toEqual(f.data); expect((await lstat(path)).mode & 0o777).toBe(0o444);
    f.state.transition(f.offer.jobId, 'RUNNING'); await f.broker.execute('resource.query', { resourceId: 'private-db', operation: 'get', input: {} });
    const result = await f.broker.execute('research.download', { reviewedSourceId: 'public-data' });
    expect(result).toMatchObject({ descriptor: { sha256: sha256(f.data), untrusted: true }, scan: { verdict: 'CLEAN' }, provenance: { destinationHost: 'example.com' } });
    for (const raw of [{ url: 'https://example.com/private-seller-canary' }, { reviewedSourceId: 'public-data', url: 'https://example.com/private-seller-canary' }, { reviewedSourceId: 'different' }]) await expect(f.broker.execute('research.download', raw)).rejects.toThrow();
    expect(f.download).toHaveBeenCalledOnce(); expect(JSON.stringify(f.state.get(`researchFile:${f.offer.jobId}:public-data`))).not.toContain(f.root);
    const id = f.state.get<string[]>(`researchRequests:${f.offer.jobId}`)![0]; expect(f.state.get(`researchRequest:${id}`)).toMatchObject({ operation: 'DOWNLOAD', responseSha256: sha256(f.data), actualBytes: f.data.length });
  });
  it.each([{ infected: true }, { bytes: '#!/bin/sh\nwhoami\n' }, { bytes: 'a,b\n1,=CMD()\n' }, { bytes: '\x00binary' }])('never exposes rejected content %j', async options => {
    const f = await fixture(options); await expect(f.broker.preparePublicResearch(f.jobRoot)).rejects.toThrow(); expect(f.broker.downloadedFiles()).toHaveLength(0); expect(await readdir(f.jobRoot)).toEqual([]); expect(f.state.get(`researchFile:${f.offer.jobId}:public-data`)).toBeUndefined();
  });
  it('cannot execute a cache miss or restart the prelude after private execution', async () => {
    const f = await fixture(); f.state.transition(f.offer.jobId, 'RUNNING'); await expect(f.broker.preparePublicResearch(f.jobRoot)).rejects.toThrow('BEFORE_PRIVATE'); await expect(f.broker.execute('research.download', { reviewedSourceId: 'public-data' })).rejects.toThrow('CACHE_MISS'); expect(f.download).not.toHaveBeenCalled();
  });
  it('requires fixed source review even for otherwise public jobs and binds dependencies', async () => {
    const f = await fixture(); f.state.delete(`researchPlan:${f.offer.capabilityVersionId}`); expect(() => selectedResearchConsent(f.state, f.offer)).toThrow('REQUIRED');
    expect(() => approveResearchPlan(f.state, { ...f.plan, dependencyBindingHash: 'f'.repeat(64) }, f.offer.sellerId!)).toThrow('MISMATCH');
  });
  it('retains shared page/byte budget and download sublimits across calls', async () => {
    const f = await fixture(), policy = researchPolicy(f.offer.permissions);
    const prior = reserveResearchUsage(undefined, { operation: 'DOWNLOAD', maxBytes: 1000, nowMs: 10 }, policy);
    expect(prior).toMatchObject({ pages: 1, reservedBytes: 1000, downloads: 1, downloadBytes: 1000 });
    const mixed = reserveResearchUsage(prior, { operation: 'FETCH', maxBytes: 1000, nowMs: 11 }, { ...policy, fetchEnabled: true });
    expect(() => reserveResearchUsage(mixed, { operation: 'DOWNLOAD', maxBytes: 1, nowMs: 12 }, policy)).toThrow('BUDGET');
  });
  it('applies the lower local per-file ceiling without changing reviewed permission hashes', async () => {
    const f = await fixture(), before = JSON.stringify(f.offer.permissions);
    vi.stubEnv('KIVRO_MAX_JOB_FILE_BYTES', String(f.data.length - 1));
    await expect(f.broker.preparePublicResearch(f.jobRoot)).rejects.toThrow('RESEARCH_DOWNLOAD_LIMIT');
    expect(f.broker.downloadedFiles()).toEqual([]);
    expect(f.state.get(`researchFile:${f.offer.jobId}:public-data`)).toBeUndefined();
    expect(await readdir(f.jobRoot)).toEqual([]);
    expect(JSON.stringify(f.offer.permissions)).toBe(before);
  });
  it('counts existing buyer input against the lowered download input budget', async () => {
    const f = await fixture(), before = JSON.stringify(f.offer.permissions);
    const inputBytes = Buffer.byteLength(JSON.stringify(f.offer.input));
    vi.stubEnv('KIVRO_MAX_JOB_INPUT_BYTES', String(inputBytes + f.data.length - 1));
    await expect(f.broker.preparePublicResearch(f.jobRoot)).rejects.toThrow('RESEARCH_DOWNLOAD_LIMIT');
    expect(f.broker.downloadedFiles()).toEqual([]);
    expect(await readdir(f.jobRoot)).toEqual([]);
    expect(JSON.stringify(f.offer.permissions)).toBe(before);
  });
  it('accepts exact combined input bytes and denies downloads when buyer input leaves no budget', async () => {
    const exact = await fixture(), exhausted = await fixture();
    const inputBytes = Buffer.byteLength(JSON.stringify(exact.offer.input));
    vi.stubEnv('KIVRO_MAX_JOB_INPUT_BYTES', String(inputBytes + exact.data.length));
    await expect(exact.broker.preparePublicResearch(exact.jobRoot)).resolves.toBeUndefined();
    expect(exact.broker.downloadedFiles()).toHaveLength(1);
    vi.stubEnv('KIVRO_MAX_JOB_INPUT_BYTES', String(inputBytes));
    await expect(exhausted.broker.preparePublicResearch(exhausted.jobRoot)).rejects.toThrow('RESEARCH_INPUT_LIMIT');
    expect(exhausted.download).not.toHaveBeenCalled();
    expect(exhausted.broker.downloadedFiles()).toEqual([]);
  });
  it('does not silently configure scanners, expires health proof, and invalidates capability proof on consent change', async () => {
    const f = await fixture(); expect(selectedResearchScanner(f.state).host).toBe('127.0.0.1');
    const config = { schemaVersion: 1, host: '127.0.0.1', port: 3311 }, before = f.state.get('researchScanner');
    approveResearchScanner(f.state, config); expect(f.state.get('researchScanner')).toEqual(before);
    f.state.set(`capabilityProof:${f.offer.capabilityVersionId}`, {}); approveResearchScanner(f.state, config, hashManifest(config));
    expect(f.state.get(`capabilityProof:${f.offer.capabilityVersionId}`)).toBeUndefined(); expect(() => selectedResearchScanner(f.state)).toThrow('TEST_REQUIRED');
    expect(() => approveResearchScanner(f.state, { ...config, host: '192.168.1.2' })).toThrow();
  });
});

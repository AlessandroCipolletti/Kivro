import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashManifest, JobNoticeSchema, MAX_JOB_PAUSE_MS, type JobOffer } from '@kivro/contracts';
import { generateDeviceIdentity, signMessage, stableStringify } from '@kivro/crypto';
import { canonicalRequest, signedHeaders, verifyRequest, signOffer, verifyOffer, verifyNotice, verifyAcceptedPayload, WorkerCommandSchema } from './index.ts';
import { fixtureOffer } from './fixtures.ts';
describe('signed worker protocol', () => {
  it('limits global-pause confirmation to a single identified resume command', () => {
    const command = { id: randomUUID(), jobId: randomUUID(), type: 'RESUME_JOB', resumeWhilePaused: true };
    expect(WorkerCommandSchema.parse(command)).toEqual(command);
    for (const type of ['PAUSE_ALL', 'RESUME_ALL', 'PAUSE_JOB', 'CANCEL_JOB']) expect(() => WorkerCommandSchema.parse({ ...command, type })).toThrow();
    expect(() => WorkerCommandSchema.parse({ ...command, jobId: undefined })).toThrow();
    expect(() => WorkerCommandSchema.parse({ ...command, confirmGlobalPause: true })).toThrow();
  });
  it.each([undefined, 1000, 1501, MAX_JOB_PAUSE_MS])('authenticates original signed pause budget %s before applying legacy defaults', maxPauseMs => {
    const key = generateDeviceIdentity(), offer = fixtureOffer();
    const { maxPauseMs: _budget, ...legacy } = offer;
    const payload: JobOffer = maxPauseMs === undefined ? legacy : { ...legacy, maxPauseMs };
    const { input: _input, assets: _assets, internalInstructions: _instructions, ...metadata } = payload;
    const notice = { ...metadata, payloadHash: hashManifest(payload) };
    const signed = { payload: notice, signature: signMessage(stableStringify(notice), key.privateKey) };
    const verified = verifyNotice(signed, key.publicKey, offer.workerId, offer);
    expect(verified.maxPauseMs).toBe(maxPauseMs ?? MAX_JOB_PAUSE_MS);
    expect(verifyAcceptedPayload(signOffer(payload, key.privateKey), key.publicKey, verified, offer.manifestHash).maxPauseMs).toBe(maxPauseMs ?? MAX_JOB_PAUSE_MS);
    expect(notice.maxPauseMs).toBe(maxPauseMs);
    expect(() => verifyNotice({ ...signed, payload: { ...notice, maxPauseMs: 50000 } }, key.publicKey, offer.workerId, offer)).toThrow('INVALID_NOTICE_SIGNATURE');
  });
  it('rejects pause-limit drift between otherwise valid signed notice and payload', () => {
    const key = generateDeviceIdentity(), offer = fixtureOffer(); offer.maxPauseMs = 2000;
    const { input: _input, assets: _assets, internalInstructions: _instructions, ...metadata } = offer;
    const notice = { ...metadata, maxPauseMs: 1000, payloadHash: hashManifest(offer) };
    const verified = verifyNotice({ payload: notice, signature: signMessage(stableStringify(notice), key.privateKey) }, key.publicKey, offer.workerId, offer);
    expect(() => verifyAcceptedPayload(signOffer(offer, key.privateKey), key.publicKey, verified, offer.manifestHash)).toThrow('ACCEPTED_PAUSE_BUDGET_MISMATCH');
    for (const maxPauseMs of [0, 999, 1000.5, MAX_JOB_PAUSE_MS + 1, Infinity]) expect(() => verifyOffer(signOffer({ ...offer, maxPauseMs }, key.privateKey), key.publicKey, offer.workerId, offer.manifestHash)).toThrow();
  });
  it('signs exact raw bytes and rejects changed body, path, method and skew', () => {
    const key = generateDeviceIdentity(), path = '/api/worker/heartbeat', body = Buffer.from('{"paused":true}');
    const headers = signedHeaders(randomUUID(), key.privateKey, 'POST', path, body);
    expect(verifyRequest(key.publicKey, 'POST', path, body, headers)).toBe(true);
    expect(verifyRequest(key.publicKey, 'POST', path, Buffer.from('{ "paused":true}'), headers)).toBe(false);
    expect(verifyRequest(key.publicKey, 'POST', '/api/worker/offers', body, headers)).toBe(false);
    expect(verifyRequest(key.publicKey, 'GET', path, body, headers)).toBe(false);
    expect(verifyRequest(key.publicKey, 'POST', path, body, headers, Date.now() + 61_000)).toBe(false);
  });
  it('rejects ambiguous request paths', () => { for (const path of ['/api/worker/offers?x=1', '/api/worker/offers\n', '/admin']) expect(() => canonicalRequest('GET', path, String(Date.now()), randomUUID())).toThrow(); });
  it('binds offers to payment, device, expiry, schema and exact version manifest', () => {
    const key = generateDeviceIdentity(), offer = fixtureOffer(), signed = signOffer(offer, key.privateKey);
    expect(verifyOffer(signed, key.publicKey, offer.workerId, offer.manifestHash).jobId).toBe(offer.jobId);
    for (const patch of [{ workerId: randomUUID() }, { expiresAt: new Date(Date.now() - 1).toISOString() }, { paymentSecured: false }, { internalInstructions: 'Expand access' }, { input: { unexpected: 'x' } }]) {
      expect(() => verifyOffer(signOffer({ ...offer, ...patch } as JobOffer, key.privateKey), key.publicKey, offer.workerId, offer.manifestHash)).toThrow();
    }
  });
  it('authenticates a content-free notice and commits to the later exact payload', () => {
    const key = generateDeviceIdentity(), offer = fixtureOffer();
    const { input: _input, internalInstructions: _instructions, assets: _assets, ...projection } = offer;
    const notice = JobNoticeSchema.parse({ ...projection, payloadHash: hashManifest(offer) });
    expect(Object.keys(notice)).not.toContain('input'); expect(Object.keys(notice)).not.toContain('assets'); expect(Object.keys(notice)).not.toContain('internalInstructions');
    const signed = { payload: notice, signature: signMessage(stableStringify(notice), key.privateKey) };
    expect(verifyNotice(signed, key.publicKey, offer.workerId, offer)).toEqual(notice);
    expect(verifyAcceptedPayload(signOffer(offer, key.privateKey), key.publicKey, notice, offer.manifestHash).input).toEqual(offer.input);
    expect(() => verifyAcceptedPayload(signOffer({ ...offer, input: { marker: 'substitution' } }, key.privateKey), key.publicKey, notice, offer.manifestHash)).toThrow('HASH_MISMATCH');
    expect(() => verifyNotice({ ...signed, payload: { ...notice, input: offer.input } }, key.publicKey, offer.workerId, offer)).toThrow();
    const changed = { ...notice, dependencies: notice.dependencies.map(dep => ({ ...dep, contentHash: 'a'.repeat(64) })) };
    expect(() => verifyNotice({ payload: changed, signature: signMessage(stableStringify(changed), key.privateKey) }, key.publicKey, offer.workerId, offer)).toThrow('POLICY_MISMATCH');
    expect(() => verifyNotice(signed, key.publicKey, offer.workerId, { ...offer, dependencies: [] })).toThrow('BINDING_MISMATCH');
  });
});

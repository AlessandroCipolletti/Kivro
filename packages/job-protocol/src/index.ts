import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JobOfferSchema, JobNoticeSchema, SignedJobNoticeSchema, MAX_JOB_PAUSE_MS, hashManifest, executionManifestProjection, executionManifestHash, validateInput, type ExecutionManifest, type JobOffer, type JobNotice, type SignedJobNotice } from '@kivro/contracts';
import { sha256, signMessage, stableStringify, verifyMessage } from '@kivro/crypto';

export { JobOfferSchema };
export { JobNoticeSchema, SignedJobNoticeSchema };
export type { JobOffer, JobNotice, SignedJobNotice };
export type AuthorizedJobOffer = JobOffer & { maxPauseMs: number };
export type AuthorizedJobNotice = JobNotice & { maxPauseMs: number };
export const PROTOCOL_VERSION = 1;
export const SignedJobOfferSchema = z.object({ payload: JobOfferSchema, signature: z.string().max(128) }).strict();
export type SignedJobOffer = z.infer<typeof SignedJobOfferSchema>;
export const WorkerCommandSchema = z.object({ id: z.string().uuid(), jobId: z.string().uuid().optional(), type: z.enum(['PAUSE_ALL', 'RESUME_ALL', 'PAUSE_JOB', 'RESUME_JOB', 'CANCEL_JOB']), resumeWhilePaused: z.boolean().optional() }).strict()
  .refine(command => !command.resumeWhilePaused || command.type === 'RESUME_JOB' && !!command.jobId, 'Global pause confirmation is limited to one existing job');
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
export const WorkerEventSchema = z.object({ attemptId: z.string().uuid(), type: z.enum(['ACCEPTED', 'RUNNING', 'PAUSED', 'RESUMING', 'FAILED', 'CANCELLED', 'TIMED_OUT']), message: z.string().max(500).optional(), error: z.unknown().optional() });

export function canonicalRequest(method: string, pathname: string, timestamp: string, nonce: string, rawBody: string | Uint8Array = ''): string {
  if (!/^(GET|POST)$/.test(method) || !/^\/api\/worker(?:\/|$)/.test(pathname) || /[?\r\n#]/.test(pathname) || !/^\d{13}$/.test(timestamp) || !z.string().uuid().safeParse(nonce).success) throw new Error('INVALID_REQUEST_SIGNATURE_INPUT');
  return `${method}\n${pathname}\n${timestamp}\n${nonce}\n${sha256(rawBody)}`;
}

export function signedHeaders(workerId: string, privateKey: string, method: 'GET' | 'POST', pathname: string, rawBody: string | Uint8Array = '', now = Date.now()): Record<string, string> {
  const timestamp = String(now), nonce = randomUUID();
  return { 'x-worker-id': workerId, 'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce, 'x-worker-signature': signMessage(canonicalRequest(method, pathname, timestamp, nonce, rawBody), privateKey) };
}

export function verifyRequest(publicKey: string, method: string, pathname: string, rawBody: string | Uint8Array, headers: Record<string, string | undefined>, now = Date.now()): boolean {
  try {
    const stamp = headers['x-worker-timestamp'] ?? '', nonce = headers['x-worker-nonce'] ?? '';
    if (Math.abs(now - Number(stamp)) > 60_000) return false;
    return verifyMessage(canonicalRequest(method, pathname, stamp, nonce, rawBody), headers['x-worker-signature'] ?? '', publicKey);
  } catch { return false; }
}

export const manifestProjection = executionManifestProjection;
export const offerManifestHash = executionManifestHash;
export function signOffer(payload: JobOffer, privateKey: string): SignedJobOffer { return { payload, signature: signMessage(stableStringify(payload), privateKey) }; }
export function verifyNotice(raw: unknown, publicKey: string, workerId: string, local: ExecutionManifest & { capabilityVersionId: string }, now = Date.now()): AuthorizedJobNotice {
  const signed = SignedJobNoticeSchema.parse(raw), notice = signed.payload;
  if (!verifyMessage(stableStringify(notice), signed.signature, publicKey)) throw new Error('INVALID_NOTICE_SIGNATURE');
  if (notice.workerId !== workerId || notice.capabilityVersionId !== local.capabilityVersionId || notice.paymentSecured !== true || notice.manifestHash !== offerManifestHash(local)) throw new Error('NOTICE_BINDING_MISMATCH');
  const expiry = Date.parse(notice.expiresAt);
  if (expiry <= now || expiry > now + 300_000) throw new Error('NOTICE_EXPIRED');
  if (hashManifest(notice.permissions) !== hashManifest(local.permissions) || hashManifest(notice.ioContract) !== hashManifest(local.ioContract) || hashManifest(notice.dependencies) !== hashManifest(local.dependencies)) throw new Error('NOTICE_POLICY_MISMATCH');
  return { ...notice, maxPauseMs: notice.maxPauseMs ?? MAX_JOB_PAUSE_MS };
}
export function verifyAcceptedPayload(raw: unknown, publicKey: string, notice: JobNotice, expectedManifestHash: string): AuthorizedJobOffer {
  const signed = SignedJobOfferSchema.parse(raw);
  if (hashManifest(signed.payload) !== notice.payloadHash) throw new Error('ACCEPTED_PAYLOAD_HASH_MISMATCH');
  for (const key of ['jobId', 'attemptId', 'workerId', 'capabilityVersionId', 'nonce'] as const) if (signed.payload[key] !== notice[key]) throw new Error('ACCEPTED_PAYLOAD_BINDING_MISMATCH');
  if ((signed.payload.maxPauseMs ?? MAX_JOB_PAUSE_MS) !== (notice.maxPauseMs ?? MAX_JOB_PAUSE_MS)) throw new Error('ACCEPTED_PAUSE_BUDGET_MISMATCH');
  return verifyOffer(signed, publicKey, notice.workerId, expectedManifestHash);
}

/** Replay consumption must be committed atomically with local acceptance by the caller. */
export function verifyOffer(raw: unknown, publicKey: string, workerId: string, expectedManifestHash: string, now = Date.now()): AuthorizedJobOffer {
  const signed = SignedJobOfferSchema.parse(raw);
  if (!verifyMessage(stableStringify(signed.payload), signed.signature, publicKey)) throw new Error('INVALID_OFFER_SIGNATURE');
  const offer = signed.payload;
  if (offer.protocolVersion !== PROTOCOL_VERSION || offer.workerId !== workerId || offer.paymentSecured !== true) throw new Error('INVALID_OFFER_BINDING');
  const expiry = Date.parse(offer.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 5 * 60_000) throw new Error('OFFER_EXPIRED_OR_TOO_LONG');
  if (offer.manifestHash !== expectedManifestHash || offerManifestHash(offer) !== expectedManifestHash) throw new Error('MANIFEST_MISMATCH');
  if (Buffer.byteLength(JSON.stringify(offer.input)) > offer.permissions.limits.maxInputBytes) throw new Error('INPUT_TOO_LARGE');
  const input = validateInput(offer.ioContract, offer.input, offer.assets);
  const references = new Set(offer.ioContract.inputs.filter(field => ['FILE', 'FILES'].includes(field.type)).flatMap(field => {
    const value = input[field.key]; return value === undefined ? [] : Array.isArray(value) ? value : [value];
  }));
  if (new Set(offer.assets.map(asset => asset.id)).size !== offer.assets.length || offer.assets.some(asset => !references.has(asset.id))) throw new Error('UNDECLARED_OR_DUPLICATE_INPUT_ASSET');
  return { ...offer, input, maxPauseMs: offer.maxPauseMs ?? MAX_JOB_PAUSE_MS };
}

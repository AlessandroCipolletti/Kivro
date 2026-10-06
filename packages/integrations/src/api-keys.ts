import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const ApiScopeSchema = z.enum(['capabilities:read', 'jobs:create', 'jobs:read', 'assets:create', 'assets:read', 'webhooks:manage']);
export type ApiScope = z.infer<typeof ApiScopeSchema>;
export interface ApiKeyRecord {
  id: string; userId: string; name: string; prefix: string; secretHash: string; scopes: ApiScope[];
  createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null;
}
export interface ApiKeyRepository {
  getById(id: string): Promise<ApiKeyRecord | null>;
  touch(id: string, usedAt: string): Promise<void>;
}
export class IntegrationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'IntegrationError'; }
}
function digest(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }

export function createApiKey(request: { userId: string; name: string; scopes: ApiScope[]; expiresAt?: string }, now = new Date()): { secret: string; record: ApiKeyRecord } {
  const parsed = z.object({ userId: z.string().uuid(), name: z.string().trim().min(1).max(100),
    scopes: z.array(ApiScopeSchema).min(1).max(6), expiresAt: z.string().datetime().optional() }).strict().parse(request);
  if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= now.getTime()) throw new IntegrationError('INVALID_EXPIRY');
  const id = randomUUID(); const secret = `kivro_live_${id}_${randomBytes(32).toString('base64url')}`;
  return { secret, record: { id, userId: parsed.userId, name: parsed.name, prefix: `kivro_live_${id.slice(0, 8)}`,
    secretHash: digest(secret), scopes: [...new Set(parsed.scopes)], createdAt: now.toISOString(),
    expiresAt: parsed.expiresAt ?? null, revokedAt: null, lastUsedAt: null } };
}

export async function authenticateApiKey(secret: string, requiredScopes: readonly ApiScope[], repository: ApiKeyRepository,
  now = new Date()): Promise<{ userId: string; keyId: string; scopes: ApiScope[] }> {
  if (typeof secret !== 'string' || secret.length > 160) throw new IntegrationError('INVALID_API_KEY');
  const match = /^kivro_live_([a-f0-9-]{36})_([A-Za-z0-9_-]{43})$/.exec(secret);
  if (!match || !z.string().uuid().safeParse(match[1]).success) throw new IntegrationError('INVALID_API_KEY');
  const record = await repository.getById(match[1]!);
  const candidateHash = Buffer.from(digest(secret), 'hex');
  const storedHash = record && /^[a-f0-9]{64}$/.test(record.secretHash) ? Buffer.from(record.secretHash, 'hex') : Buffer.alloc(32);
  const valid = timingSafeEqual(candidateHash, storedHash);
  if (!record || record.id !== match[1] || !valid || record.revokedAt ||
    (record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now.getTime()))) {
    throw new IntegrationError('INVALID_API_KEY');
  }
  const scopes = z.array(ApiScopeSchema).parse(record.scopes);
  if (requiredScopes.some(scope => !ApiScopeSchema.safeParse(scope).success || !scopes.includes(scope))) throw new IntegrationError('INSUFFICIENT_SCOPE');
  await repository.touch(record.id, now.toISOString());
  return { userId: record.userId, keyId: record.id, scopes };
}

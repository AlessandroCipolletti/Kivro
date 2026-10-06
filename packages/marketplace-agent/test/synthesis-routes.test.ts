import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgent } from '../../../apps/api/src/agent.js';
// Include the API's Fastify plugin type augmentations without booting its server.
import type {} from '../../../apps/api/src/app.js';
import { MarketplaceAgent } from '../src/agent.js';
import { AgentPolicyError } from '../src/types.js';

afterEach(() => vi.restoreAllMocks());
function setup() {
  const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
  const options = new Map<string, unknown>();
  const register = (method: string) => (path: string, ...args: unknown[]) => {
    handlers.set(`${method} ${path}`, args.at(-1) as (request: unknown) => Promise<unknown>);
    if (args.length > 1) options.set(`${method} ${path}`, args[0]);
  };
  const app = { get: register('GET'), post: register('POST') };
  const query = vi.fn(async () => [{ hits: 1 }]);
  const initializeInferenceRouting = vi.fn(async () => {});
  const ctx = { config: { agentTurnsPerDay: 5 }, db: { $queryRaw: query }, initializeInferenceRouting };
  registerAgent(app as unknown as Parameters<typeof registerAgent>[0], ctx as unknown as Parameters<typeof registerAgent>[1], {});
  // The API's real-database tests cover the routing audit transaction.
  ctx.initializeInferenceRouting = initializeInferenceRouting;
  const userId = randomUUID(); const planId = randomUUID();
  const body = { expectedRevision: 6, sourceManifestHash: 'a'.repeat(64), sourceJobIds: [randomUUID()], consentToProviderProcessing: true };
  const request = { identity: { kind: 'session', user: { id: userId, suspendedAt: null } }, params: { id: planId }, body };
  const preview = handlers.get('GET /api/agent/plans/:id/synthesis-preview')!;
  const synthesize = handlers.get('POST /api/agent/plans/:id/synthesize')!;
  return { preview, synthesize, request, body, userId, planId, query, options, initializeInferenceRouting };
}

describe('synthesis API route bindings', () => {
  it('binds read-only preview to authenticated identity and path, without a turn reservation', async () => {
    const h = setup(); const preview = vi.spyOn(MarketplaceAgent.prototype, 'getSynthesisPreview').mockResolvedValue({ available: false } as never);
    expect(await h.preview(h.request)).toEqual({ available: false });
    expect(preview).toHaveBeenCalledExactlyOnceWith({ planId: h.planId, userId: h.userId });
    expect(h.query).not.toHaveBeenCalled();
    expect(h.initializeInferenceRouting).not.toHaveBeenCalled();
  });
  it('requires authentication and refuses body identity or incomplete consent before processing', async () => {
    const h = setup(); const generate = vi.spyOn(MarketplaceAgent.prototype, 'synthesize');
    await expect(h.synthesize({ ...h.request, identity: undefined })).rejects.toMatchObject({ statusCode: 401 });
    for (const body of [{ consentToProviderProcessing: true }, { ...h.body, consentToProviderProcessing: false },
      { ...h.body, sourceJobIds: [] }, { ...h.body, userId: randomUUID() }]) {
      await expect(h.synthesize({ ...h.request, body })).rejects.toThrow();
    }
    expect(generate).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
    expect(h.initializeInferenceRouting).not.toHaveBeenCalled();
  });
  it('preserves the exact reviewed source/revision body, shares the daily turn gate and never auto-retries', async () => {
    const h = setup(); const generate = vi.spyOn(MarketplaceAgent.prototype, 'synthesize').mockRejectedValue(new AgentPolicyError('SYNTHESIS_CONSENT_STALE'));
    await expect(h.synthesize(h.request)).rejects.toMatchObject({ statusCode: 409, code: 'SYNTHESIS_CONSENT_STALE' });
    expect(generate).toHaveBeenCalledExactlyOnceWith({ ...h.body, planId: h.planId, userId: h.userId });
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.initializeInferenceRouting).toHaveBeenCalledTimes(1);
    expect(h.options.get('POST /api/agent/plans/:id/synthesize')).toEqual({ config: { rateLimit: { max: 5, timeWindow: '1 minute' } } });
  });
  it('denies inference when the durable turn limit is exhausted', async () => {
    const h = setup(); h.query.mockResolvedValue([]);
    const generate = vi.spyOn(MarketplaceAgent.prototype, 'synthesize');
    await expect(h.synthesize(h.request)).rejects.toMatchObject({ statusCode: 429, code: 'ACCOUNT_LIMIT' });
    expect(generate).not.toHaveBeenCalled();
    expect(h.initializeInferenceRouting).toHaveBeenCalledTimes(1);
  });
});

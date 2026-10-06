import { z } from 'zod';
import type { ResearchBroker, ResearchContext } from './broker.js';
import type { ConnectorRegistry } from './connectors.js';
import { NetworkPolicyError } from './egress.js';
import { PublicResearchReferenceSchema, type CompiledPublicResearchPlan } from './public-requests.js';

/** Bind only after authenticating a worker's active job/attempt. authorize() still runs per call. */
export function bindJobResearchTools(broker: ResearchBroker, context: ResearchContext, connectors?: ConnectorRegistry) {
  const bound = Object.freeze(z.object({ userId: z.string().uuid(), jobId: z.string().uuid(), capabilityVersionId: z.string().uuid(), attemptId: z.string().uuid().optional() }).strict().parse(context));
  return Object.freeze({
    search: (args: unknown) => broker.search(bound, args),
    fetch: (args: unknown) => broker.fetch(bound, args),
    searchPublic: (args: unknown) => broker.searchPublic(bound, args),
    fetchPublic: (args: unknown) => broker.fetchPublic(bound, args),
    connector: (id: string, args: unknown) => {
      if (!connectors) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
      return connectors.execute(bound, id, args);
    },
  });
}

/** Trusted host prelude: run the fixed sequence before inference/private access.
 * Give the private model only these cache lookups, never the broker's outbound methods. */
export async function prefetchPublicResearchTools(options: {
  broker: ResearchBroker; context: ResearchContext; plan: CompiledPublicResearchPlan; assertActive(): Promise<void>;
}) {
  const searches = new Map<string, Awaited<ReturnType<ResearchBroker['searchPublic']>>>();
  const pages = new Map<string, Awaited<ReturnType<ResearchBroker['fetchPublic']>>>();
  const tools = bindJobResearchTools(options.broker, options.context);
  for (const reviewedSourceId of options.plan.searchSourceIds) {
    await options.assertActive(); searches.set(reviewedSourceId, await tools.searchPublic({ reviewedSourceId }));
  }
  for (const reviewedSourceId of options.plan.fetchSourceIds) {
    await options.assertActive(); pages.set(reviewedSourceId, await tools.fetchPublic({ reviewedSourceId }));
  }
  async function cached<T>(records: Map<string, T>, raw: unknown): Promise<T> {
    await options.assertActive();
    const { reviewedSourceId } = PublicResearchReferenceSchema.parse(raw);
    if (!records.has(reviewedSourceId)) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    return structuredClone(records.get(reviewedSourceId)!);
  }
  return Object.freeze({ searchPublic: (raw: unknown) => cached(searches, raw), fetchPublic: (raw: unknown) => cached(pages, raw) });
}

const OperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('search'), args: z.unknown(), attemptId: z.string().uuid().optional() }).strict(),
  z.object({ operation: z.literal('fetch'), args: z.unknown(), attemptId: z.string().uuid().optional() }).strict(),
  z.object({ operation: z.literal('searchPublic'), args: z.unknown(), attemptId: z.string().uuid().optional() }).strict(),
  z.object({ operation: z.literal('fetchPublic'), args: z.unknown(), attemptId: z.string().uuid().optional() }).strict(),
  z.object({ operation: z.literal('connector'), connectorId: z.string().min(1).max(80), args: z.unknown(), attemptId: z.string().uuid().optional() }).strict(),
]);

/** Fastify-compatible adapter without taking a Fastify dependency. */
export function createResearchRequestHandler<Request>(options: {
  broker: ResearchBroker; connectors?: ConnectorRegistry;
  authenticateActiveJob(request: Request): Promise<ResearchContext>;
}) {
  return async (request: Request, body: unknown): Promise<unknown> => {
    const context = await options.authenticateActiveJob(request);
    const tools = bindJobResearchTools(options.broker, context, options.connectors);
    const command = OperationSchema.parse(body);
    if (command.operation === 'search') return tools.search(command.args);
    if (command.operation === 'fetch') return tools.fetch(command.args);
    if (command.operation === 'searchPublic') return tools.searchPublic(command.args);
    if (command.operation === 'fetchPublic') return tools.fetchPublic(command.args);
    return tools.connector(command.connectorId, command.args);
  };
}

const SourceSchema = z.object({ url: z.string().url(), title: z.string().max(300), snippet: z.string().max(2000),
  accessedAt: z.string().datetime(), untrusted: z.literal(true) }).strict();
const PageSchema = z.object({ finalUrl: z.string().url(), title: z.string().max(300).optional(), text: z.string().max(5_000_000),
  contentType: z.string(), fetchedAt: z.string().datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(0).max(5_000_000), untrusted: z.literal(true) }).strict();

/** send must be a pre-bound, signed WorkerTransport request to the marketplace API. */
export function createRemoteResearchTools(send: (command: { operation: 'search' | 'fetch'; args: unknown }) => Promise<unknown>) {
  return Object.freeze({
    search: async (args: unknown) => z.array(SourceSchema).max(20).parse(await send({ operation: 'search', args })),
    fetch: async (args: unknown) => PageSchema.parse(await send({ operation: 'fetch', args })),
  });
}

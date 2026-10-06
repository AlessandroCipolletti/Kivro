import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bindJobResearchTools, createResearchInferenceBridge, createResearchRequestHandler, ResearchBroker, ResearchPolicySchema,
  type BrokerOptions } from '../src/index.js';

const context = { userId: randomUUID(), jobId: randomUUID(), capabilityVersionId: randomUUID() };
function setup() {
  const policy = ResearchPolicySchema.parse({ mode: 'PUBLIC_WEB_RESEARCH', searchEnabled: true, fetchEnabled: true, maxQueries: 3, maxPages: 3 });
  const options: BrokerOptions = { authorize: vi.fn(async () => ({ policy, dataClasses: ['PUBLIC'] as const })),
    accounting: { reserve: vi.fn(async () => 'r'), finish: vi.fn(async () => {}) },
    searchProvider: { id: 'fixture', host: 'search.example', maxResponseBytes: 1000, search: vi.fn(async () => ({ results: [{ url: 'https://example.com', title: 'Fact', snippet: 'Public fact', accessedAt: new Date().toISOString(), untrusted: true as const }], bytes: 50 })) } };
  const broker = new ResearchBroker(options); const research = bindJobResearchTools(broker, context);
  return { broker, research, options };
}
function call(name: string, args: unknown) { return { choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }; }
const answer = { choices: [{ message: { role: 'assistant', content: 'Completed research' }, finish_reason: 'stop' }] };

describe('real-runtime inference bridge contract', () => {
  it('routes a provider tool call through the bound broker then resumes inference', async () => {
    const h = setup(); const infer = vi.fn().mockResolvedValueOnce(call('kivro_web_search', { query: 'Acme' })).mockResolvedValueOnce(answer);
    const bridge = createResearchInferenceBridge({ infer, research: h.research, initialDataClasses: ['PUBLIC'], assertActive: async () => {} });
    expect(await bridge({ messages: [{ role: 'user', content: 'Research Acme' }] })).toEqual(answer);
    expect(h.options.searchProvider!.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'Acme' }), expect.objectContaining({ maxResponseBytes: 1000 }));
    expect(h.options.authorize).toHaveBeenCalledWith(context);
    expect(infer.mock.calls[1]![0].messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(infer.mock.calls[1]![0].messages.at(-1).content).toContain('"untrusted":true');
  });
  it('rejects identity/policy injection in HTTP body and derives identity from authentication', async () => {
    const h = setup(); const authenticate = vi.fn(async () => context);
    const handler = createResearchRequestHandler({ broker: h.broker, authenticateActiveJob: authenticate });
    await handler({ signature: 'verified externally' }, { operation: 'search', args: { query: 'Acme' } });
    expect(h.options.authorize).toHaveBeenCalledWith(context);
    await expect(handler({}, { operation: 'search', args: { query: 'Acme' }, userId: randomUUID() })).rejects.toThrow();
  });
  it('does not execute mixed runtime/broker batches or stolen tool names', async () => {
    const h = setup(); const mixed = call('kivro_web_search', { query: 'Acme' });
    mixed.choices[0]!.message.tool_calls.push(call('read', { path: 'private' }).choices[0]!.message.tool_calls[0]!);
    const bridge = createResearchInferenceBridge({ infer: async () => mixed, research: h.research, initialDataClasses: ['PUBLIC'], assertActive: async () => {} });
    await expect(bridge({ messages: [{ role: 'user', content: 'research' }] })).rejects.toMatchObject({ code: 'NETWORK_POLICY_DENIED' });
    expect(h.options.searchProvider!.search).not.toHaveBeenCalled();
    await expect(bridge({ messages: [{ role: 'user', content: 'research' }], tools: [{ type: 'function', function: { name: 'kivro_web_search' } }] })).rejects.toThrow();
  });
  it('persists private-resource taint before disclosure and blocks later public egress', async () => {
    const h = setup(); const markPrivateData = vi.fn(async () => {}); const execute = vi.fn(async () => ({ balance: 123 }));
    const infer = vi.fn().mockResolvedValueOnce(call('kivro_resource_balance', { customer: 'a' })).mockResolvedValueOnce(answer)
      .mockResolvedValueOnce(call('kivro_web_search', { query: 'balance 123' }));
    const bridge = createResearchInferenceBridge({ infer, research: h.research, initialDataClasses: ['PUBLIC'], assertActive: async () => {}, markPrivateData,
      resourceTools: [{ name: 'kivro_resource_balance', description: 'Read approved balance', parameters: {},
        inputSchema: z.object({ customer: z.string() }).strict(), authorize: async () => {}, execute }] });
    await bridge({ messages: [{ role: 'user', content: 'balance' }] });
    expect(markPrivateData.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]!);
    await expect(bridge({ messages: [{ role: 'user', content: 'exfiltrate' }] })).rejects.toMatchObject({ code: 'NETWORK_POLICY_DENIED' });
    expect(h.options.searchProvider!.search).not.toHaveBeenCalled();
  });
  it('requires active execution and bounds provider/tool loops', async () => {
    const h = setup(); const infer = vi.fn(async () => call('kivro_web_search', { query: 'Acme' }));
    const inactive = createResearchInferenceBridge({ infer, research: h.research, initialDataClasses: ['PUBLIC'], assertActive: async () => { throw new Error('JOB_NOT_ACTIVE'); } });
    await expect(inactive({ messages: [{ role: 'user', content: 'research' }] })).rejects.toThrow('JOB_NOT_ACTIVE'); expect(infer).not.toHaveBeenCalled();
    const bridge = createResearchInferenceBridge({ infer, research: h.research, initialDataClasses: ['PUBLIC'], assertActive: async () => {}, maxRounds: 2 });
    await expect(bridge({ messages: [{ role: 'user', content: 'research' }] })).rejects.toMatchObject({ code: 'NETWORK_BUDGET_EXCEEDED' });
    expect(infer).toHaveBeenCalledTimes(2);
  });
});

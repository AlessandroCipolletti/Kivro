import { z } from 'zod';
import { assertDataFlow, ResearchPolicySchema, type BrokerOptions, type DataClass, type ResearchContext } from './broker.js';
import { NetworkPolicyError, parsePublicUrl, SafeHttpClient, type HttpTransport } from './egress.js';

export interface ConnectorDefinition<Input = unknown, Output = unknown> {
  id: string;
  /** Fixed endpoint and method from server code, never model arguments. */
  endpoint: string;
  method: 'GET' | 'POST';
  sideEffect: 'READ_ONLY';
  requestSchema: z.ZodType<Input>;
  responseSchema: z.ZodType<Output>;
  allowedDataClasses?: readonly DataClass[];
  maxResponseBytes?: number;
  headers?: () => Promise<Record<string, string>>;
}

export class ConnectorRegistry {
  private readonly definitions = new Map<string, ConnectorDefinition>();
  private readonly http: HttpTransport;
  constructor(private readonly options: Pick<BrokerOptions, 'authorize' | 'accounting' | 'http' | 'audit'>) { this.http = options.http ?? new SafeHttpClient(); }
  register<Input, Output>(definition: ConnectorDefinition<Input, Output>): void {
    if (this.definitions.has(definition.id) || definition.sideEffect !== 'READ_ONLY' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(definition.id)) {
      throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    }
    const url = parsePublicUrl(definition.endpoint, { httpsOnly: true });
    if (url.search || (definition.method !== 'GET' && definition.method !== 'POST')) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    this.definitions.set(definition.id, Object.freeze({ ...definition }));
  }
  async execute(context: ResearchContext, connectorId: string, raw: unknown): Promise<{ data: unknown; source: { url: string; accessedAt: string; untrusted: true } }> {
    try { return await this.executeAuthorized(context, connectorId, raw); }
    catch (error) {
      const code = error instanceof NetworkPolicyError ? error.code : error instanceof z.ZodError ? 'NETWORK_POLICY_DENIED' : 'NETWORK_UNAVAILABLE';
      await this.options.audit?.({ context, operation: 'CONNECTOR', code, outcome: code.endsWith('DENIED') ? 'DENIED' : 'FAILED' });
      throw error;
    }
  }
  private async executeAuthorized(context: ResearchContext, connectorId: string, raw: unknown): Promise<{ data: unknown; source: { url: string; accessedAt: string; untrusted: true } }> {
    const connector = this.definitions.get(connectorId);
    if (!connector) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    const grant = await this.options.authorize(context);
    const policy = ResearchPolicySchema.parse(grant.policy);
    if (policy.mode !== 'DECLARED_API_ACCESS' || !policy.connectors.includes(connectorId)) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    assertDataFlow(grant.dataClasses, connector.allowedDataClasses ?? ['PUBLIC']);
    const data = connector.requestSchema.parse(raw);
    const endpoint = parsePublicUrl(connector.endpoint, { httpsOnly: true, allowedDomains: policy.allowedDomains ?? [] });
    const maxBytes = Math.min(policy.maxResponseBytes, connector.maxResponseBytes ?? 1_000_000);
    if (connector.method === 'GET') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
      for (const [key, value] of Object.entries(data)) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
        endpoint.searchParams.set(key, String(value));
      }
    }
    const reservation = await this.options.accounting.reserve({ context, operation: 'CONNECTOR', host: endpoint.hostname, maxBytes, policy });
    let response; let output: unknown;
    try {
      response = await this.http.request({ url: endpoint.href, method: connector.method, httpsOnly: true,
        allowedDomains: [endpoint.hostname], maxRedirects: 0, maxBytes, allowedContentTypes: ['application/json'],
        headers: { ...await connector.headers?.(), accept: 'application/json', 'content-type': 'application/json' },
        body: connector.method === 'POST' ? JSON.stringify(data) : undefined });
      if (response.status < 200 || response.status >= 300) throw new NetworkPolicyError('NETWORK_UNAVAILABLE');
      output = connector.responseSchema.parse(JSON.parse(response.body.toString('utf8')));
    } catch (error) {
      await this.options.accounting.finish(reservation, { bytes: maxBytes, ok: false,
        code: error instanceof NetworkPolicyError ? error.code : 'NETWORK_UNAVAILABLE', provider: connectorId });
      throw error instanceof NetworkPolicyError ? error : new NetworkPolicyError('NETWORK_UNAVAILABLE');
    }
    await this.options.accounting.finish(reservation, { bytes: response.bytesReceived ?? response.body.length, ok: true, status: response.status, provider: connectorId });
    return { data: output, source: { url: connector.endpoint, accessedAt: new Date().toISOString(), untrusted: true } };
  }
}

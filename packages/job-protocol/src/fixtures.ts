import { randomUUID } from 'node:crypto';
import { executionManifestHash, MAX_JOB_PAUSE_MS } from '@kivro/contracts';
import type { AuthorizedJobOffer } from './index.ts';

export function fixtureOffer(): AuthorizedJobOffer {
  const offer: AuthorizedJobOffer = {
    protocolVersion: 1, jobId: randomUUID(), attemptId: randomUUID(), workerId: randomUUID(), capabilityVersionId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(), paymentSecured: true, nonce: randomUUID(), manifestHash: '0'.repeat(64),
    maxPauseMs: MAX_JOB_PAUSE_MS, input: { marker: 'untrusted marker' }, ioContract: { schemaVersion: 1, inputs: [{ key: 'marker', label: 'Marker', type: 'SHORT_TEXT', required: true, order: 0 }], output: { type: 'TEXT', required: true, description: 'Echo marker' } },
    permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference' }, limits: { timeoutSeconds: 60, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1048576, maxOutputBytes: 1048576, maxTokens: 64000 } },
    dependencies: [
      { id: 'inference', name: 'Test inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', dependsOn: ['credential'], grants: { inferenceProviders: ['openai-compatible'] } },
      { id: 'credential', name: 'Dedicated key', type: 'CREDENTIAL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', dependsOn: [], grants: { credentialRefs: ['seller-inference'] } },
    ], internalInstructions: 'Return the marker only.', assets: [],
  };
  offer.manifestHash = executionManifestHash(offer); return offer;
}

import { z } from 'zod';
import { hashManifest } from '@kivro/contracts';
import { testResearchScanner, RESEARCH_DOWNLOAD_POLICY_VERSION, type ResearchScanner } from '@kivro/openclaw-adapter';
import type { WorkerState } from './state.ts';
import type { LocalCapability } from './capabilities.ts';

export const ResearchScannerSchema = z.object({ schemaVersion: z.literal(1), host: z.enum(['127.0.0.1', '::1']), port: z.number().int().min(1).max(65535) }).strict();
export function selectedResearchScanner(state: WorkerState): ResearchScanner {
  const parsed = ResearchScannerSchema.safeParse(state.get('researchScanner'));
  if (!parsed.success) throw new Error('RESEARCH_SCANNER_CONFIGURATION_REQUIRED');
  const proof = state.get<{ configHash: string; testedAt: number }>('researchScannerProof');
  if (!proof || proof.configHash !== hashManifest(parsed.data) || proof.testedAt > Date.now() || Date.now() - proof.testedAt > 3600000) throw new Error('RESEARCH_SCANNER_TEST_REQUIRED');
  return parsed.data;
}
export function approveResearchScanner(state: WorkerState, raw: unknown, approval?: string) {
  const config = ResearchScannerSchema.parse(raw), approvalHash = hashManifest(config);
  if (approval !== approvalHash) return { approved: false, config, approvalHash, consent: 'Send quarantined public research bytes only to this dedicated local ClamAV scanner. Downloads fail closed without a recent clean/EICAR self-test and a clean per-file verdict.' };
  state.transaction(() => {
    state.set('researchScanner', config); state.delete('researchScannerProof');
    for (const id of state.get<string[]>('capabilityIds') ?? []) if (state.get<LocalCapability>(`capability:${id}`)?.permissions.network.downloads) {
      state.delete(`capabilityProof:${id}`); state.delete(`capabilityHealth:${id}`); state.set(`revalidationRequired:${id}`, true);
    }
    state.audit('RESEARCH_SCANNER_CONSENT', 'LOCAL');
  });
  return { approved: true, approvalHash, next: 'research scanner-test' };
}
export async function verifyResearchScanner(state: WorkerState, signal?: AbortSignal): Promise<void> {
  const config = ResearchScannerSchema.parse(state.get('researchScanner')); state.delete('researchScannerProof');
  await testResearchScanner(config, signal);
  state.set('researchScannerProof', { configHash: hashManifest(config), testedAt: Date.now(), policyVersion: RESEARCH_DOWNLOAD_POLICY_VERSION });
  state.audit('RESEARCH_SCANNER_SELF_TEST_PASSED', 'LOCAL');
}

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fixtureOffer } from '../../job-protocol/src/fixtures.ts';
import { OpenClawAdapter, DockerSandbox } from './index.ts';

describe('isolated OpenClaw execution trace', () => {
  it('stages only the immutable job/attempt UUIDs as trace metadata, separately from buyer content', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-correlation-'))), offer = fixtureOffer();
    try {
      const env = await new OpenClawAdapter().buildWorkerEnvironment(root, offer);
      const request = JSON.parse(await readFile(join(env.inputDir, 'request.json'), 'utf8'));
      expect(request).toMatchObject({ correlationId: offer.jobId, attemptId: offer.attemptId });
      expect(JSON.stringify(request)).not.toContain('untrusted marker');
      expect(JSON.stringify(request)).not.toContain('seller-inference');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['correct', 'legacy', 'wrong-job', 'wrong-attempt', 'partial'] as const)('checks runner trace binding: %s', async mode => {
    const offer = fixtureOffer(), docker = new DockerSandbox();
    const trace = mode === 'legacy' ? {} : { correlationId: mode === 'wrong-job' ? randomUUID() : offer.jobId,
      ...(mode === 'partial' ? {} : { attemptId: mode === 'wrong-attempt' ? randomUUID() : offer.attemptId }) };
    vi.spyOn(docker, 'execute').mockImplementation(async (_spec, onFrame) => {
      await onFrame({ type: 'started', version: 'Synthetic runner', ...trace });
      await onFrame({ type: 'result', text: 'Synthetic output', files: [] });
    });
    const execution = new OpenClawAdapter(docker).execute({ name: `kivro-job-${offer.attemptId}`, attemptId: offer.attemptId,
      owner: offer.workerId, imageId: `sha256:${'a'.repeat(64)}`, limits: offer.permissions.limits }, offer, async () => ({}), new AbortController().signal, async () => {});
    if (mode === 'correct' || mode === 'legacy') await expect(execution).resolves.toMatchObject({ text: 'Synthetic output' });
    else await expect(execution).rejects.toThrow('EXECUTION_CORRELATION_MISMATCH');
  });
});

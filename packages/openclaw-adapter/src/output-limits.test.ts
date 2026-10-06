import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureOffer } from '../../job-protocol/src/fixtures.ts';
import { DockerSandbox, OpenClawAdapter } from './index.ts';

beforeEach(() => {
  for (const key of ['MAX_UPLOAD_BYTES', 'KIVRO_MAX_JOB_FILE_BYTES', 'KIVRO_MAX_JOB_INPUT_BYTES', 'KIVRO_MAX_JOB_OUTPUT_BYTES']) vi.stubEnv(key, undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fixture(text: string, fileData?: string) {
  const offer = fixtureOffer(), docker = new DockerSandbox();
  offer.ioContract.output = { type: 'MIXED', description: 'Result', required: true, files: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFiles: 1, maxTotalSizeBytes: 1000 } };
  const execute = vi.spyOn(docker, 'execute').mockImplementation(async (_spec, onFrame) => {
    await onFrame({ type: 'started', version: 'Synthetic runner' });
    await onFrame({ type: 'result', text, files: fileData === undefined ? [] : [{ path: 'answer.txt', sizeBytes: Buffer.byteLength(fileData), data: Buffer.from(fileData).toString('base64') }] });
  });
  const run = () => new OpenClawAdapter(docker).execute({ name: `kivro-job-${offer.attemptId}`, attemptId: offer.attemptId, owner: offer.workerId, imageId: `sha256:${'a'.repeat(64)}`, limits: offer.permissions.limits }, offer, async () => ({}), new AbortController().signal, async () => {});
  return { offer, execute, run };
}

describe('effective result-frame byte budget', () => {
  it('counts UTF-8 bytes against a lower local ceiling before accepting text', async () => {
    vi.stubEnv('KIVRO_MAX_JOB_OUTPUT_BYTES', '5');
    const context = fixture('\u00e9'.repeat(3)), before = JSON.stringify(context.offer);
    await expect(context.run()).rejects.toThrow('INVALID_RESULT_STATE_OR_SIZE');
    expect(JSON.stringify(context.offer)).toBe(before);
  });
  it('shares the exact remaining byte budget with result files', async () => {
    vi.stubEnv('KIVRO_MAX_JOB_OUTPUT_BYTES', '8');
    const context = fixture('\u00e9\u00e9', 'okay'), before = JSON.stringify(context.offer);
    const result = await context.run();
    expect(result.text).toBe('\u00e9\u00e9'); expect(result.files[0]?.data.toString()).toBe('okay');
    expect(JSON.stringify(context.offer)).toBe(before);
    await expect(fixture('\u00e9\u00e9', 'extra').run()).rejects.toThrow('OUTPUT_BYTE_LIMIT');
  });
  it('accepts text at the exact limit with no file budget remaining', async () => {
    vi.stubEnv('KIVRO_MAX_JOB_OUTPUT_BYTES', '4');
    await expect(fixture('okay').run()).resolves.toMatchObject({ text: 'okay', files: [] });
    await expect(fixture('okay', 'x').run()).rejects.toThrow();
  });
  it('never raises a lower signed seller limit', async () => {
    vi.stubEnv('KIVRO_MAX_JOB_OUTPUT_BYTES', '2048');
    const context = fixture('a'.repeat(1025)); context.offer.permissions.limits.maxOutputBytes = 1024;
    await expect(context.run()).rejects.toThrow('INVALID_RESULT_STATE_OR_SIZE');
    expect(context.offer.permissions.limits.maxOutputBytes).toBe(1024);
  });
  it.each(['0', 'not-a-number', String(16 * 1024 ** 2 + 1)])('rejects invalid local configuration before execution: %s', async value => {
    vi.stubEnv('KIVRO_MAX_JOB_OUTPUT_BYTES', value); const context = fixture('okay');
    await expect(context.run()).rejects.toThrow(); expect(context.execute).not.toHaveBeenCalled();
  });
});

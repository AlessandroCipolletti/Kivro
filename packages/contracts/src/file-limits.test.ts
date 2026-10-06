import { describe, expect, it } from 'vitest';
import { DEFAULT_FILE_LIMITS, FILE_SAFETY_CEILINGS, ExecutionFileLimitsSchema, effectiveFileLimit, readFileLimits } from './file-limits.ts';

describe('central file ceilings', () => {
  it('uses stable reviewed defaults without consulting ambient browser state', () => {
    expect(readFileLimits({})).toEqual(DEFAULT_FILE_LIMITS);
    expect(FILE_SAFETY_CEILINGS.workerFileBytes).toBe(8388608);
  });
  it('bounds the public effective-limit projection and rejects extra configuration fields', () => {
    const limits = { singleFileBytes: 1, inputBytes: 2, outputBytes: 3 };
    expect(ExecutionFileLimitsSchema.parse(limits)).toEqual(limits);
    expect(ExecutionFileLimitsSchema.safeParse({ ...limits, singleFileBytes: FILE_SAFETY_CEILINGS.workerFileBytes + 1 }).success).toBe(false);
    expect(ExecutionFileLimitsSchema.safeParse({ ...limits, inputBytes: Infinity }).success).toBe(false);
    expect(ExecutionFileLimitsSchema.safeParse({ ...limits, secret: 'not-a-public-field' }).success).toBe(false);
  });
  it('accepts only bounded deployment reductions independently for each boundary', () => {
    expect(readFileLimits({ MAX_UPLOAD_BYTES: '100', KIVRO_MAX_JOB_FILE_BYTES: '50', KIVRO_MAX_JOB_INPUT_BYTES: '60', KIVRO_MAX_JOB_OUTPUT_BYTES: '70' }))
      .toEqual({ uploadBytes: 100, workerFileBytes: 50, inputBytes: 60, outputBytes: 70 });
    for (const [key, maximum] of Object.entries({ MAX_UPLOAD_BYTES: FILE_SAFETY_CEILINGS.singleFileBytes,
      KIVRO_MAX_JOB_FILE_BYTES: FILE_SAFETY_CEILINGS.workerFileBytes, KIVRO_MAX_JOB_INPUT_BYTES: FILE_SAFETY_CEILINGS.workerInputBytes,
      KIVRO_MAX_JOB_OUTPUT_BYTES: FILE_SAFETY_CEILINGS.workerOutputBytes })) {
      for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', String(maximum + 1)]) expect(() => readFileLimits({ [key]: value })).toThrow();
      expect(() => readFileLimits({ [key]: String(maximum) })).not.toThrow();
    }
  });
  it('seller limits may only narrow the effective ceiling and malformed numbers never bypass it', () => {
    expect(effectiveFileLimit(100, 500, undefined, 50)).toBe(50);
    expect(effectiveFileLimit(100, 500)).toBe(100);
    for (const value of [0, -1, NaN, Infinity, 1.5]) expect(() => effectiveFileLimit(100, value)).toThrow('INVALID_FILE_LIMIT');
  });
});

import { z } from 'zod';

// Reviewed implementation bounds. Deployment settings may lower, never raise them.
export const FILE_SAFETY_CEILINGS = Object.freeze({
  singleFileBytes: 100 * 1024 ** 2, totalBytes: 250 * 1024 ** 2,
  workerFileBytes: 8 * 1024 ** 2, workerInputBytes: 16 * 1024 ** 2,
  workerOutputBytes: 16 * 1024 ** 2, maxFiles: 20,
});
export const DEFAULT_FILE_LIMITS = Object.freeze({
  uploadBytes: 25 * 1024 ** 2, workerFileBytes: FILE_SAFETY_CEILINGS.workerFileBytes,
  inputBytes: FILE_SAFETY_CEILINGS.workerInputBytes, outputBytes: FILE_SAFETY_CEILINGS.workerOutputBytes,
});
export type FileLimits = { -readonly [Key in keyof typeof DEFAULT_FILE_LIMITS]: number };
export const ExecutionFileLimitsSchema = z.object({
  singleFileBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.workerFileBytes),
  inputBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.workerInputBytes),
  outputBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.workerOutputBytes),
}).strict();
export function readFileLimits(env: Readonly<Record<string, string | undefined>>): FileLimits {
  const limit = (key: string, fallback: number, maximum: number) => z.coerce.number().finite().int().positive().max(maximum).parse(env[key] ?? fallback);
  return {
    uploadBytes: limit('MAX_UPLOAD_BYTES', DEFAULT_FILE_LIMITS.uploadBytes, FILE_SAFETY_CEILINGS.singleFileBytes),
    workerFileBytes: limit('KIVRO_MAX_JOB_FILE_BYTES', DEFAULT_FILE_LIMITS.workerFileBytes, FILE_SAFETY_CEILINGS.workerFileBytes),
    inputBytes: limit('KIVRO_MAX_JOB_INPUT_BYTES', DEFAULT_FILE_LIMITS.inputBytes, FILE_SAFETY_CEILINGS.workerInputBytes),
    outputBytes: limit('KIVRO_MAX_JOB_OUTPUT_BYTES', DEFAULT_FILE_LIMITS.outputBytes, FILE_SAFETY_CEILINGS.workerOutputBytes),
  };
}
export function effectiveFileLimit(platformLimit: number, ...sellerLimits: (number | undefined)[]): number {
  const values = [platformLimit, ...sellerLimits.filter((value): value is number => value !== undefined)];
  if (values.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('INVALID_FILE_LIMIT');
  return Math.min(...values);
}

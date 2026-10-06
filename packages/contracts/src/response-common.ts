import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoDate = z.string().datetime({ offset: true });
export const money = z.number().int().safe();
export const count = z.number().int().nonnegative().safe();
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(jsonValue),
]));
export const jsonObject = z.record(jsonValue);
export const okResponseSchema = z.object({ ok: z.literal(true) }).strict();
export const errorResponseSchema = z.object({ error: z.object({
  code: z.string().min(1).max(200), message: z.string().max(20_000), details: jsonValue.optional(),
}).strict() }).strict();
export interface ResponseRoute { method: string; path: string; schema: z.ZodTypeAny }
export function responseRoutes(method: string, paths: string[], schema: z.ZodTypeAny): ResponseRoute[] {
  return paths.map(path => ({ method, path, schema }));
}

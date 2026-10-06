export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function requireValue<T>(value: T | null | undefined, code = 'NOT_FOUND', message = 'Resource not found'): T {
  if (value === null || value === undefined) throw new ApiError(404, code, message);
  return value;
}

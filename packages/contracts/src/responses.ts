import { z } from 'zod';
import { accountResponseRoutes, readyResponseSchema } from './response-account.ts';
import { catalogResponseRoutes } from './response-catalog.ts';
import { agentResponseRoutes } from './response-agent.ts';
import { billingResponseRoutes } from './response-billing.ts';
import { workerResponseRoutes } from './response-worker.ts';
import { operationsResponseRoutes } from './response-operations.ts';
import { errorResponseSchema } from './response-common.ts';

export { errorResponseSchema } from './response-common.ts';
export { sellerCapabilityLiveStateSchema, type SellerCapabilityLiveState } from './response-catalog.ts';
export * from './response-agent.ts';
export * from './response-worker.ts';
export * from './response-billing.ts';
export * from './response-operations.ts';
export const API_RESPONSE_ROUTES = [...accountResponseRoutes, ...catalogResponseRoutes, ...agentResponseRoutes, ...billingResponseRoutes, ...workerResponseRoutes, ...operationsResponseRoutes];
const filePaths = ['/api/assets/:id/download', '/api/worker/assets/:id/download', '/api/capabilities/:id/examples/:exampleId/assets/:assetId'];
const normalize = (path: string) => new URL(path, 'http://response.invalid').pathname.replace(/^\/api\/v1\//, '/api/');
const routePattern = (path: string) => new RegExp(`^${path.split('/').map(part => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`);
const routes = API_RESPONSE_ROUTES.map(route => ({ ...route, pattern: routePattern(route.path) }))
  .sort((a, b) => a.path.split('/').filter(part => part.startsWith(':')).length - b.path.split('/').filter(part => part.startsWith(':')).length);
const filePatterns = filePaths.map(routePattern);

export function isFileResponse(method: string, path: string): boolean {
  return ['GET', 'HEAD'].includes(method.toUpperCase()) && filePatterns.some(pattern => pattern.test(normalize(path)));
}

export function apiResponseSchema(method: string, path: string): z.ZodTypeAny | undefined {
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase(), pathname = normalize(path);
  return routes.find(route => route.method === verb && route.pattern.test(pathname))?.schema;
}

export class ResponseContractError extends Error {
  constructor() { super('The service returned an invalid response.'); this.name = 'ResponseContractError'; }
}

/** Validate serialized wire data, never credentials, ORM records or TypeScript casts. */
export function parseApiResponse(method: string, path: string, status: number, value: unknown): unknown {
  const readiness = ['GET', 'HEAD'].includes(method.toUpperCase()) && ['/ready', '/health/ready', '/api/ready'].includes(normalize(path));
  const schema = status >= 400 ? readiness && status === 503 ? z.union([readyResponseSchema, errorResponseSchema]) : errorResponseSchema
    : apiResponseSchema(method, path);
  if (!schema) throw new ResponseContractError();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ResponseContractError();
  return parsed.data;
}

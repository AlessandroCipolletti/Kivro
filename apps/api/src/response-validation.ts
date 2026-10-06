import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiResponseSchema, isFileResponse, parseApiResponse } from '@kivro/contracts/responses';
import { ApiError } from './errors.js';

// Fastify intersects inferred route config types. Validate this extension at
// registration instead of intersecting Zod's polymorphic instance methods.
declare module 'fastify' { interface FastifyContextConfig { responseContract?: unknown } }

export function registerResponseValidation(app: FastifyInstance) {
  app.addHook('onRoute', route => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method === 'OPTIONS' || isFileResponse(method, route.url) || apiResponseSchema(method, route.url) || route.config?.responseContract instanceof z.ZodType) continue;
      throw new Error(`RESPONSE_SCHEMA_MISSING: ${method} ${route.url}`);
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'OPTIONS') return payload;
    const path = request.routeOptions.url ?? request.url;
    if (isFileResponse(request.method, path) && (reply.statusCode < 400 || reply.statusCode === 416 && !payload)) return payload;
    // Fastify may suppress a HEAD body before this hook; GET validates its DTO.
    if (request.method === 'HEAD' && !payload) return payload;
    try {
      if (typeof payload !== 'string') throw new Error('JSON response required');
      const value: unknown = JSON.parse(payload);
      const local = request.routeOptions.config.responseContract;
      if (reply.statusCode < 400 && !apiResponseSchema(request.method, path) && local instanceof z.ZodType) return JSON.stringify(local.parse(value));
      return JSON.stringify(parseApiResponse(request.method, path, reply.statusCode, value));
    } catch {
      // Do not expose validation paths or the rejected payload to clients or logs.
      throw new ApiError(500, 'RESPONSE_CONTRACT_FAILED', 'The server response failed validation');
    }
  });
}

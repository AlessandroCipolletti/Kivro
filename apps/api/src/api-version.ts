import type { FastifyInstance } from 'fastify';

const buyerPrefixes = ['/capabilities', '/jobs', '/assets', '/wallet', '/webhooks', '/api-keys'];
export function registerBuyerApiVersion(app: FastifyInstance) {
  app.addHook('onRoute', route => {
    if (route.method === 'HEAD' || !route.url.startsWith('/api/') || route.url.startsWith('/api/v1/')) return;
    const suffix = route.url.slice(4);
    if (!buyerPrefixes.some(prefix => suffix === prefix || suffix.startsWith(`${prefix}/`))) return;
    app.route({ ...route, url: `/api/v1${suffix}` });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.routeOptions.url?.startsWith('/api/v1/')) reply.header('X-Kivro-API-Version', '1');
    return payload;
  });
}

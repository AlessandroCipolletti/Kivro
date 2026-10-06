import { createApp } from './app.js';

const app = await createApp({ background: true });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void app.close().then(() => process.exit(0), () => process.exit(1));
});
try { await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port: Number(process.env.API_PORT ?? 4000) }); }
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }

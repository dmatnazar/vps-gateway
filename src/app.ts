import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { authPlugin } from './plugins/auth.plugin';
import { adminRoutes } from './modules/admin/admin.routes';
import { healthRoutes } from './modules/health/health.routes';
import { registerDynamicRouter } from './core/router/dynamicRouter';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Signature');

    if (req.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await registerDynamicRouter(app);

  return app;
}

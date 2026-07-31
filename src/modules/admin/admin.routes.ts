import type { FastifyInstance } from 'fastify';
import { syncSchemaHandler } from './sync.controller';
import { routeRegistry } from '../../core/router/routeRegistry';

export async function adminRoutes(app: FastifyInstance) {
  app.post(
    '/api/admin/sync-schema',
    { preHandler: [app.verifyAdminSyncSignature] },
    syncSchemaHandler
  );

  // Handy for local debugging — lists all currently loaded routes
  app.get('/api/admin/routes', async (_req, reply) => {
    return reply.send(routeRegistry.debugAll());
  });
}

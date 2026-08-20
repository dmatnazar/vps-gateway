import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { authPlugin } from './plugins/auth.plugin';
import { adminRoutes } from './modules/admin/admin.routes';
import { healthRoutes } from './modules/health/health.routes';
import { agentRoutes } from './modules/agent/agent.routes';
import { publicAuthRoutes } from './modules/auth/public.auth.routes';
import { registerDynamicRouter } from './core/router/dynamicRouter';
import { registerAvatarRoutes } from './modules/avatar/avatar.routes';
import { routeRegistry } from './core/router/routeRegistry';
import { tenantRepository } from './modules/tenant/tenant.repository';

/**
 * Restart-dan soň route-lary diskden (lowdb) gaýtadan ýükle.
 * Sync diňe RAM-a ýazýardy — bootstrap bolmasa ähli API "Endpoint not found" berýär.
 */
async function bootstrapRoutes(app: FastifyInstance) {
  try {
    const endpoints = await tenantRepository.listAllEndpoints();
    const byTenant = new Map<string, typeof endpoints>();

    for (const ep of endpoints) {
      const slug = ep.tenantSlug;
      if (!slug) continue;
      if (!byTenant.has(slug)) byTenant.set(slug, []);
      byTenant.get(slug)!.push(ep);
    }

    let total = 0;
    for (const [slug, eps] of byTenant) {
      routeRegistry.replaceTenantRoutes(
        slug,
        eps.map((e) => ({
          ...e,
          tenantSlug: slug,
          dbKey: e.dbKey || 'primary',
        })) as any
      );
      total += eps.length;
    }

    app.log.info(
      `📦 Bootstrapped ${total} endpoint(s) across ${byTenant.size} tenant(s) from disk`
    );
  } catch (err) {
    app.log.error({ err }, 'Failed to bootstrap routes from disk');
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type,X-Admin-Signature,X-Device-Sync-Signature,X-Device-Id,Authorization,X-Api-Key'
    );

    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  await app.register(rateLimit, {
    max: 5000,
    timeWindow: '1 minute',
    keyGenerator: (req: any) => {
      const deviceId = req.query?.deviceId || req.body?.deviceId || req.ip || 'unknown';
      return `device:${deviceId}`;
    },
  });
  await app.register(websocket);
  await app.register(authPlugin);
  await app.register(healthRoutes);
  await publicAuthRoutes(app);
  await app.register(adminRoutes);
  await app.register(agentRoutes);
  await registerAvatarRoutes(app);
  await registerDynamicRouter(app);

  // Diskden route-lary ýükle (restart-dan soň hem işleýär)
  await bootstrapRoutes(app);

  return app;
}

import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { authPlugin } from './plugins/auth.plugin';
import { adminRoutes } from './modules/admin/admin.routes';
import { healthRoutes } from './modules/health/health.routes';
import { registerDynamicRouter } from './core/router/dynamicRouter';
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
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type,X-Admin-Signature,Authorization,X-Api-Key'
    );

    if (req.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await registerDynamicRouter(app);

  // Diskden route-lary ýükle (restart-dan soň hem işleýär)
  await bootstrapRoutes(app);

  return app;
}

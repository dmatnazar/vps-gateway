import type { FastifyInstance } from 'fastify';
import { routeRegistry } from './routeRegistry';
import { bindParams, MissingParamError } from './paramBinder';
import { getTenantPool } from '../db/connectionPoolManager';
import { cacheManager } from '../cache/cacheManager';
import { mapResponse } from '../responseMapper/mapper';

export async function registerDynamicRouter(app: FastifyInstance) {
  app.all('/api/v1/:tenantSlug/*', async (req, reply) => {
    const { tenantSlug } = req.params as { tenantSlug: string };
    const wildcard = '/' + ((req.params as any)['*'] ?? '');

    const resolved = routeRegistry.resolve(tenantSlug, req.method, wildcard);
    if (!resolved) return reply.code(404).send({ error: 'Endpoint not found' });

    const { endpoint, params } = resolved;

    if (endpoint.authRequired) {
      const apiKey = req.headers['x-api-key'];
      const authHeader = req.headers['authorization'];
      if (!apiKey && !authHeader) {
        return reply.code(401).send({ error: 'Missing API key or bearer token' });
      }
      // Full key/JWT verification lives in plugins/auth.plugin.ts's preHandler.
      // This route assumes it already ran (registered globally in app.ts).
    }

    const cacheKey = `${tenantSlug}:${endpoint.name}:${JSON.stringify(params)}:${JSON.stringify(
      req.query
    )}`;

    if (endpoint.cacheTtlSec > 0) {
      const cached = await cacheManager.get(cacheKey);
      if (cached) return reply.send(cached);
    }

    try {
      const pool = await getTenantPool(tenantSlug);
      const sqlRequest = pool.request();
      bindParams(sqlRequest, endpoint, params, req);

      const result = await sqlRequest.query(endpoint.sqlQuery);
      const body = endpoint.responseSchema
        ? mapResponse(result.recordset, endpoint.responseSchema)
        : result.recordset;

      if (endpoint.cacheTtlSec > 0) {
        await cacheManager.set(cacheKey, body, endpoint.cacheTtlSec);
      }

      return reply.send(body);
    } catch (err) {
      if (err instanceof MissingParamError) {
        return reply.code(400).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Query execution failed', detail: (err as Error).message });
    }
  });
}

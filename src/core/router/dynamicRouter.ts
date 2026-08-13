import type { FastifyInstance } from 'fastify';
import { routeRegistry } from './routeRegistry';
import { bindParams, MissingParamError } from './paramBinder';
import { getTenantPool } from '../db/connectionPoolManager';
import { cacheManager } from '../cache/cacheManager';
import { mapResponse } from '../responseMapper/mapper';

async function handleDynamic(
  req: any,
  reply: any,
  tenantSlug: string,
  wildcard: string,
  dbKey?: string
) {
  const pathname = wildcard.startsWith('/') ? wildcard : `/${wildcard}`;

  const resolved = routeRegistry.resolve(tenantSlug, req.method, pathname, dbKey);
  if (!resolved) {
    return reply.code(404).send({
      error: 'Endpoint not found',
      hint: `Tried ${req.method} /api/v1/${tenantSlug}${dbKey ? '/' + dbKey : ''}${pathname}`,
    });
  }

  const { endpoint, params } = resolved;
  const effectiveDbKey = dbKey || endpoint.dbKey;

  if (endpoint.authRequired) {
    const apiKey = req.headers['x-api-key'];
    const authHeader = req.headers['authorization'];
    if (!apiKey && !authHeader) {
      return reply.code(401).send({ error: 'Missing API key or bearer token' });
    }
  }

  const cacheKey = `${tenantSlug}:${effectiveDbKey || 'default'}:${endpoint.name}:${JSON.stringify(params)}:${JSON.stringify(req.query)}`;

  // Skip cache when date filters present — avoids serving stale ranges while debugging/fixing
  const qAll = { ...(req.query as any), ...(typeof req.body === 'object' && req.body ? (req.body as any) : {}) };
  const hasDateFilter = Object.keys(qAll).some((k) => /begin|end|date|start|from/i.test(k) && qAll[k]);
  if (endpoint.cacheTtlSec > 0 && !hasDateFilter) {
    const cached = await cacheManager.get(cacheKey);
    if (cached) return reply.send(cached);
  }

  try {
    const pool = await getTenantPool(tenantSlug, effectiveDbKey);
    const sqlRequest = pool.request();
    bindParams(sqlRequest, endpoint, params, req);

    // Collect bound param values for diagnostics (query ?debug=1 or header)
    const debugOn =
      (req.query as any)?.debug === '1' ||
      req.headers['x-debug-params'] === '1';
    const bound: Record<string, unknown> = {};
    try {
      const inputs = (sqlRequest as any).parameters || (sqlRequest as any).parameters;
      // tedious/mssql stores in request.parameters
      const pr = (sqlRequest as any).parameters;
      if (pr && typeof pr === 'object') {
        for (const [k, v] of Object.entries(pr)) {
          bound[k] = (v as any)?.value ?? v;
        }
      }
    } catch {
      /* ignore */
    }
    // Always log date-like query values
    const q = (req.query || {}) as Record<string, unknown>;
    const dateish: Record<string, unknown> = {};
    for (const [k, v] of Object.entries({ ...q, ...(typeof req.body === 'object' && req.body ? req.body as any : {}) })) {
      if (/date|begin|end|start|from|to/i.test(k)) dateish[k] = v;
    }
    if (Object.keys(dateish).length) {
      req.log.info({ dateParams: dateish, bound }, 'filter-date-params');
      console.log('[filter-date-params]', JSON.stringify(dateish), 'bound=', JSON.stringify(bound));
    }

    const result = await sqlRequest.query(endpoint.sqlQuery);
    let body: any = endpoint.responseSchema
      ? mapResponse(result.recordset, endpoint.responseSchema)
      : result.recordset;

    if (endpoint.cacheTtlSec > 0) {
      await cacheManager.set(cacheKey, body, endpoint.cacheTtlSec);
    }

    if (debugOn) {
      if (Array.isArray(body)) {
        body = { rows: body, _debugParams: dateish, _bound: bound };
      } else if (body && typeof body === 'object') {
        body = { ...body, _debugParams: dateish, _bound: bound };
      }
    }

    return reply.send(body);
  } catch (err) {
    if (err instanceof MissingParamError) {
      return reply.code(400).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({
      error: 'Query execution failed',
      detail: (err as Error).message,
    });
  }
}

export async function registerDynamicRouter(app: FastifyInstance) {
  // Preferred: /api/v1/:tenantSlug/:dbKey/*
  app.all('/api/v1/:tenantSlug/:dbKey/*', async (req, reply) => {
    const { tenantSlug, dbKey } = req.params as { tenantSlug: string; dbKey: string };
    const wildcard = '/' + ((req.params as any)['*'] ?? '');
    return handleDynamic(req, reply, tenantSlug, wildcard, dbKey);
  });

  // Backward compatible: /api/v1/:tenantSlug/*  (uses primary connection)
  app.all('/api/v1/:tenantSlug/*', async (req, reply) => {
    const { tenantSlug } = req.params as { tenantSlug: string };
    const wildcard = '/' + ((req.params as any)['*'] ?? '');
    return handleDynamic(req, reply, tenantSlug, wildcard, undefined);
  });
}

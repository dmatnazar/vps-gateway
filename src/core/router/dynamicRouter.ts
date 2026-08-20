import type { FastifyInstance } from 'fastify';
import { routeRegistry } from './routeRegistry';
import { bindParams, extractParamValues, MissingParamError } from './paramBinder';
import { getTenantPool, isPrivateIp, resolveConnString, parseConnectionString } from '../db/connectionPoolManager';
import { cacheManager } from '../cache/cacheManager';
import { mapResponse } from '../responseMapper/mapper';
import { agentTunnelManager } from '../tunnel/agentTunnelManager';

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

  const debugOn =
    (req.query as any)?.debug === '1' ||
    req.headers['x-debug-params'] === '1';

  const q = (req.query || {}) as Record<string, unknown>;
  const dateish: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...q, ...(typeof req.body === 'object' && req.body ? req.body as any : {}) })) {
    if (/date|begin|end|start|from|to/i.test(k)) dateish[k] = v;
  }

  // -------------------------------------------------------------
  // 1) REVERSE WEBSOCKET TUNNEL: Check if Local Electron Agent is online
  // -------------------------------------------------------------
  if (agentTunnelManager.isAgentOnline(tenantSlug)) {
    try {
      const extractedParams = extractParamValues(endpoint, params, req);
      req.log.info({ tenantSlug, endpoint: endpoint.name, extractedParams }, 'dispatching-query-via-agent-tunnel');

      const tunnelResult = await agentTunnelManager.executeRemoteQuery(tenantSlug, {
        sqlQuery: endpoint.sqlQuery,
        params: extractedParams,
        dbKey: effectiveDbKey,
      });

      if (!tunnelResult.ok) {
        return reply.code(500).send({
          error: tunnelResult.error || 'Ýerli kompýuterde SQL soragy şowsuz boldy',
          source: 'local-electron-agent',
        });
      }

      let body: any = endpoint.responseSchema
        ? mapResponse(tunnelResult.rows || [], endpoint.responseSchema)
        : tunnelResult.rows || [];

      if (endpoint.cacheTtlSec > 0) {
        await cacheManager.set(cacheKey, body, endpoint.cacheTtlSec);
      }

      if (debugOn) {
        if (Array.isArray(body)) {
          body = { rows: body, _debugParams: dateish, _via: 'agent-tunnel', _elapsedMs: tunnelResult.elapsedMs };
        } else if (body && typeof body === 'object') {
          body = { ...body, _debugParams: dateish, _via: 'agent-tunnel', _elapsedMs: tunnelResult.elapsedMs };
        }
      }

      return reply.send(body);
    } catch (err) {
      if (err instanceof MissingParamError) {
        return reply.code(400).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({
        error: 'Agent tunnel query execution failed',
        detail: (err as Error).message,
      });
    }
  }

  // -------------------------------------------------------------
  // 2) FALLBACK: Direct MSSQL Connection Pool (if direct access is available)
  // -------------------------------------------------------------
  try {
    const connStr = await resolveConnString(tenantSlug, effectiveDbKey);
    const parsed = parseConnectionString(connStr);
    if (parsed.server && isPrivateIp(parsed.server)) {
      return reply.code(503).send({
        error: 'Ýerli Electron Agent birikdirilmedik',
        detail: `MSSQL maglumat bazasy ýerli torda (${parsed.server}:${parsed.port || 1433}) ýerleşýär. VPS Gateway ýerli tora gönüden-göni baglanyp bilmeýär.`,
        hint: `1) «${tenantSlug}» firma kompýuterinde Electron işläp durmaly. 2) Electron Settings-de Gateway URL = VPS public adres (localhost däl). 3) Device BI-da approved + bu firma baglanan. 4) Electron-da tunnel status ONLINE bolmaly.`,
        tenantSlug,
        agentOnline: false,
        dbHost: parsed.server,
      });
    }
  } catch {
    /* ignore and proceed */
  }

  try {
    const pool = await getTenantPool(tenantSlug, effectiveDbKey);
    const sqlRequest = pool.request();
    bindParams(sqlRequest, endpoint, params, req);

    const bound: Record<string, unknown> = {};
    try {
      const pr = (sqlRequest as any).parameters;
      if (pr && typeof pr === 'object') {
        for (const [k, v] of Object.entries(pr)) {
          bound[k] = (v as any)?.value ?? v;
        }
      }
    } catch {
      /* ignore */
    }

    if (Object.keys(dateish).length) {
      req.log.info({ dateParams: dateish, bound }, 'filter-date-params');
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
        body = { rows: body, _debugParams: dateish, _bound: bound, _via: 'direct-mssql' };
      } else if (body && typeof body === 'object') {
        body = { ...body, _debugParams: dateish, _bound: bound, _via: 'direct-mssql' };
      }
    }

    return reply.send(body);
  } catch (err) {
    if (err instanceof MissingParamError) {
      return reply.code(400).send({ error: err.message });
    }
    req.log.error(err);

    const errMsg = (err as Error).message || String(err);
    const isOfflineHint =
      errMsg.includes('ECONNREFUSED') ||
      errMsg.includes('ETIMEDOUT') ||
      errMsg.includes('socket hang up') ||
      errMsg.includes('failed to connect') ||
      errMsg.includes('Failed to connect to');

    return reply.code(500).send({
      error: 'Query execution failed',
      detail: errMsg,
      hint: isOfflineHint
        ? `Bu kompaniýanyň ýerli bazasyna gönüden-göni birigip bolmady we Electron Agent hem birikdirilmedik. Kompýuterde Electron programmasyny açyň.`
        : undefined,
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

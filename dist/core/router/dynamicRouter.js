"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDynamicRouter = registerDynamicRouter;
const routeRegistry_1 = require("./routeRegistry");
const paramBinder_1 = require("./paramBinder");
const connectionPoolManager_1 = require("../db/connectionPoolManager");
const cacheManager_1 = require("../cache/cacheManager");
const mapper_1 = require("../responseMapper/mapper");
const agentTunnelManager_1 = require("../tunnel/agentTunnelManager");
async function handleDynamic(req, reply, tenantSlug, wildcard, dbKey) {
    const pathname = wildcard.startsWith('/') ? wildcard : `/${wildcard}`;
    const resolved = routeRegistry_1.routeRegistry.resolve(tenantSlug, req.method, pathname, dbKey);
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
    const qAll = { ...req.query, ...(typeof req.body === 'object' && req.body ? req.body : {}) };
    const hasDateFilter = Object.keys(qAll).some((k) => /begin|end|date|start|from/i.test(k) && qAll[k]);
    if (endpoint.cacheTtlSec > 0 && !hasDateFilter) {
        const cached = await cacheManager_1.cacheManager.get(cacheKey);
        if (cached)
            return reply.send(cached);
    }
    const debugOn = req.query?.debug === '1' ||
        req.headers['x-debug-params'] === '1';
    const q = (req.query || {});
    const dateish = {};
    for (const [k, v] of Object.entries({ ...q, ...(typeof req.body === 'object' && req.body ? req.body : {}) })) {
        if (/date|begin|end|start|from|to/i.test(k))
            dateish[k] = v;
    }
    // -------------------------------------------------------------
    // 1) REVERSE WEBSOCKET TUNNEL: Check if Local Electron Agent is online
    // -------------------------------------------------------------
    if (agentTunnelManager_1.agentTunnelManager.isAgentOnline(tenantSlug)) {
        try {
            const extractedParams = (0, paramBinder_1.extractParamValues)(endpoint, params, req);
            // Multi-select: IN (@id) + "1,23" → IN (@id__m0, @id__m1) before agent runs SQL
            const expanded = (0, paramBinder_1.expandMultiValueParams)(endpoint.sqlQuery || '', extractedParams);
            req.log.info({ tenantSlug, endpoint: endpoint.name, extractedParams, expandedParams: expanded.params }, 'dispatching-query-via-agent-tunnel');
            const tunnelResult = await agentTunnelManager_1.agentTunnelManager.executeRemoteQuery(tenantSlug, {
                sqlQuery: expanded.sql,
                params: expanded.params,
                dbKey: effectiveDbKey,
            });
            if (!tunnelResult.ok) {
                return reply.code(500).send({
                    error: tunnelResult.error || 'Ýerli kompýuterde SQL soragy şowsuz boldy',
                    source: 'local-electron-agent',
                });
            }
            let body = endpoint.responseSchema
                ? (0, mapper_1.mapResponse)(tunnelResult.rows || [], endpoint.responseSchema)
                : tunnelResult.rows || [];
            if (endpoint.cacheTtlSec > 0) {
                await cacheManager_1.cacheManager.set(cacheKey, body, endpoint.cacheTtlSec);
            }
            if (debugOn) {
                if (Array.isArray(body)) {
                    body = { rows: body, _debugParams: dateish, _via: 'agent-tunnel', _elapsedMs: tunnelResult.elapsedMs };
                }
                else if (body && typeof body === 'object') {
                    body = { ...body, _debugParams: dateish, _via: 'agent-tunnel', _elapsedMs: tunnelResult.elapsedMs };
                }
            }
            return reply.send(body);
        }
        catch (err) {
            if (err instanceof paramBinder_1.MissingParamError) {
                return reply.code(400).send({ error: err.message });
            }
            req.log.error(err);
            return reply.code(500).send({
                error: 'Agent tunnel query execution failed',
                detail: err.message,
            });
        }
    }
    // -------------------------------------------------------------
    // 2) FALLBACK: Direct MSSQL Connection Pool (if direct access is available)
    // -------------------------------------------------------------
    try {
        const connStr = await (0, connectionPoolManager_1.resolveConnString)(tenantSlug, effectiveDbKey);
        const parsed = (0, connectionPoolManager_1.parseConnectionString)(connStr);
        if (parsed.server && (0, connectionPoolManager_1.isPrivateIp)(parsed.server)) {
            return reply.code(503).send({
                error: 'Ýerli Electron Agent birikdirilmedik',
                detail: `MSSQL maglumat bazasy ýerli torda (${parsed.server}:${parsed.port || 1433}) ýerleşýär. VPS Gateway ýerli tora gönüden-göni baglanyp bilmeýär.`,
                hint: `1) «${tenantSlug}» firma kompýuterinde Electron işläp durmaly. 2) Electron Settings-de Gateway URL = VPS public adres (localhost däl). 3) Device BI-da approved + bu firma baglanan. 4) Electron-da tunnel status ONLINE bolmaly.`,
                tenantSlug,
                agentOnline: false,
                dbHost: parsed.server,
            });
        }
    }
    catch {
        /* ignore and proceed */
    }
    try {
        const pool = await (0, connectionPoolManager_1.getTenantPool)(tenantSlug, effectiveDbKey);
        const sqlRequest = pool.request();
        const boundSql = (0, paramBinder_1.bindParams)(sqlRequest, endpoint, params, req, endpoint.sqlQuery);
        const bound = {};
        try {
            const pr = sqlRequest.parameters;
            if (pr && typeof pr === 'object') {
                for (const [k, v] of Object.entries(pr)) {
                    bound[k] = v?.value ?? v;
                }
            }
        }
        catch {
            /* ignore */
        }
        if (Object.keys(dateish).length) {
            req.log.info({ dateParams: dateish, bound }, 'filter-date-params');
        }
        const result = await sqlRequest.query(boundSql || endpoint.sqlQuery);
        let body = endpoint.responseSchema
            ? (0, mapper_1.mapResponse)(result.recordset, endpoint.responseSchema)
            : result.recordset;
        if (endpoint.cacheTtlSec > 0) {
            await cacheManager_1.cacheManager.set(cacheKey, body, endpoint.cacheTtlSec);
        }
        if (debugOn) {
            if (Array.isArray(body)) {
                body = { rows: body, _debugParams: dateish, _bound: bound, _via: 'direct-mssql' };
            }
            else if (body && typeof body === 'object') {
                body = { ...body, _debugParams: dateish, _bound: bound, _via: 'direct-mssql' };
            }
        }
        return reply.send(body);
    }
    catch (err) {
        if (err instanceof paramBinder_1.MissingParamError) {
            return reply.code(400).send({ error: err.message });
        }
        req.log.error(err);
        const errMsg = err.message || String(err);
        const isOfflineHint = errMsg.includes('ECONNREFUSED') ||
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
async function registerDynamicRouter(app) {
    // Preferred: /api/v1/:tenantSlug/:dbKey/*
    app.all('/api/v1/:tenantSlug/:dbKey/*', async (req, reply) => {
        const { tenantSlug, dbKey } = req.params;
        const wildcard = '/' + (req.params['*'] ?? '');
        return handleDynamic(req, reply, tenantSlug, wildcard, dbKey);
    });
    // Backward compatible: /api/v1/:tenantSlug/*  (uses primary connection)
    app.all('/api/v1/:tenantSlug/*', async (req, reply) => {
        const { tenantSlug } = req.params;
        const wildcard = '/' + (req.params['*'] ?? '');
        return handleDynamic(req, reply, tenantSlug, wildcard, undefined);
    });
}
//# sourceMappingURL=dynamicRouter.js.map
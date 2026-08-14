"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDynamicRouter = registerDynamicRouter;
const routeRegistry_1 = require("./routeRegistry");
const paramBinder_1 = require("./paramBinder");
const connectionPoolManager_1 = require("../db/connectionPoolManager");
const cacheManager_1 = require("../cache/cacheManager");
const mapper_1 = require("../responseMapper/mapper");
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
    try {
        const pool = await (0, connectionPoolManager_1.getTenantPool)(tenantSlug, effectiveDbKey);
        const sqlRequest = pool.request();
        (0, paramBinder_1.bindParams)(sqlRequest, endpoint, params, req);
        // Collect bound param values for diagnostics (query ?debug=1 or header)
        const debugOn = req.query?.debug === '1' ||
            req.headers['x-debug-params'] === '1';
        const bound = {};
        try {
            const inputs = sqlRequest.parameters || sqlRequest.parameters;
            // tedious/mssql stores in request.parameters
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
        // Always log date-like query values
        const q = (req.query || {});
        const dateish = {};
        for (const [k, v] of Object.entries({ ...q, ...(typeof req.body === 'object' && req.body ? req.body : {}) })) {
            if (/date|begin|end|start|from|to/i.test(k))
                dateish[k] = v;
        }
        if (Object.keys(dateish).length) {
            req.log.info({ dateParams: dateish, bound }, 'filter-date-params');
            console.log('[filter-date-params]', JSON.stringify(dateish), 'bound=', JSON.stringify(bound));
        }
        const result = await sqlRequest.query(endpoint.sqlQuery);
        let body = endpoint.responseSchema
            ? (0, mapper_1.mapResponse)(result.recordset, endpoint.responseSchema)
            : result.recordset;
        if (endpoint.cacheTtlSec > 0) {
            await cacheManager_1.cacheManager.set(cacheKey, body, endpoint.cacheTtlSec);
        }
        if (debugOn) {
            if (Array.isArray(body)) {
                body = { rows: body, _debugParams: dateish, _bound: bound };
            }
            else if (body && typeof body === 'object') {
                body = { ...body, _debugParams: dateish, _bound: bound };
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
            error: 'Query execution failed',
            detail: err.message,
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
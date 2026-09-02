"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncSchemaHandler = syncSchemaHandler;
const zod_1 = require("zod");
const tenant_repository_1 = require("../tenant/tenant.repository");
const routeRegistry_1 = require("../../core/router/routeRegistry");
const connectionPoolManager_1 = require("../../core/db/connectionPoolManager");
const crypto_1 = require("../../core/db/crypto");
const sqliteDb_1 = require("../../store/sqliteDb");
const ParamDefSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    sqlParam: zod_1.z.string().optional().default(''),
    type: zod_1.z
        .string()
        .optional()
        .transform((t) => {
        const allowed = ['int', 'bigint', 'date', 'datetime', 'nvarchar', 'bit', 'float'];
        const v = (t || 'nvarchar').toLowerCase();
        return (allowed.includes(v) ? v : 'nvarchar');
    }),
    required: zod_1.z.boolean().optional().default(false),
    default: zod_1.z.any().optional(),
}).passthrough();
const ParamsSchemaLoose = zod_1.z
    .object({
    urlParams: zod_1.z.array(ParamDefSchema).optional().default([]),
    queryParams: zod_1.z.array(ParamDefSchema).optional().default([]),
    bodyParams: zod_1.z.array(ParamDefSchema).optional().default([]),
})
    .optional()
    .default({ urlParams: [], queryParams: [], bodyParams: [] });
const SyncSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    tenantName: zod_1.z.string().optional().default(''),
    dbConnectionString: zod_1.z.string().optional(),
    connections: zod_1.z
        .array(zod_1.z.object({
        dbKey: zod_1.z.string().min(1),
        label: zod_1.z.string().optional(),
        database: zod_1.z.string().optional(),
        connectionString: zod_1.z.string().min(1),
        isPrimary: zod_1.z.boolean().optional(),
    }))
        .optional(),
    endpoints: zod_1.z
        .array(zod_1.z.object({
        id: zod_1.z.string().optional(),
        name: zod_1.z.string().optional().default('endpoint'),
        method: zod_1.z
            .string()
            .optional()
            .transform((m) => {
            const u = String(m || 'GET').toUpperCase();
            if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(u))
                return u === 'PATCH' ? 'PUT' : u;
            return 'GET';
        }),
        pathTemplate: zod_1.z.string().optional().default('/'),
        sqlQuery: zod_1.z.string().optional().default('SELECT 1'),
        paramsSchema: ParamsSchemaLoose,
        responseSchema: zod_1.z.any().optional(),
        cacheTtlSec: zod_1.z.coerce.number().optional().default(0),
        authRequired: zod_1.z.boolean().optional().default(true),
        dbKey: zod_1.z.string().optional(),
        connectionId: zod_1.z.string().optional(),
        database: zod_1.z.string().optional(),
        /** Client last-write timestamp — LWW vs VPS endpoints.updated_at */
        updatedAt: zod_1.z.string().optional(),
    }).passthrough())
        .optional()
        .default([]),
});
async function syncSchemaHandler(req, reply) {
    // Electron sync → refresh device online status
    try {
        const h = req.headers;
        const deviceId = h['x-device-id'] || '';
        if (deviceId) {
            (0, sqliteDb_1.getDb)()
                .prepare(`UPDATE devices SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
                .run(deviceId);
        }
    }
    catch {
        /* */
    }
    const parsed = SyncSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { tenantSlug, tenantName, dbConnectionString, connections, endpoints } = parsed.data;
    let tenant = await tenant_repository_1.tenantRepository.findBySlug(tenantSlug);
    const encryptedConnections = connections?.map((c) => {
        const { enc, iv } = (0, crypto_1.encryptConnString)(c.connectionString);
        let host = '';
        let port = 1433;
        let username = '';
        try {
            const { parseConnectionString } = require('../../core/db/connectionPoolManager');
            const p = parseConnectionString(c.connectionString);
            host = p.server || '';
            port = p.port || 1433;
            username = p.user || '';
        }
        catch {
            /* */
        }
        return {
            dbKey: c.dbKey,
            label: c.label || c.dbKey,
            database: c.database,
            dbConnEnc: enc,
            dbConnIv: iv,
            isPrimary: Boolean(c.isPrimary),
            host,
            port,
            username,
            encrypt: true,
            trustServerCertificate: true,
        };
    }) ?? undefined;
    const primaryConnString = dbConnectionString ||
        connections?.find((c) => c.isPrimary)?.connectionString ||
        connections?.[0]?.connectionString;
    if (!tenant) {
        if (!primaryConnString) {
            return reply.code(400).send({ error: 'New tenants require a connection string' });
        }
        const { enc, iv } = (0, crypto_1.encryptConnString)(primaryConnString);
        tenant = await tenant_repository_1.tenantRepository.create({
            slug: tenantSlug,
            name: tenantName,
            dbConnEnc: enc,
            dbConnIv: iv,
        });
    }
    else if (primaryConnString) {
        const { enc, iv } = (0, crypto_1.encryptConnString)(primaryConnString);
        await tenant_repository_1.tenantRepository.updateConnection(tenant.id, enc, iv);
    }
    if (encryptedConnections) {
        await tenant_repository_1.tenantRepository.replaceConnections(tenant.id, encryptedConnections);
    }
    (0, connectionPoolManager_1.invalidateTenantPool)(tenantSlug);
    // LWW merge into SQLite (skips when VPS/BI updated_at is newer)
    await tenant_repository_1.tenantRepository.replaceEndpoints(tenant.id, endpoints);
    // Rebuild in-memory routes from DB — NOT from client payload —
    // otherwise skipped LWW rows would still leave stale Electron SQL in the router.
    try {
        const allEps = await tenant_repository_1.tenantRepository.listAllEndpoints();
        const forTenant = allEps.filter((e) => e.tenantSlug === tenantSlug);
        routeRegistry_1.routeRegistry.replaceTenantRoutes(tenantSlug, forTenant);
    }
    catch (err) {
        console.warn('[sync-schema] routeRegistry refresh from DB failed', err);
        routeRegistry_1.routeRegistry.replaceTenantRoutes(tenantSlug, endpoints.map((e) => ({
            ...e,
            tenantSlug,
            dbKey: e.dbKey || 'primary',
        })));
    }
    // Electron device that pushed schema → bind firm to that device (1 firm = 1 device)
    try {
        const deviceId = req.headers['x-device-id'] || '';
        if (deviceId) {
            const db = (await Promise.resolve().then(() => __importStar(require('../../store/sqliteDb')))).getDb();
            const { randomUUID } = await Promise.resolve().then(() => __importStar(require('crypto')));
            const other = db
                .prepare(`SELECT device_id FROM device_assignments WHERE tenant_slug = ? AND device_id != ? LIMIT 1`)
                .get(tenantSlug, deviceId);
            if (other?.device_id) {
                return reply.code(409).send({
                    error: `Firma "${tenantSlug}" eýýäm başga enjama bagly. Bir firma diňe bir enjama baglanyp bilýär.`,
                    code: 'FIRM_ALREADY_ASSIGNED',
                    deviceId: other.device_id,
                    tenantSlug,
                });
            }
            const exists = db
                .prepare(`SELECT id FROM device_assignments WHERE device_id = ? AND tenant_slug = ?`)
                .get(deviceId, tenantSlug);
            const nowA = new Date().toISOString();
            if (!exists) {
                db.prepare(`INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'auto-sync-schema', ?, ?)`).run(randomUUID(), deviceId, tenantSlug, nowA, nowA);
            }
            db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(nowA, nowA, deviceId);
        }
    }
    catch (e) {
        console.warn('[sync-schema] auto device assign failed', e);
    }
    (0, sqliteDb_1.logSync)('sync', 'tenant', tenant.id, 'electron', {
        tenantSlug,
        endpointsCount: endpoints.length,
        connectionsCount: encryptedConnections?.length ?? 0,
    });
    return reply.send({
        status: 'success',
        tenantSlug,
        endpointsLoaded: endpoints.length,
        connectionsLoaded: encryptedConnections?.length ?? 0,
        syncedAt: new Date().toISOString(),
    });
}
//# sourceMappingURL=sync.controller.js.map
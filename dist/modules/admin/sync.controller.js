"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncSchemaHandler = syncSchemaHandler;
const zod_1 = require("zod");
const tenant_repository_1 = require("../tenant/tenant.repository");
const routeRegistry_1 = require("../../core/router/routeRegistry");
const connectionPoolManager_1 = require("../../core/db/connectionPoolManager");
const crypto_1 = require("../../core/db/crypto");
const sqliteDb_1 = require("../../store/sqliteDb");
const ParamDefSchema = zod_1.z.object({
    name: zod_1.z.string(),
    sqlParam: zod_1.z.string(),
    type: zod_1.z.enum(['int', 'bigint', 'date', 'datetime', 'nvarchar', 'bit', 'float']),
    required: zod_1.z.boolean(),
    default: zod_1.z.any().optional(),
});
const SyncSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    tenantName: zod_1.z.string(),
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
    endpoints: zod_1.z.array(zod_1.z.object({
        name: zod_1.z.string(),
        method: zod_1.z.enum(['GET', 'POST', 'PUT', 'DELETE']),
        pathTemplate: zod_1.z.string(),
        sqlQuery: zod_1.z.string(),
        paramsSchema: zod_1.z.object({
            urlParams: zod_1.z.array(ParamDefSchema),
            queryParams: zod_1.z.array(ParamDefSchema),
            bodyParams: zod_1.z.array(ParamDefSchema),
        }),
        responseSchema: zod_1.z.any().optional(),
        cacheTtlSec: zod_1.z.number().default(0),
        authRequired: zod_1.z.boolean().default(true),
        dbKey: zod_1.z.string().optional(),
        connectionId: zod_1.z.string().optional(),
        database: zod_1.z.string().optional(),
    })),
});
async function syncSchemaHandler(req, reply) {
    const parsed = SyncSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { tenantSlug, tenantName, dbConnectionString, connections, endpoints } = parsed.data;
    let tenant = await tenant_repository_1.tenantRepository.findBySlug(tenantSlug);
    const encryptedConnections = connections?.map((c) => {
        const { enc, iv } = (0, crypto_1.encryptConnString)(c.connectionString);
        return {
            dbKey: c.dbKey,
            label: c.label || c.dbKey,
            database: c.database,
            dbConnEnc: enc,
            dbConnIv: iv,
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
    await tenant_repository_1.tenantRepository.replaceEndpoints(tenant.id, endpoints);
    routeRegistry_1.routeRegistry.replaceTenantRoutes(tenantSlug, endpoints.map((e) => ({
        ...e,
        tenantSlug,
        dbKey: e.dbKey || 'primary',
    })));
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
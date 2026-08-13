import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { tenantRepository } from '../tenant/tenant.repository';
import { routeRegistry } from '../../core/router/routeRegistry';
import { invalidateTenantPool } from '../../core/db/connectionPoolManager';
import { encryptConnString } from '../../core/db/crypto';
import { logSync } from '../../store/sqliteDb';

const ParamDefSchema = z.object({
  name: z.string(),
  sqlParam: z.string(),
  type: z.enum(['int', 'bigint', 'date', 'datetime', 'nvarchar', 'bit', 'float']),
  required: z.boolean(),
  default: z.any().optional(),
});

const SyncSchema = z.object({
  tenantSlug: z.string().min(1),
  tenantName: z.string(),
  dbConnectionString: z.string().optional(),
  connections: z
    .array(
      z.object({
        dbKey: z.string().min(1),
        label: z.string().optional(),
        database: z.string().optional(),
        connectionString: z.string().min(1),
        isPrimary: z.boolean().optional(),
      })
    )
    .optional(),
  endpoints: z.array(
    z.object({
      name: z.string(),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
      pathTemplate: z.string(),
      sqlQuery: z.string(),
      paramsSchema: z.object({
        urlParams: z.array(ParamDefSchema),
        queryParams: z.array(ParamDefSchema),
        bodyParams: z.array(ParamDefSchema),
      }),
      responseSchema: z.any().optional(),
      cacheTtlSec: z.number().default(0),
      authRequired: z.boolean().default(true),
      dbKey: z.string().optional(),
      connectionId: z.string().optional(),
      database: z.string().optional(),
    })
  ),
});

export async function syncSchemaHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const { tenantSlug, tenantName, dbConnectionString, connections, endpoints } = parsed.data;

  let tenant = await tenantRepository.findBySlug(tenantSlug);

  const encryptedConnections =
    connections?.map((c) => {
      const { enc, iv } = encryptConnString(c.connectionString);
      return {
        dbKey: c.dbKey,
        label: c.label || c.dbKey,
        database: c.database,
        dbConnEnc: enc,
        dbConnIv: iv,
      };
    }) ?? undefined;

  const primaryConnString =
    dbConnectionString ||
    connections?.find((c) => c.isPrimary)?.connectionString ||
    connections?.[0]?.connectionString;

  if (!tenant) {
    if (!primaryConnString) {
      return reply.code(400).send({ error: 'New tenants require a connection string' });
    }
    const { enc, iv } = encryptConnString(primaryConnString);
    tenant = await tenantRepository.create({
      slug: tenantSlug,
      name: tenantName,
      dbConnEnc: enc,
      dbConnIv: iv,
    });
  } else if (primaryConnString) {
    const { enc, iv } = encryptConnString(primaryConnString);
    await tenantRepository.updateConnection(tenant.id, enc, iv);
  }

  if (encryptedConnections) {
    await tenantRepository.replaceConnections(tenant.id, encryptedConnections);
  }

  invalidateTenantPool(tenantSlug);

  await tenantRepository.replaceEndpoints(tenant.id, endpoints as any);

  routeRegistry.replaceTenantRoutes(
    tenantSlug,
    endpoints.map((e) => ({
      ...e,
      tenantSlug,
      dbKey: e.dbKey || 'primary',
    })) as any
  );

  logSync('sync', 'tenant', tenant.id, 'electron', {
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

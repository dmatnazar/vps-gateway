import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { tenantRepository } from '../tenant/tenant.repository';
import { routeRegistry } from '../../core/router/routeRegistry';
import { invalidateTenantPool } from '../../core/db/connectionPoolManager';
import { encryptConnString } from '../../core/db/crypto';

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
    })
  ),
});

export async function syncSchemaHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const { tenantSlug, tenantName, dbConnectionString, endpoints } = parsed.data;

  let tenant = await tenantRepository.findBySlug(tenantSlug);

  if (!tenant) {
    if (!dbConnectionString) {
      return reply.code(400).send({ error: 'New tenants require a connection string' });
    }
    const { enc, iv } = encryptConnString(dbConnectionString);
    tenant = await tenantRepository.create({ slug: tenantSlug, name: tenantName, dbConnEnc: enc, dbConnIv: iv });
  } else if (dbConnectionString) {
    const { enc, iv } = encryptConnString(dbConnectionString);
    await tenantRepository.updateConnection(tenant.id, enc, iv);
    invalidateTenantPool(tenantSlug);
  }

  await tenantRepository.replaceEndpoints(tenant.id, endpoints as any);

  // Hot reload: swap in-memory route table instantly — no restart needed
  routeRegistry.replaceTenantRoutes(
    tenantSlug,
    endpoints.map((e) => ({ ...e, tenantSlug })) as any
  );

  return reply.send({
    status: 'success',
    tenantSlug,
    endpointsLoaded: endpoints.length,
    syncedAt: new Date().toISOString(),
  });
}

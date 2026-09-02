import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { tenantRepository } from '../tenant/tenant.repository';
import { routeRegistry } from '../../core/router/routeRegistry';
import { invalidateTenantPool } from '../../core/db/connectionPoolManager';
import { encryptConnString } from '../../core/db/crypto';
import { logSync, getDb } from '../../store/sqliteDb';

const ParamDefSchema = z.object({
  name: z.string().min(1),
  sqlParam: z.string().optional().default(''),
  type: z
    .string()
    .optional()
    .transform((t) => {
      const allowed = ['int', 'bigint', 'date', 'datetime', 'nvarchar', 'bit', 'float'] as const;
      const v = (t || 'nvarchar').toLowerCase();
      return (allowed.includes(v as any) ? v : 'nvarchar') as (typeof allowed)[number];
    }),
  required: z.boolean().optional().default(false),
  default: z.any().optional(),
}).passthrough();

const ParamsSchemaLoose = z
  .object({
    urlParams: z.array(ParamDefSchema).optional().default([]),
    queryParams: z.array(ParamDefSchema).optional().default([]),
    bodyParams: z.array(ParamDefSchema).optional().default([]),
  })
  .optional()
  .default({ urlParams: [], queryParams: [], bodyParams: [] });

const SyncSchema = z.object({
  tenantSlug: z.string().min(1),
  tenantName: z.string().optional().default(''),
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
  endpoints: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional().default('endpoint'),
        method: z
          .string()
          .optional()
          .transform((m) => {
            const u = String(m || 'GET').toUpperCase();
            if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(u)) return u === 'PATCH' ? 'PUT' : u;
            return 'GET';
          }),
        pathTemplate: z.string().optional().default('/'),
        sqlQuery: z.string().optional().default('SELECT 1'),
        paramsSchema: ParamsSchemaLoose,
        responseSchema: z.any().optional(),
        cacheTtlSec: z.coerce.number().optional().default(0),
        authRequired: z.boolean().optional().default(true),
        dbKey: z.string().optional(),
        connectionId: z.string().optional(),
        database: z.string().optional(),
        /** Client last-write timestamp — LWW vs VPS endpoints.updated_at */
        updatedAt: z.string().optional(),
      }).passthrough()
    )
    .optional()
    .default([]),
});

export async function syncSchemaHandler(req: FastifyRequest, reply: FastifyReply) {
  // Electron sync → refresh device online status
  try {
    const h = req.headers as Record<string, string | undefined>;
    const deviceId = h['x-device-id'] || '';
    if (deviceId) {
      getDb()
        .prepare(
          `UPDATE devices SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        )
        .run(deviceId);
    }
  } catch {
    /* */
  }
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const { tenantSlug, tenantName, dbConnectionString, connections, endpoints } = parsed.data;

  let tenant = await tenantRepository.findBySlug(tenantSlug);

  const encryptedConnections =
    connections?.map((c) => {
      const { enc, iv } = encryptConnString(c.connectionString);
      let host = '';
      let port = 1433;
      let username = '';
      try {
        const { parseConnectionString } = require('../../core/db/connectionPoolManager');
        const p = parseConnectionString(c.connectionString);
        host = p.server || '';
        port = p.port || 1433;
        username = p.user || '';
      } catch {
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

  // LWW merge into SQLite (skips when VPS/BI updated_at is newer)
  await tenantRepository.replaceEndpoints(tenant.id, endpoints as any);

  // Rebuild in-memory routes from DB — NOT from client payload —
  // otherwise skipped LWW rows would still leave stale Electron SQL in the router.
  try {
    const allEps = await tenantRepository.listAllEndpoints();
    const forTenant = allEps.filter((e) => e.tenantSlug === tenantSlug);
    routeRegistry.replaceTenantRoutes(tenantSlug, forTenant as any);
  } catch (err) {
    console.warn('[sync-schema] routeRegistry refresh from DB failed', err);
    routeRegistry.replaceTenantRoutes(
      tenantSlug,
      endpoints.map((e) => ({
        ...e,
        tenantSlug,
        dbKey: e.dbKey || 'primary',
      })) as any
    );
  }

  // Electron device that pushed schema → bind firm to that device (1 firm = 1 device)
  try {
    const deviceId = (req.headers['x-device-id'] as string) || '';
    if (deviceId) {
      const db = (await import('../../store/sqliteDb')).getDb();
      const { randomUUID } = await import('crypto');
      const other = db
        .prepare(
          `SELECT device_id FROM device_assignments WHERE tenant_slug = ? AND device_id != ? LIMIT 1`
        )
        .get(tenantSlug, deviceId) as { device_id?: string } | undefined;
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
        .get(deviceId, tenantSlug) as any;
      const nowA = new Date().toISOString();
      if (!exists) {
        db.prepare(
          `INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'auto-sync-schema', ?, ?)`
        ).run(randomUUID(), deviceId, tenantSlug, nowA, nowA);
      }
      db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(
        nowA,
        nowA,
        deviceId
      );
    }
  } catch (e) {
    console.warn('[sync-schema] auto device assign failed', e);
  }

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

import crypto from 'node:crypto';
import { getDb, logSync } from '../../store/sqliteDb';
import type { TenantRecord, EndpointConfig, TenantConnectionRecord } from '../../types/contracts';

export const tenantRepository = {
  async findBySlug(slug: string): Promise<TenantRecord | undefined> {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(slug) as any;
    if (!row) return undefined;

    const connections = db
      .prepare(`SELECT db_key as dbKey, label, database_name as database, db_conn_enc as dbConnEnc, db_conn_iv as dbConnIv FROM tenant_connections WHERE tenant_id = ?`)
      .all(row.id) as TenantConnectionRecord[];

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      dbConnEnc: row.db_conn_enc,
      dbConnIv: row.db_conn_iv,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      connections: connections.length > 0 ? connections : undefined,
    };
  },

  async create(input: {
    slug: string;
    name: string;
    dbConnEnc: string;
    dbConnIv: string;
  }): Promise<TenantRecord> {
    const db = getDb();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    db.prepare(`
      INSERT INTO tenants (id, slug, name, db_conn_enc, db_conn_iv, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, input.slug, input.name, input.dbConnEnc, input.dbConnIv, now, now);

    logSync('create', 'tenant', id, 'electron', { slug: input.slug, name: input.name });

    return {
      id,
      slug: input.slug,
      name: input.name,
      dbConnEnc: input.dbConnEnc,
      dbConnIv: input.dbConnIv,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
  },

  async replaceConnections(tenantId: string, connections: TenantConnectionRecord[]) {
    const db = getDb();
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM tenant_connections WHERE tenant_id = ?`).run(tenantId);
      const stmt = db.prepare(`
        INSERT INTO tenant_connections (tenant_id, db_key, label, database_name, db_conn_enc, db_conn_iv)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of connections) {
        stmt.run(tenantId, c.dbKey, c.label || '', c.database || '', c.dbConnEnc, c.dbConnIv);
      }
      db.prepare(`UPDATE tenants SET updated_at = ? WHERE id = ?`).run(now, tenantId);
    });

    tx();
    logSync('update', 'connection', tenantId, 'electron', { connectionCount: connections.length });
  },

  async updateConnection(tenantId: string, enc: string, iv: string) {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`UPDATE tenants SET db_conn_enc = ?, db_conn_iv = ?, updated_at = ? WHERE id = ?`).run(enc, iv, now, tenantId);
    logSync('update', 'tenant', tenantId, 'electron', { field: 'connection' });
  },

  async replaceEndpoints(tenantId: string, endpoints: Omit<EndpointConfig, 'tenantSlug'>[]) {
    const db = getDb();
    const now = new Date().toISOString();
    const tenant = db.prepare(`SELECT slug FROM tenants WHERE id = ?`).get(tenantId) as { slug: string } | undefined;
    if (!tenant) return;

    const tx = db.transaction(() => {
      // MERGE (upsert) — do NOT wipe endpoints that exist only on VPS / BI
      const keepIds: string[] = [];
      const upsert = db.prepare(`
        INSERT INTO endpoints (
          id, tenant_id, tenant_slug, name, method, path_template, sql_query,
          params_schema, response_schema, cache_ttl_sec, auth_required, db_key,
          connection_id, database_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          method=excluded.method,
          path_template=excluded.path_template,
          sql_query=excluded.sql_query,
          params_schema=excluded.params_schema,
          response_schema=excluded.response_schema,
          cache_ttl_sec=excluded.cache_ttl_sec,
          auth_required=excluded.auth_required,
          db_key=excluded.db_key,
          connection_id=excluded.connection_id,
          database_name=excluded.database_name,
          updated_at=excluded.updated_at
      `);

      for (const ep of endpoints) {
        let path = ep.pathTemplate || '/';
        if (!path.startsWith('/')) path = `/${path}`;
        const method = String(ep.method || 'GET').toUpperCase();
        const dbKey = String(ep.dbKey || 'primary').toLowerCase();

        // Prefer stable id; else find by tenant+method+path
        let epId = (ep as any).id as string | undefined;
        if (!epId) {
          const found = db
            .prepare(
              `SELECT id FROM endpoints WHERE tenant_id = ? AND method = ? AND path_template = ? LIMIT 1`
            )
            .get(tenantId, method, path) as { id: string } | undefined;
          epId = found?.id || crypto.randomUUID();
        }
        keepIds.push(epId);

        upsert.run(
          epId,
          tenantId,
          tenant.slug,
          ep.name,
          method,
          path,
          ep.sqlQuery,
          JSON.stringify(ep.paramsSchema || {}),
          ep.responseSchema ? JSON.stringify(ep.responseSchema) : null,
          ep.cacheTtlSec || 0,
          ep.authRequired ? 1 : 0,
          dbKey,
          (ep as any).connectionId || '',
          (ep as any).database || '',
          now,
          now
        );
      }

      // Only delete local endpoints that match this device sync set when payload non-empty
      // and endpoint ids are explicitly provided — safer: delete by method+path not in keep set
      // only for endpoints that were in previous electron-owned set is hard; skip mass delete.
      // If endpoints array is empty, do not delete anything (protect VPS state).
      if (endpoints.length > 0 && keepIds.length > 0) {
        // Delete endpoints for this tenant whose id is NOT in keepIds AND method+path matches none of payload
        // Keep BI-created endpoints that electron didn't send only if they have different paths — actually
        // Electron is device authority for its tenants: remove orphans not in keepIds.
        const placeholders = keepIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM endpoints WHERE tenant_id = ? AND id NOT IN (${placeholders})`
        ).run(tenantId, ...keepIds);
      }
    });

    tx();
    logSync('sync', 'endpoint', tenantId, 'electron', { endpointCount: endpoints.length });
  },

  async listAll(): Promise<TenantRecord[]> {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM tenants`).all() as any[];

    return rows.map((row) => {
      const connections = db
        .prepare(`SELECT db_key as dbKey, label, database_name as database, db_conn_enc as dbConnEnc, db_conn_iv as dbConnIv FROM tenant_connections WHERE tenant_id = ?`)
        .all(row.id) as TenantConnectionRecord[];

      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        dbConnEnc: row.db_conn_enc,
        dbConnIv: row.db_conn_iv,
        isActive: Boolean(row.is_active),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        connections: connections.length > 0 ? connections : undefined,
      };
    });
  },

  async listAllEndpoints(): Promise<(EndpointConfig & { id?: string; tenantId?: string })[]> {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM endpoints`).all() as any[];

    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      tenantSlug: r.tenant_slug,
      name: r.name,
      method: r.method,
      pathTemplate: r.path_template,
      sqlQuery: r.sql_query,
      paramsSchema: JSON.parse(r.params_schema || '{}'),
      responseSchema: r.response_schema ? JSON.parse(r.response_schema) : undefined,
      cacheTtlSec: r.cache_ttl_sec,
      authRequired: Boolean(r.auth_required),
      dbKey: r.db_key,
      connectionId: r.connection_id,
      database: r.database_name,
    }));
  },
};

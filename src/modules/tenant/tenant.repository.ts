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
      db.prepare(`DELETE FROM endpoints WHERE tenant_id = ?`).run(tenantId);
      const stmt = db.prepare(`
        INSERT INTO endpoints (
          id, tenant_id, tenant_slug, name, method, path_template, sql_query,
          params_schema, response_schema, cache_ttl_sec, auth_required, db_key,
          connection_id, database_name, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `);

      for (const ep of endpoints) {
        const epId = (ep as any).id || crypto.randomUUID();
        stmt.run(
          epId,
          tenantId,
          tenant.slug,
          ep.name,
          ep.method,
          ep.pathTemplate,
          ep.sqlQuery,
          JSON.stringify(ep.paramsSchema || {}),
          ep.responseSchema ? JSON.stringify(ep.responseSchema) : null,
          ep.cacheTtlSec || 0,
          ep.authRequired ? 1 : 0,
          ep.dbKey || 'primary',
          (ep as any).connectionId || '',
          (ep as any).database || '',
          now,
          now
        );
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

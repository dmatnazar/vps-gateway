"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenantRepository = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const sqliteDb_1 = require("../../store/sqliteDb");
exports.tenantRepository = {
    async findBySlug(slug) {
        const db = (0, sqliteDb_1.getDb)();
        const row = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(slug);
        if (!row)
            return undefined;
        const connections = db
            .prepare(`SELECT db_key as dbKey, label, database_name as database, db_conn_enc as dbConnEnc, db_conn_iv as dbConnIv FROM tenant_connections WHERE tenant_id = ?`)
            .all(row.id);
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
    async create(input) {
        const db = (0, sqliteDb_1.getDb)();
        const now = new Date().toISOString();
        const id = node_crypto_1.default.randomUUID();
        db.prepare(`
      INSERT INTO tenants (id, slug, name, db_conn_enc, db_conn_iv, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, input.slug, input.name, input.dbConnEnc, input.dbConnIv, now, now);
        (0, sqliteDb_1.logSync)('create', 'tenant', id, 'electron', { slug: input.slug, name: input.name });
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
    async replaceConnections(tenantId, connections) {
        const db = (0, sqliteDb_1.getDb)();
        const now = new Date().toISOString();
        const cols = db.prepare(`PRAGMA table_info(tenant_connections)`).all().map((r) => r.name);
        const hasPrimary = cols.includes('is_primary');
        const hasHost = cols.includes('host');
        const tx = db.transaction(() => {
            db.prepare(`DELETE FROM tenant_connections WHERE tenant_id = ?`).run(tenantId);
            if (hasPrimary && hasHost) {
                const stmt = db.prepare(`
          INSERT INTO tenant_connections (
            tenant_id, db_key, label, database_name, db_conn_enc, db_conn_iv,
            host, port, username, encrypt, trust_server_certificate, is_primary, guid, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
                for (const c of connections) {
                    const anyC = c;
                    stmt.run(tenantId, c.dbKey, c.label || '', c.database || '', c.dbConnEnc, c.dbConnIv, anyC.host || '', anyC.port ?? 1433, anyC.username || '', anyC.encrypt === false ? 0 : 1, anyC.trustServerCertificate === false ? 0 : 1, anyC.isPrimary ? 1 : 0, anyC.guid || anyC.id || '', now);
                }
            }
            else {
                const stmt = db.prepare(`
          INSERT INTO tenant_connections (tenant_id, db_key, label, database_name, db_conn_enc, db_conn_iv)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
                for (const c of connections) {
                    stmt.run(tenantId, c.dbKey, c.label || '', c.database || '', c.dbConnEnc, c.dbConnIv);
                }
            }
            db.prepare(`UPDATE tenants SET updated_at = ? WHERE id = ?`).run(now, tenantId);
        });
        tx();
        (0, sqliteDb_1.logSync)('update', 'connection', tenantId, 'electron', { connectionCount: connections.length });
    },
    async updateConnection(tenantId, enc, iv) {
        const db = (0, sqliteDb_1.getDb)();
        const now = new Date().toISOString();
        db.prepare(`UPDATE tenants SET db_conn_enc = ?, db_conn_iv = ?, updated_at = ? WHERE id = ?`).run(enc, iv, now, tenantId);
        (0, sqliteDb_1.logSync)('update', 'tenant', tenantId, 'electron', { field: 'connection' });
    },
    async replaceEndpoints(tenantId, endpoints) {
        const db = (0, sqliteDb_1.getDb)();
        const now = new Date().toISOString();
        const tenant = db.prepare(`SELECT slug FROM tenants WHERE id = ?`).get(tenantId);
        if (!tenant)
            return;
        const tx = db.transaction(() => {
            // MERGE (upsert) — do NOT wipe endpoints that exist only on VPS / BI
            const keepIds = [];
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
                if (!path.startsWith('/'))
                    path = `/${path}`;
                const method = String(ep.method || 'GET').toUpperCase();
                const dbKey = String(ep.dbKey || 'primary').toLowerCase();
                // Prefer stable id; else find by tenant+method+path
                let epId = ep.id;
                if (!epId) {
                    const found = db
                        .prepare(`SELECT id FROM endpoints WHERE tenant_id = ? AND method = ? AND path_template = ? LIMIT 1`)
                        .get(tenantId, method, path);
                    epId = found?.id || node_crypto_1.default.randomUUID();
                }
                keepIds.push(epId);
                upsert.run(epId, tenantId, tenant.slug, ep.name, method, path, ep.sqlQuery, JSON.stringify(ep.paramsSchema || {}), ep.responseSchema ? JSON.stringify(ep.responseSchema) : null, ep.cacheTtlSec || 0, ep.authRequired ? 1 : 0, dbKey, ep.connectionId || '', ep.database || '', now, now);
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
                db.prepare(`DELETE FROM endpoints WHERE tenant_id = ? AND id NOT IN (${placeholders})`).run(tenantId, ...keepIds);
            }
        });
        tx();
        (0, sqliteDb_1.logSync)('sync', 'endpoint', tenantId, 'electron', { endpointCount: endpoints.length });
    },
    async listAll() {
        const db = (0, sqliteDb_1.getDb)();
        const rows = db.prepare(`SELECT * FROM tenants`).all();
        return rows.map((row) => {
            const connections = db
                .prepare(`SELECT db_key as dbKey, label, database_name as database, db_conn_enc as dbConnEnc, db_conn_iv as dbConnIv FROM tenant_connections WHERE tenant_id = ?`)
                .all(row.id);
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
    async listAllEndpoints() {
        const db = (0, sqliteDb_1.getDb)();
        const rows = db.prepare(`SELECT * FROM endpoints`).all();
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
//# sourceMappingURL=tenant.repository.js.map
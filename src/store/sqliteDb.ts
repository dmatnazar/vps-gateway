/**
 * SQLite database for the VPS gateway control-plane.
 * Replaces the old lowdb JSON file with a proper relational DB.
 *
 * Features:
 *   - WAL mode for concurrent reads
 *   - Automatic schema migration
 *   - Legacy JSON import (one-time migration from metadata.json)
 *   - sync_log audit trail for every mutation
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../config/env';

const CURRENT_SCHEMA_VERSION = 2;

// Resolve DB path: same directory as the old JSON, but .sqlite extension
const dbDir = path.dirname(path.resolve(env.DB_FILE));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const DB_PATH = path.join(dbDir, 'gateway.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  applySchema(_db);
  migrateFromJson(_db);

  return _db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function applySchema(db: Database.Database) {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion >= CURRENT_SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      db_conn_enc TEXT DEFAULT '',
      db_conn_iv TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      db_key TEXT NOT NULL,
      label TEXT DEFAULT '',
      database_name TEXT DEFAULT '',
      db_conn_enc TEXT NOT NULL,
      db_conn_iv TEXT NOT NULL,
      UNIQUE(tenant_id, db_key)
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      tenant_slug TEXT NOT NULL,
      name TEXT NOT NULL,
      method TEXT NOT NULL,
      path_template TEXT NOT NULL,
      sql_query TEXT NOT NULL,
      params_schema TEXT DEFAULT '{}',
      response_schema TEXT,
      cache_ttl_sec INTEGER DEFAULT 0,
      auth_required INTEGER DEFAULT 1,
      db_key TEXT DEFAULT 'primary',
      connection_id TEXT DEFAULT '',
      database_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      tenant_slug TEXT NOT NULL,
      tenant_slugs TEXT DEFAULT '[]',
      full_name TEXT NOT NULL,
      username TEXT NOT NULL,
      password_hash TEXT DEFAULT '',
      password_enc TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'viewer',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_staff_username ON staff(username);
    CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_slug);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      label TEXT DEFAULT '',
      scopes TEXT DEFAULT '[]',
      revoked INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      tenant_slug TEXT NOT NULL,
      tenant_name TEXT DEFAULT '',
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      username TEXT NOT NULL,
      password_hash TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_role TEXT DEFAULT 'viewer',
      reviewed_by TEXT,
      reviewed_at TEXT,
      note TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(username);

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      source TEXT NOT NULL DEFAULT 'electron',
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log_entity ON sync_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_sync_log_time ON sync_log(created_at);

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Record base version first, then incremental migrations
  db.prepare(
    `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))`
  ).run(Math.max(1, getSchemaVersion(db)));

  migrateToV2(db);
}

/** v2: edit locks (is_open) on tenants / staff / endpoints */
function migrateToV2(db: Database.Database) {
  const ver = getSchemaVersion(db);
  if (ver >= 2) return;

  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

  for (const table of ['tenants', 'staff', 'endpoints'] as const) {
    const existing = cols(table);
    if (!existing.includes('is_open')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN is_open INTEGER DEFAULT 0`);
    }
    if (!existing.includes('opened_at')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN opened_at TEXT`);
    }
    if (!existing.includes('opened_by')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN opened_by TEXT`);
    }
  }

  db.prepare(
    `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (2, datetime('now'))`
  ).run();
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
      )
      .get() as { name: string } | undefined;
    if (!row) return 0;
    const ver = db
      .prepare(`SELECT MAX(version) as v FROM schema_version`)
      .get() as { v: number } | undefined;
    return ver?.v ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// One-time migration from legacy metadata.json
// ---------------------------------------------------------------------------

function migrateFromJson(db: Database.Database) {
  const jsonPath = path.resolve(env.DB_FILE);
  if (!fs.existsSync(jsonPath)) return;

  // Check if we already have data in tenants table
  const count = (
    db.prepare(`SELECT COUNT(*) as c FROM tenants`).get() as { c: number }
  ).c;
  if (count > 0) return; // Already migrated

  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return;
  }

  console.log('📦 Migrating legacy metadata.json → SQLite...');

  const insertTenant = db.prepare(`
    INSERT OR IGNORE INTO tenants (id, slug, name, db_conn_enc, db_conn_iv, is_active, created_at, updated_at)
    VALUES (@id, @slug, @name, @dbConnEnc, @dbConnIv, @isActive, @createdAt, @updatedAt)
  `);
  const insertConn = db.prepare(`
    INSERT OR IGNORE INTO tenant_connections (tenant_id, db_key, label, database_name, db_conn_enc, db_conn_iv)
    VALUES (@tenantId, @dbKey, @label, @databaseName, @dbConnEnc, @dbConnIv)
  `);
  const insertEndpoint = db.prepare(`
    INSERT OR IGNORE INTO endpoints (id, tenant_id, tenant_slug, name, method, path_template, sql_query, params_schema, response_schema, cache_ttl_sec, auth_required, db_key, connection_id, database_name, created_at, updated_at)
    VALUES (@id, @tenantId, @tenantSlug, @name, @method, @pathTemplate, @sqlQuery, @paramsSchema, @responseSchema, @cacheTtlSec, @authRequired, @dbKey, @connectionId, @databaseName, @createdAt, @updatedAt)
  `);
  const insertStaff = db.prepare(`
    INSERT OR IGNORE INTO staff (id, tenant_slug, tenant_slugs, full_name, username, password_hash, password_enc, role, phone, email, active, created_at, updated_at)
    VALUES (@id, @tenantSlug, @tenantSlugs, @fullName, @username, @passwordHash, @passwordEnc, @role, @phone, @email, @active, @createdAt, @updatedAt)
  `);
  const insertReg = db.prepare(`
    INSERT OR IGNORE INTO registrations (id, tenant_slug, tenant_name, first_name, last_name, phone, email, username, password_hash, status, requested_role, reviewed_by, reviewed_at, note, delivered_at, created_at)
    VALUES (@id, @tenantSlug, @tenantName, @firstName, @lastName, @phone, @email, @username, @passwordHash, @status, @requestedRole, @reviewedBy, @reviewedAt, @note, @deliveredAt, @createdAt)
  `);
  const insertNotif = db.prepare(`
    INSERT OR IGNORE INTO notifications (id, username, type, title, message, read, created_at)
    VALUES (@id, @username, @type, @title, @message, @read, @createdAt)
  `);

  const tx = db.transaction(() => {
    const now = new Date().toISOString();

    // Tenants
    for (const t of data.tenants || []) {
      insertTenant.run({
        id: t.id,
        slug: t.slug,
        name: t.name,
        dbConnEnc: t.dbConnEnc || '',
        dbConnIv: t.dbConnIv || '',
        isActive: t.isActive ? 1 : 0,
        createdAt: t.createdAt || now,
        updatedAt: t.updatedAt || now,
      });
      for (const c of t.connections || []) {
        insertConn.run({
          tenantId: t.id,
          dbKey: c.dbKey || 'primary',
          label: c.label || '',
          databaseName: c.database || '',
          dbConnEnc: c.dbConnEnc || '',
          dbConnIv: c.dbConnIv || '',
        });
      }
    }

    // Endpoints
    for (const e of data.endpoints || []) {
      insertEndpoint.run({
        id: e.id,
        tenantId: e.tenantId || '',
        tenantSlug: e.tenantSlug || '',
        name: e.name || '',
        method: e.method || 'GET',
        pathTemplate: e.pathTemplate || '',
        sqlQuery: e.sqlQuery || '',
        paramsSchema: JSON.stringify(e.paramsSchema || {}),
        responseSchema: e.responseSchema ? JSON.stringify(e.responseSchema) : null,
        cacheTtlSec: e.cacheTtlSec || 0,
        authRequired: e.authRequired ? 1 : 0,
        dbKey: e.dbKey || 'primary',
        connectionId: e.connectionId || '',
        databaseName: e.database || '',
        createdAt: e.createdAt || now,
        updatedAt: e.updatedAt || now,
      });
    }

    // Staff
    for (const s of data.staff || []) {
      insertStaff.run({
        id: s.id,
        tenantSlug: s.tenantSlug || '',
        tenantSlugs: JSON.stringify(s.tenantSlugs || []),
        fullName: s.fullName || '',
        username: s.username || '',
        passwordHash: s.passwordHash || '',
        passwordEnc: s.passwordEnc || '',
        role: s.role || 'viewer',
        phone: s.phone || '',
        email: s.email || '',
        active: s.active !== false ? 1 : 0,
        createdAt: s.createdAt || now,
        updatedAt: s.updatedAt || now,
      });
    }

    // Registrations
    for (const r of data.registrations || []) {
      insertReg.run({
        id: r.id,
        tenantSlug: r.tenantSlug || '',
        tenantName: r.tenantName || '',
        firstName: r.firstName || '',
        lastName: r.lastName || '',
        phone: r.phone || '',
        email: r.email || '',
        username: r.username || '',
        passwordHash: r.passwordHash || '',
        status: r.status || 'pending',
        requestedRole: r.requestedRole || 'viewer',
        reviewedBy: r.reviewedBy || null,
        reviewedAt: r.reviewedAt || null,
        note: r.note || null,
        deliveredAt: r.deliveredAt || null,
        createdAt: r.createdAt || now,
      });
    }

    // Notifications
    for (const n of data.notifications || []) {
      insertNotif.run({
        id: n.id,
        username: n.username || '',
        type: n.type || '',
        title: n.title || '',
        message: n.message || '',
        read: n.read ? 1 : 0,
        createdAt: n.createdAt || now,
      });
    }
  });

  tx();
  console.log('✅ JSON → SQLite migration complete');

  // Rename old file so we don't re-migrate
  const backupPath = jsonPath + '.bak';
  try {
    fs.renameSync(jsonPath, backupPath);
    console.log(`📁 Old metadata.json backed up to ${backupPath}`);
  } catch {
    // non-critical
  }
}

// ---------------------------------------------------------------------------
// Audit / Sync Log Helper
// ---------------------------------------------------------------------------

export function logSync(
  action: 'create' | 'update' | 'delete' | 'sync',
  entityType: 'tenant' | 'staff' | 'endpoint' | 'connection' | 'registration' | 'notification',
  entityId: string | null,
  source: 'electron' | 'bi' | 'vps' | 'api',
  details?: Record<string, unknown>
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO sync_log (action, entity_type, entity_id, source, details, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(action, entityType, entityId, source, details ? JSON.stringify(details) : null);
}

export function getSyncLogs(opts?: {
  entityType?: string;
  entityId?: string;
  limit?: number;
}): Array<{
  id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  source: string;
  details: string | null;
  created_at: string;
}> {
  const db = getDb();
  let sql = 'SELECT * FROM sync_log WHERE 1=1';
  const params: unknown[] = [];
  if (opts?.entityType) {
    sql += ' AND entity_type = ?';
    params.push(opts.entityType);
  }
  if (opts?.entityId) {
    sql += ' AND entity_id = ?';
    params.push(opts.entityId);
  }
  sql += ' ORDER BY id DESC';
  if (opts?.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }
  return db.prepare(sql).all(...params) as any[];
}

// ---------------------------------------------------------------------------
// Close (for graceful shutdown)
// ---------------------------------------------------------------------------

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

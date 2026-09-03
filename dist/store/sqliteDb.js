"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.getAppSetting = getAppSetting;
exports.setAppSetting = setAppSetting;
exports.logSync = logSync;
exports.getSyncLogs = getSyncLogs;
exports.closeDb = closeDb;
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
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const env_1 = require("../config/env");
const CURRENT_SCHEMA_VERSION = 12;
// Resolve DB path: same directory as the old JSON, but .sqlite extension
const dbDir = node_path_1.default.dirname(node_path_1.default.resolve(env_1.env.DB_FILE));
if (!node_fs_1.default.existsSync(dbDir))
    node_fs_1.default.mkdirSync(dbDir, { recursive: true });
const DB_PATH = node_path_1.default.join(dbDir, 'gateway.db');
let _db = null;
function getDb() {
    if (_db)
        return _db;
    _db = new better_sqlite3_1.default(DB_PATH);
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
function applySchema(db) {
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
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))`).run(Math.max(1, getSchemaVersion(db)));
    migrateToV2(db);
    migrateToV3(db);
    migrateToV4(db);
    migrateToV5(db);
    migrateToV6(db);
    migrateToV7(db);
    migrateToV8(db);
    migrateToV9(db);
    migrateToV10(db);
    migrateToV11(db);
    migrateToV12(db);
}
/** v2: edit locks (is_open) on tenants / staff / endpoints */
function migrateToV2(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 2)
        return;
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    for (const table of ['tenants', 'staff', 'endpoints']) {
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
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (2, datetime('now'))`).run();
}
/** v3: devices table for multi-tenant hardware registration and approval */
function migrateToV3(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 3)
        return;
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (!cols('devices').includes('device_sync_secret')) {
        db.exec(`ALTER TABLE devices ADD COLUMN device_sync_secret TEXT DEFAULT ''`);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      os_platform TEXT NOT NULL,
      os_release TEXT NOT NULL,
      ram_gb REAL NOT NULL,
      cpu_model TEXT NOT NULL,
      mac_address TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      tenant_id TEXT,
      tenant_slug TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      app_version TEXT DEFAULT '1.0.0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_slug);
    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
  `);
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (3, datetime('now'))`).run();
}
/** v4: improved relationships, indexes, and device assignment tracking */
function migrateToV4(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 4)
        return;
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    // Add tenant_id foreign key reference to devices (SQLite doesn't enforce FK on ALTER, but we add the column)
    if (!cols('devices').includes('assigned_by')) {
        db.exec(`ALTER TABLE devices ADD COLUMN assigned_by TEXT DEFAULT ''`);
    }
    if (!cols('devices').includes('assigned_at')) {
        db.exec(`ALTER TABLE devices ADD COLUMN assigned_at TEXT`);
    }
    // Add indexes for common queries
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_tenant_id ON devices(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_endpoints_tenant_slug ON endpoints(tenant_slug);
    CREATE INDEX IF NOT EXISTS idx_staff_active ON staff(active);
  `);
    // Create device_assignments table for tracking endpoint-device relationships
    db.exec(`
    CREATE TABLE IF NOT EXISTS device_assignments (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      tenant_slug TEXT NOT NULL,
      endpoint_id TEXT,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_device_assignments_device ON device_assignments(device_id);
    CREATE INDEX IF NOT EXISTS idx_device_assignments_tenant ON device_assignments(tenant_slug);
  `);
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (4, datetime('now'))`).run();
}
/** v5: device-specific sync secret */
function migrateToV5(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 5)
        return;
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (!cols('devices').includes('device_sync_secret')) {
        db.exec(`ALTER TABLE devices ADD COLUMN device_sync_secret TEXT DEFAULT ''`);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (5, datetime('now'))`).run();
}
/** v6: app_settings (Electron update feed, client defaults) */
function migrateToV6(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 6)
        return;
    db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (6, datetime('now'))`).run();
}
/** v7: device_settings (per-device / per-tenant settings: autostart, etc.) */
function migrateToV7(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 7)
        return;
    db.exec(`
    CREATE TABLE IF NOT EXISTS device_settings (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      tenant_slug TEXT NOT NULL DEFAULT '',
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT DEFAULT '',
      UNIQUE(device_id, tenant_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_device_settings_device ON device_settings(device_id);
    CREATE INDEX IF NOT EXISTS idx_device_settings_tenant ON device_settings(tenant_slug);
  `);
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (7, datetime('now'))`).run();
}
/** v8: structured DB connection meta (host/port/user…) for BI admin UI */
function migrateToV8(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 8)
        return;
    const cols = db.prepare(`PRAGMA table_info(tenant_connections)`).all().map((r) => r.name);
    const add = (name, ddl) => {
        if (!cols.includes(name))
            db.exec(`ALTER TABLE tenant_connections ADD COLUMN ${ddl}`);
    };
    add('host', 'host TEXT DEFAULT \'\'');
    add('port', 'port INTEGER DEFAULT 1433');
    add('username', 'username TEXT DEFAULT \'\'');
    add('encrypt', 'encrypt INTEGER DEFAULT 1');
    add('trust_server_certificate', 'trust_server_certificate INTEGER DEFAULT 1');
    add('is_primary', 'is_primary INTEGER DEFAULT 0');
    add('guid', 'guid TEXT DEFAULT \'\'');
    add('updated_at', 'updated_at TEXT');
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (8, datetime('now'))`).run();
}
function getAppSetting(key) {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
    return row?.value ?? '';
}
function setAppSetting(key, value) {
    const db = getDb();
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value);
}
function getSchemaVersion(db) {
    try {
        const row = db
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
            .get();
        if (!row)
            return 0;
        const ver = db
            .prepare(`SELECT MAX(version) as v FROM schema_version`)
            .get();
        return ver?.v ?? 0;
    }
    catch {
        return 0;
    }
}
// ---------------------------------------------------------------------------
// One-time migration from legacy metadata.json
// ---------------------------------------------------------------------------
function migrateFromJson(db) {
    const jsonPath = node_path_1.default.resolve(env_1.env.DB_FILE);
    if (!node_fs_1.default.existsSync(jsonPath))
        return;
    // Check if we already have data in tenants table
    const count = db.prepare(`SELECT COUNT(*) as c FROM tenants`).get().c;
    if (count > 0)
        return; // Already migrated
    let data;
    try {
        data = JSON.parse(node_fs_1.default.readFileSync(jsonPath, 'utf8'));
    }
    catch {
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
        node_fs_1.default.renameSync(jsonPath, backupPath);
        console.log(`📁 Old metadata.json backed up to ${backupPath}`);
    }
    catch {
        // non-critical
    }
}
/** v9: tariffs, wallets, ledger, tenant subscriptions (billing) */
function migrateToV9(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS tariffs (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price_monthly REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'TMT',
      included_credits INTEGER NOT NULL DEFAULT 0,
      max_staff INTEGER NOT NULL DEFAULT 5,
      max_api_calls_day INTEGER NOT NULL DEFAULT 100,
      max_connections INTEGER NOT NULL DEFAULT 2,
      features_json TEXT DEFAULT '{}',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_wallets (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      tenant_slug TEXT NOT NULL,
      balance_credits REAL NOT NULL DEFAULT 0,
      low_balance_threshold REAL NOT NULL DEFAULT 50,
      warn_sent_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      tenant_slug TEXT NOT NULL,
      staff_id TEXT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      reason TEXT DEFAULT '',
      ref_id TEXT,
      created_by TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_tenant ON wallet_ledger(tenant_slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_type ON wallet_ledger(type);

    CREATE TABLE IF NOT EXISTS tenant_subscriptions (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      tenant_slug TEXT NOT NULL,
      tariff_id TEXT NOT NULL REFERENCES tariffs(id),
      status TEXT NOT NULL DEFAULT 'active',
      period_start TEXT,
      period_end TEXT,
      auto_renew INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);
    const now = new Date().toISOString();
    const seed = db.prepare(`
    INSERT OR IGNORE INTO tariffs (
      id, code, name, description, price_monthly, currency,
      included_credits, max_staff, max_api_calls_day, max_connections,
      features_json, sort_order, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
    const tariffs = [
        ['tariff_free', 'free', 'Free', 'Başlangyç — kiçi firmalar üçin', 0, 'TMT', 500, 3, 100, 1, '{"sql_studio":true}', 0],
        ['tariff_starter', 'starter', 'Starter', 'Kiçi-orta biznes', 50, 'TMT', 5000, 10, 1000, 3, '{"sql_studio":true,"export":true}', 1],
        ['tariff_business', 'business', 'Business', 'Ösýän firmalar', 200, 'TMT', 25000, 50, 10000, 10, '{"sql_studio":true,"export":true,"priority":true}', 2],
    ];
    for (const t of tariffs) {
        seed.run(...t, now, now);
    }
    // Ensure every existing tenant has wallet + free subscription
    const freeId = 'tariff_free';
    const tenants = db.prepare(`SELECT id, slug FROM tenants`).all();
    const insWallet = db.prepare(`
    INSERT OR IGNORE INTO tenant_wallets (tenant_id, tenant_slug, balance_credits, low_balance_threshold, updated_at)
    VALUES (?, ?, ?, 50, ?)
  `);
    const insSub = db.prepare(`
    INSERT OR IGNORE INTO tenant_subscriptions (tenant_id, tenant_slug, tariff_id, status, period_start, period_end, auto_renew, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, 1, ?)
  `);
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    for (const t of tenants) {
        insWallet.run(t.id, t.slug, 500, now); // start with free included credits
        insSub.run(t.id, t.slug, freeId, now, periodEnd, now);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (9, datetime('now'))`).run();
    console.log('✅ schema v9: billing (tariffs, wallets, ledger)');
}
/**
 * v10: device_app_settings — structured per-device Electron settings (columns, not only JSON blob).
 * Also keeps device_settings.settings_json in sync for older clients.
 */
function migrateToV10(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 10)
        return;
    db.exec(`
    CREATE TABLE IF NOT EXISTS device_app_settings (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      tenant_slug TEXT NOT NULL DEFAULT '',
      autostart INTEGER NOT NULL DEFAULT 0,
      start_minimized INTEGER NOT NULL DEFAULT 0,
      tray_minimize INTEGER NOT NULL DEFAULT 1,
      auto_login INTEGER NOT NULL DEFAULT 0,
      auto_sync INTEGER NOT NULL DEFAULT 1,
      sync_interval_sec INTEGER NOT NULL DEFAULT 30,
      offline_queue INTEGER NOT NULL DEFAULT 1,
      notify_on_sync INTEGER NOT NULL DEFAULT 1,
      auto_sign_out_min INTEGER NOT NULL DEFAULT 0,
      theme TEXT NOT NULL DEFAULT 'dark',
      language TEXT NOT NULL DEFAULT 'tk',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT DEFAULT '',
      UNIQUE(device_id, tenant_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_device_app_settings_device ON device_app_settings(device_id);
    CREATE INDEX IF NOT EXISTS idx_device_app_settings_tenant ON device_app_settings(tenant_slug);
  `);
    // Migrate from legacy device_settings.settings_json
    try {
        const rows = db.prepare(`SELECT * FROM device_settings`).all();
        const ins = db.prepare(`
      INSERT OR REPLACE INTO device_app_settings (
        id, device_id, tenant_slug,
        autostart, start_minimized, tray_minimize, auto_login,
        auto_sync, sync_interval_sec, offline_queue, notify_on_sync,
        auto_sign_out_min, theme, language, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        for (const r of rows) {
            let s = {};
            try {
                s = JSON.parse(r.settings_json || '{}');
            }
            catch {
                s = {};
            }
            // Prefer explicit seconds; if only minutes were stored, convert
            let sec = Number(s.syncIntervalSec ?? s.sync_interval_sec ?? 0);
            if (!sec || sec <= 0) {
                const min = Number(s.syncIntervalMin ?? s.sync_interval_min ?? 0);
                sec = min > 0 ? Math.round(min * 60) : 30;
            }
            // Heuristic: values 1–14 that were meant as minutes → seconds
            if (sec > 0 && sec <= 14 && s.syncIntervalSec == null && s.sync_interval_sec == null) {
                sec = sec * 60;
            }
            ins.run(r.id || `das_${r.device_id}`, r.device_id, r.tenant_slug || '', s.autostart ? 1 : 0, s.startMinimized || s.start_minimized ? 1 : 0, s.trayMinimize === false || s.tray_minimize === false ? 0 : 1, s.autoLogin || s.auto_login ? 1 : 0, s.autoSync === false || s.auto_sync === false ? 0 : 1, sec, s.offlineQueue === false || s.offline_queue === false ? 0 : 1, s.notifyOnSync === false || s.notify_on_sync === false ? 0 : 1, Math.max(0, Number(s.autoSignOutMin ?? s.auto_sign_out_min ?? 0) || 0), String(s.theme || 'dark'), String(s.language || 'tk'), r.updated_at || new Date().toISOString(), r.updated_by || '');
        }
    }
    catch (e) {
        console.warn('[migrate v10] device_settings import', e);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (10, datetime('now'))`).run();
    console.log('✅ schema v10: device_app_settings (structured Electron settings)');
}
/** v11: auto_login_username on device_app_settings */
function migrateToV11(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 11)
        return;
    try {
        const cols = db.prepare(`PRAGMA table_info(device_app_settings)`).all().map((r) => r.name);
        if (!cols.includes('auto_login_username')) {
            db.exec(`ALTER TABLE device_app_settings ADD COLUMN auto_login_username TEXT DEFAULT ''`);
        }
    }
    catch (e) {
        console.warn('[migrate v11]', e);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (11, datetime('now'))`).run();
    console.log('✅ schema v11: device_app_settings.auto_login_username');
}
/** v12: 1 firm = 1 device — dedupe device_assignments + UNIQUE(tenant_slug) */
function migrateToV12(db) {
    const ver = getSchemaVersion(db);
    if (ver >= 12)
        return;
    try {
        // Keep newest assignment per tenant_slug; drop older duplicates that caused FIRM_ALREADY_ASSIGNED
        db.exec(`
      DELETE FROM device_assignments
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY tenant_slug
                   ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, rowid DESC
                 ) AS rn
          FROM device_assignments
        ) ranked
        WHERE rn = 1
      );
    `);
    }
    catch (e) {
        // SQLite without window functions (very old) — fallback: keep max(created_at) per slug
        console.warn('[migrate v12] window dedupe failed, using fallback', e);
        try {
            const rows = db
                .prepare(`SELECT tenant_slug, id, created_at, updated_at FROM device_assignments ORDER BY tenant_slug, datetime(COALESCE(updated_at, created_at)) DESC`)
                .all();
            const seen = new Set();
            const del = db.prepare(`DELETE FROM device_assignments WHERE id = ?`);
            const tx = db.transaction(() => {
                for (const r of rows) {
                    if (seen.has(r.tenant_slug))
                        del.run(r.id);
                    else
                        seen.add(r.tenant_slug);
                }
            });
            tx();
        }
        catch (e2) {
            console.warn('[migrate v12] fallback dedupe failed', e2);
        }
    }
    try {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_assignments_tenant_unique ON device_assignments(tenant_slug)`);
    }
    catch (e) {
        console.warn('[migrate v12] unique index failed (duplicates remain?)', e);
    }
    // Also prevent same device+tenant double rows
    try {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_assignments_device_tenant ON device_assignments(device_id, tenant_slug)`);
    }
    catch (e) {
        console.warn('[migrate v12] device+tenant unique index failed', e);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (12, datetime('now'))`).run();
    console.log('✅ schema v12: device_assignments 1-firm-1-device unique + dedupe');
}
// ---------------------------------------------------------------------------
// Audit / Sync Log Helper
// ---------------------------------------------------------------------------
function logSync(action, entityType, entityId, source, details) {
    const db = getDb();
    db.prepare(`INSERT INTO sync_log (action, entity_type, entity_id, source, details, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(action, entityType, entityId, source, details ? JSON.stringify(details) : null);
}
function getSyncLogs(opts) {
    const db = getDb();
    let sql = 'SELECT * FROM sync_log WHERE 1=1';
    const params = [];
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
    return db.prepare(sql).all(...params);
}
// ---------------------------------------------------------------------------
// Close (for graceful shutdown)
// ---------------------------------------------------------------------------
function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
    }
}
//# sourceMappingURL=sqliteDb.js.map
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.catalogHandler = catalogHandler;
exports.createTenantHandler = createTenantHandler;
exports.syncStaffHandler = syncStaffHandler;
exports.staffLookupHandler = staffLookupHandler;
exports.staffVerifyHandler = staffVerifyHandler;
exports.createRegistrationHandler = createRegistrationHandler;
exports.getRegistrationHandler = getRegistrationHandler;
exports.listRegistrationsHandler = listRegistrationsHandler;
exports.updateRegistrationHandler = updateRegistrationHandler;
exports.resolveRegistrationHandler = resolveRegistrationHandler;
exports.listNotificationsHandler = listNotificationsHandler;
exports.markNotificationsReadHandler = markNotificationsReadHandler;
exports.tenantUpdateHandler = tenantUpdateHandler;
exports.endpointUpdateHandler = endpointUpdateHandler;
exports.endpointCreateHandler = endpointCreateHandler;
exports.endpointDeleteHandler = endpointDeleteHandler;
exports.deviceSettingsGetHandler = deviceSettingsGetHandler;
exports.deviceSettingsUpsertHandler = deviceSettingsUpsertHandler;
exports.deviceCommandHandler = deviceCommandHandler;
exports.listDatabasesHandler = listDatabasesHandler;
exports.testQueryHandler = testQueryHandler;
exports.entityLockHandler = entityLockHandler;
exports.tenantDeleteHandler = tenantDeleteHandler;
exports.staffUpsertHandler = staffUpsertHandler;
exports.staffDeleteHandler = staffDeleteHandler;
exports.deviceRegisterHandler = deviceRegisterHandler;
exports.deviceStatusHandler = deviceStatusHandler;
exports.listDevicesHandler = listDevicesHandler;
exports.approveDeviceHandler = approveDeviceHandler;
exports.updateDeviceStatusHandler = updateDeviceStatusHandler;
exports.deleteDeviceHandler = deleteDeviceHandler;
exports.connectionUpsertHandler = connectionUpsertHandler;
exports.connectionDeleteHandler = connectionDeleteHandler;
exports.staffPasswordResetHandler = staffPasswordResetHandler;
exports.debugRoutesHandler = debugRoutesHandler;
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const sqliteDb_1 = require("../../store/sqliteDb");
const tenant_repository_1 = require("../tenant/tenant.repository");
const passwordEnc_1 = require("../../core/db/passwordEnc");
const crypto_1 = require("../../core/db/crypto");
const connectionPoolManager_1 = require("../../core/db/connectionPoolManager");
const deviceEventManager_1 = require("../../core/tunnel/deviceEventManager");
const randomId = () => {
    if (typeof node_crypto_1.default.randomUUID === 'function') {
        return node_crypto_1.default.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
};
// ── Catalog ──────────────────────────────────────────────────
/** Update devices.last_seen_at when Electron identifies itself */
function touchDeviceLastSeen(req) {
    try {
        const h = req.headers;
        const id = (typeof h['x-device-id'] === 'string' && h['x-device-id']) ||
            (typeof h['x-deviceid'] === 'string' && h['x-deviceid']) ||
            '';
        if (!id)
            return;
        const now = new Date().toISOString();
        const db = (0, sqliteDb_1.getDb)();
        db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    }
    catch (e) {
        console.warn('[touchDeviceLastSeen]', e);
    }
}
async function catalogHandler(req, reply) {
    touchDeviceLastSeen(req);
    const db = (0, sqliteDb_1.getDb)();
    // Return all tenants (active + passive) so admin UIs can show / reactivate them
    const tenantRows = db.prepare(`SELECT * FROM tenants`).all();
    // Tell Electron which firms are assigned to this device. This is important when
    // an Electron sync auto-created the assignment but the local device profile is stale.
    const catalogDeviceId = String((req.headers['x-device-id'] || req.headers['X-Device-Id'] || '') || '');
    const deviceTenantSlugs = catalogDeviceId
        ? db.prepare(`SELECT tenant_slug FROM device_assignments WHERE device_id = ?`).all(catalogDeviceId)
            .map((r) => String(r.tenant_slug || '').trim())
            .filter(Boolean)
        : [];
    const connStmt = db.prepare(`SELECT * FROM tenant_connections WHERE tenant_id = ?`);
    // Multi-tenant: count staff whose primary tenant matches OR tenant_slugs JSON lists this slug
    const staffCountStmt = db.prepare(`SELECT COUNT(*) as c FROM staff
     WHERE active = 1 AND (
       tenant_slug = ?
       OR tenant_slugs LIKE '%"' || ? || '"%'
     )`);
    const epCountStmt = db.prepare(`SELECT COUNT(*) as c FROM endpoints WHERE tenant_slug = ?`);
    const deviceCountStmt = db.prepare(`SELECT COUNT(*) as c FROM devices WHERE tenant_slug = ? OR id IN (SELECT device_id FROM device_assignments WHERE tenant_slug = ?)`);
    const tenants = tenantRows.map((t) => {
        const rawConns = connStmt.all(t.id);
        const connections = rawConns.map((c) => {
            let host = c.host || '';
            let port = c.port ?? 1433;
            let username = c.username || '';
            let database = c.database_name || '';
            let password = '';
            let encrypt = c.encrypt === undefined ? true : Boolean(c.encrypt);
            let trustServerCertificate = c.trust_server_certificate === undefined ? true : Boolean(c.trust_server_certificate);
            // Decrypt stored connection string so BI edit form gets Host/User/Password
            if (c.db_conn_enc && c.db_conn_iv) {
                try {
                    const plain = (0, crypto_1.decryptConnString)(c.db_conn_enc, c.db_conn_iv);
                    const parsed = (0, connectionPoolManager_1.parseConnectionString)(plain);
                    if (!host)
                        host = parsed.server || '';
                    if (!port)
                        port = parsed.port || 1433;
                    if (!username)
                        username = parsed.user || '';
                    if (!database)
                        database = parsed.database || '';
                    if (parsed.password)
                        password = parsed.password;
                    encrypt = parsed.encrypt;
                    trustServerCertificate = parsed.trustServerCertificate;
                }
                catch (e) {
                    console.warn('[catalog] decrypt conn', c.id, e);
                }
            }
            return {
                id: String(c.id),
                guid: c.guid || String(c.id),
                dbKey: c.db_key,
                label: c.label || c.db_key,
                database,
                host,
                port,
                username,
                password, // admin catalog only — needed for BI edit form
                encrypt,
                trustServerCertificate,
                isPrimary: Boolean(c.is_primary),
                hasPassword: Boolean(c.db_conn_enc || password),
                updatedAt: c.updated_at || null,
            };
        });
        let billing = null;
        try {
            const w = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(t.id);
            const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(t.id);
            let tariff = null;
            if (sub?.tariff_id) {
                tariff = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(sub.tariff_id);
            }
            if (w) {
                const bal = Number(w.balance_credits) || 0;
                const thr = Number(w.low_balance_threshold) || 50;
                let level = 'ok';
                if (bal <= 0)
                    level = 'empty';
                else if (bal <= thr * 0.25)
                    level = 'critical';
                else if (bal <= thr)
                    level = 'low';
                billing = {
                    balanceCredits: bal,
                    lowBalanceThreshold: thr,
                    level,
                    warning: level === 'empty'
                        ? 'Balans gutardy'
                        : level === 'critical'
                            ? 'Balans critiki pes'
                            : level === 'low'
                                ? 'Balans pes'
                                : null,
                    tariffCode: tariff?.code || null,
                    tariffName: tariff?.name || null,
                    priceMonthly: tariff ? Number(tariff.price_monthly) : null,
                    currency: tariff?.currency || 'TMT',
                    maxStaff: tariff ? Number(tariff.max_staff) : null,
                    maxApiCallsDay: tariff ? Number(tariff.max_api_calls_day) : null,
                    subscriptionStatus: sub?.status || null,
                };
            }
        }
        catch {
            /* billing tables may not exist yet */
        }
        return {
            id: t.id,
            slug: t.slug,
            name: t.name,
            isActive: Boolean(t.is_active),
            connections,
            connectionCount: connections.length,
            staffCount: staffCountStmt.get(t.slug, t.slug)?.c ?? 0,
            endpointCount: epCountStmt.get(t.slug)?.c ?? 0,
            deviceCount: deviceCountStmt.get(t.slug, t.slug)?.c ?? 0,
            billing,
            updatedAt: t.updated_at,
            createdAt: t.created_at,
        };
    });
    const endpointRows = db.prepare(`SELECT * FROM endpoints`).all();
    const endpoints = endpointRows.map((e) => ({
        id: e.id,
        tenantId: e.tenant_id,
        tenantSlug: e.tenant_slug,
        name: e.name,
        method: e.method,
        pathTemplate: e.path_template,
        sqlQuery: e.sql_query || '',
        paramsSchema: JSON.parse(e.params_schema || '{}'),
        responseSchema: e.response_schema ? JSON.parse(e.response_schema) : null,
        cacheTtlSec: e.cache_ttl_sec,
        authRequired: Boolean(e.auth_required),
        dbKey: e.db_key,
        connectionId: e.connection_id || '',
        databaseName: e.database_name || '',
        updatedAt: e.updated_at,
        createdAt: e.created_at,
    }));
    const staffRows = db.prepare(`SELECT * FROM staff`).all();
    const staff = staffRows.map((s) => {
        let password = '';
        try {
            if (s.password_enc)
                password = (0, passwordEnc_1.decryptPasswordPlain)(s.password_enc) || '';
        }
        catch {
            /* */
        }
        return {
            id: s.id,
            tenantSlug: s.tenant_slug,
            tenantSlugs: JSON.parse(s.tenant_slugs || '[]'),
            fullName: s.full_name,
            username: s.username,
            role: s.role,
            phone: s.phone,
            email: s.email,
            active: Boolean(s.active),
            passwordEnc: s.password_enc,
            password, // plaintext for BI/Electron admin forms (HMAC-protected admin catalog)
            updatedAt: s.updated_at,
            createdAt: s.created_at,
        };
    });
    const deviceRows = db.prepare(`
    SELECT d.*, t.name as company_name, t.slug as company_slug,
      GROUP_CONCAT(DISTINCT da.tenant_slug) as all_tenant_slugs,
      GROUP_CONCAT(DISTINCT tn.name) as all_tenant_names
    FROM devices d
    LEFT JOIN tenants t ON d.tenant_slug = t.slug
    LEFT JOIN device_assignments da ON d.id = da.device_id
    LEFT JOIN tenants tn ON da.tenant_slug = tn.slug
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all();
    const devices = deviceRows.map((d) => {
        const companySlugs = d.all_tenant_slugs ? d.all_tenant_slugs.split(',') : (d.company_slug ? [d.company_slug] : []);
        const companyNames = d.all_tenant_names ? d.all_tenant_names.split(',') : (d.company_name ? [d.company_name] : []);
        return {
            id: d.id,
            name: d.name,
            hostname: d.hostname,
            osPlatform: d.os_platform,
            osRelease: d.os_release,
            ramGb: d.ram_gb,
            cpuModel: d.cpu_model,
            macAddress: d.mac_address,
            ipAddress: d.ip_address,
            tenantId: d.tenant_id,
            tenantSlug: d.tenant_slug || d.company_slug || '',
            companyName: d.company_name || '',
            companySlugs,
            companyNames,
            status: d.status,
            appVersion: d.app_version,
            lastSeenAt: d.last_seen_at,
            createdAt: d.created_at,
            updatedAt: d.updated_at,
        };
    });
    // Device settings (Firma Sazlamalary)
    let deviceSettings = [];
    try {
        const dsRows = db.prepare(`SELECT * FROM device_settings`).all();
        deviceSettings = dsRows.map((r) => ({
            id: r.id,
            deviceId: r.device_id,
            tenantSlug: r.tenant_slug || '',
            settings: JSON.parse(r.settings_json || '{}'),
            updatedAt: r.updated_at,
            updatedBy: r.updated_by || '',
        }));
    }
    catch {
        /* table may not exist yet before migration */
    }
    return reply.send({
        tenants,
        endpoints,
        staff,
        devices,
        deviceSettings,
        // Device-scoped assignment list used by Electron to pull newly assigned companies.
        deviceTenantSlugs,
        syncedAt: new Date().toISOString(),
    });
}
// ── Tenant (Company) CRUD ─────────────────────────────────────
const CreateTenantSchema = zod_1.z.object({
    slug: zod_1.z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
    name: zod_1.z.string().min(1).max(200),
});
/** Electron device creates tenant → auto-assign that device (no BI step required) */
function ensureDeviceAssignment(db, deviceId, tenantSlug) {
    if (!deviceId || !tenantSlug)
        return { ok: true };
    try {
        const device = db.prepare(`SELECT id, status FROM devices WHERE id = ?`).get(deviceId);
        if (!device)
            return { ok: false, error: 'Device not found' };
        // 1 firm = 1 device: block if another device already has this firm
        const other = db
            .prepare(`SELECT device_id FROM device_assignments WHERE tenant_slug = ? AND device_id != ? LIMIT 1`)
            .get(tenantSlug, deviceId);
        if (other?.device_id) {
            return {
                ok: false,
                error: `Firma "${tenantSlug}" eýýäm başga enjama bagly. Bir firma diňe bir enjama baglanyp bilýär.`,
            };
        }
        const exists = db
            .prepare(`SELECT id FROM device_assignments WHERE device_id = ? AND tenant_slug = ?`)
            .get(deviceId, tenantSlug);
        if (exists)
            return { ok: true };
        const now = new Date().toISOString();
        const { randomUUID } = require('crypto');
        // Defensive: drop any stale same-slug rows (should be none after v12 unique index)
        db.prepare(`DELETE FROM device_assignments WHERE tenant_slug = ? AND device_id != ?`).run(tenantSlug, deviceId);
        db.prepare(`INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'auto-from-electron', ?, ?)`).run(randomUUID(), deviceId, tenantSlug, now, now);
        db.prepare(`UPDATE devices SET tenant_slug = COALESCE(NULLIF(tenant_slug, ''), ?), last_seen_at = ?, updated_at = ? WHERE id = ?`).run(tenantSlug, now, now, deviceId);
        return { ok: true };
    }
    catch (e) {
        console.warn('[ensureDeviceAssignment]', e);
        return { ok: false, error: String(e) };
    }
}
/** Admin explicitly assigns firms to a device: move firm off any other device (intentional transfer). */
function claimTenantAssignments(db, deviceId, tenantSlugs, description = 'admin-assign') {
    if (!deviceId || !tenantSlugs.length)
        return;
    const now = new Date().toISOString();
    const { randomUUID } = require('crypto');
    const insert = db.prepare(`INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`);
    const delOther = db.prepare(`DELETE FROM device_assignments WHERE tenant_slug = ? AND device_id != ?`);
    const hasPair = db.prepare(`SELECT id FROM device_assignments WHERE device_id = ? AND tenant_slug = ?`);
    const tx = db.transaction(() => {
        for (const slug of tenantSlugs) {
            if (!slug)
                continue;
            // 1 firm = 1 device: release firm from any other device first
            delOther.run(slug, deviceId);
            if (!hasPair.get(deviceId, slug)) {
                insert.run(randomUUID(), deviceId, slug, description, now, now);
            }
        }
    });
    tx();
}
async function createTenantHandler(req, reply) {
    const parsed = CreateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { slug, name } = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const deviceId = req.headers['x-device-id'] ||
        req.body?.deviceId ||
        undefined;
    const existing = db.prepare(`SELECT id FROM tenants WHERE slug = ?`).get(slug);
    if (existing) {
        // Already exists — try auto-assign; surface firm-already-on-other-device clearly
        const assign = ensureDeviceAssignment(db, deviceId, slug);
        if (!assign.ok && assign.error) {
            return reply.code(409).send({
                error: assign.error,
                code: 'FIRM_ALREADY_ASSIGNED',
                tenantId: existing.id,
            });
        }
        return reply.code(409).send({ error: `Tenant "${slug}" already exists`, tenantId: existing.id, assigned: Boolean(deviceId) });
    }
    const now = new Date().toISOString();
    const id = randomId();
    db.prepare(`
    INSERT INTO tenants (id, slug, name, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(id, slug, name, now, now);
    const assign = ensureDeviceAssignment(db, deviceId, slug);
    if (!assign.ok && assign.error) {
        // Tenant created but firm locked to another device — still report conflict
        return reply.code(409).send({
            error: assign.error,
            code: 'FIRM_ALREADY_ASSIGNED',
            tenantId: id,
        });
    }
    (0, sqliteDb_1.logSync)('create', 'tenant', id, deviceId ? 'api' : 'bi_admin', { slug, name, deviceId });
    return reply.send({
        ok: true,
        tenant: { id, slug, name, isActive: true, createdAt: now, updatedAt: now },
        deviceAssigned: Boolean(deviceId),
    });
}
// ── Staff sync ───────────────────────────────────────────────
const StaffSyncSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    staff: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().min(1),
        fullName: zod_1.z.string().min(1),
        username: zod_1.z.string().min(1),
        passwordHash: zod_1.z.string().min(1),
        role: zod_1.z.enum(['admin', 'editor', 'manager', 'viewer']),
        tenantSlugs: zod_1.z.array(zod_1.z.string()).optional(),
        phone: zod_1.z.string().optional(),
        email: zod_1.z.string().optional(),
        active: zod_1.z.boolean().default(true),
        passwordEnc: zod_1.z.string().optional(),
        passwordPlain: zod_1.z.string().optional(),
    })),
});
async function syncStaffHandler(req, reply) {
    touchDeviceLastSeen(req);
    const parsed = StaffSyncSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { tenantSlug, staff } = parsed.data;
    const tenant = await tenant_repository_1.tenantRepository.findBySlug(tenantSlug);
    if (!tenant) {
        return reply.code(404).send({ error: `Tenant "${tenantSlug}" not found. Sync schema first.` });
    }
    const db = (0, sqliteDb_1.getDb)();
    const now = new Date().toISOString();
    const isPlaceholder = (hash) => !hash ||
        hash.startsWith('synced-from-bi') ||
        hash.startsWith('pending-reset') ||
        hash.endsWith(':0000');
    // Primary-tenant filter (for optional replace cleanup only)
    const existingForTenant = db
        .prepare(`SELECT * FROM staff WHERE tenant_slug = ?`)
        .all(tenantSlug);
    // Multi-tenant: password / id must be resolved globally by username (staff may have
    // tenant_slug = another company while tenant_slugs JSON still lists this one)
    const allStaffRows = db.prepare(`SELECT * FROM staff`).all();
    const byUsername = new Map(allStaffRows.map((s) => [String(s.username || '').toLowerCase(), s]));
    const upsertStmt = db.prepare(`
    INSERT INTO staff (id, tenant_slug, tenant_slugs, full_name, username, password_hash, password_enc, role, phone, email, active, created_at, updated_at)
    VALUES (@id, @tenantSlug, @tenantSlugs, @fullName, @username, @passwordHash, @passwordEnc, @role, @phone, @email, @active, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      tenant_slug = excluded.tenant_slug,
      tenant_slugs = excluded.tenant_slugs,
      full_name = excluded.full_name,
      username = excluded.username,
      password_hash = excluded.password_hash,
      password_enc = excluded.password_enc,
      role = excluded.role,
      phone = excluded.phone,
      email = excluded.email,
      active = excluded.active,
      updated_at = excluded.updated_at
  `);
    const incomingUsernames = new Set(staff.map((s) => String(s.username || '').toLowerCase()).filter(Boolean));
    const tx = db.transaction(() => {
        for (const s of staff) {
            const prev = byUsername.get(s.username.toLowerCase());
            let passwordHash = s.passwordHash;
            if (isPlaceholder(passwordHash) && prev && !isPlaceholder(prev.password_hash)) {
                passwordHash = prev.password_hash;
            }
            const passwordEnc = s.passwordPlain
                ? (0, passwordEnc_1.encryptPasswordPlain)(s.passwordPlain)
                : s.passwordEnc || prev?.password_enc || '';
            upsertStmt.run({
                id: prev?.id || s.id,
                tenantSlug,
                tenantSlugs: JSON.stringify(s.tenantSlugs?.length ? s.tenantSlugs : [tenantSlug]),
                fullName: s.fullName,
                username: s.username,
                passwordHash,
                passwordEnc,
                role: s.role,
                phone: s.phone ?? prev?.phone ?? '',
                email: s.email ?? prev?.email ?? '',
                active: s.active ? 1 : 0,
                createdAt: prev?.created_at || now,
                updatedAt: now,
            });
        }
        // NEVER wipe staff on empty/partial sync — only explicit staff-delete API removes rows.
        // Empty payload used to DELETE ALL staff for the tenant (data-loss bug).
        const replaceStaff = Boolean(parsed.data.replace === true);
        if (replaceStaff && staff.length >= 0) {
            for (const prev of existingForTenant) {
                if (!incomingUsernames.has(String(prev.username || '').toLowerCase())) {
                    db.prepare(`DELETE FROM staff WHERE id = ?`).run(prev.id);
                }
            }
        }
    });
    tx();
    (0, sqliteDb_1.logSync)('sync', 'staff', tenant.id, 'electron', { count: staff.length, tenantSlug });
    return reply.send({
        status: 'success',
        tenantSlug,
        staffLoaded: staff.length,
        syncedAt: now,
    });
}
// ── Staff lookup (login) ─────────────────────────────────────
const AuthLookupSchema = zod_1.z.object({
    username: zod_1.z.string().min(1),
});
const StaffVerifySchema = zod_1.z.object({
    username: zod_1.z.string().min(1),
    password: zod_1.z.string().min(1),
});
async function staffLookupHandler(req, reply) {
    const parsed = AuthLookupSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: 'username required' });
    }
    const db = (0, sqliteDb_1.getDb)();
    const username = String(parsed.data.username || '').trim().toLowerCase();
    // Check pending registration first
    const pending = db
        .prepare(`SELECT * FROM registrations WHERE LOWER(username) = ? AND status = 'pending'`)
        .get(username);
    if (pending) {
        return reply.code(403).send({
            error: 'registration_pending',
            message: 'Hasaba alyş heniz tassyklanmady. Kompaniýa administratorynyň tassyklamagyny garaşyň.',
            registrationId: pending.id,
            status: 'pending',
            deliveredAt: pending.delivered_at || null,
        });
    }
    const rejected = db
        .prepare(`SELECT * FROM registrations WHERE LOWER(username) = ? AND status = 'rejected' ORDER BY reviewed_at DESC LIMIT 1`)
        .get(username);
    const staffCount = db.prepare(`SELECT COUNT(*) as c FROM staff WHERE LOWER(username) = ? AND active = 1`).get(username).c;
    if (rejected && staffCount === 0) {
        return reply.code(403).send({
            error: 'registration_rejected',
            message: 'Hasaba alyş islegiňiz ret edildi.' + (rejected.note ? ` Sebäp: ${rejected.note}` : ''),
            registrationId: rejected.id,
            status: 'rejected',
        });
    }
    const matches = db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`).all(username);
    if (matches.length === 0) {
        const totalStaffCount = db.prepare(`SELECT COUNT(*) as c FROM staff`).get().c;
        return reply.code(404).send({
            error: 'not found',
            message: `Ulanyjy "${parsed.data.username}" staff sanawynda ýok`,
            staffCount: totalStaffCount,
        });
    }
    const user = matches.find((s) => Boolean(s.active)) || matches[0];
    if (!Boolean(user.active)) {
        return reply.code(403).send({
            error: 'account_inactive',
            message: 'Bu hasap öçürilen (active=false). Electron/BI-de işjeň ediň.',
            username: user.username,
        });
    }
    // Multi-tenant: merge tenant_slugs from all matching rows (legacy duplicates) + JSON field
    const slugSet = new Set();
    for (const m of matches) {
        if (m.tenant_slug)
            slugSet.add(String(m.tenant_slug));
        try {
            const arr = JSON.parse(m.tenant_slugs || '[]');
            if (Array.isArray(arr))
                for (const s of arr)
                    if (s)
                        slugSet.add(String(s));
        }
        catch { /* */ }
    }
    if (user.tenant_slug)
        slugSet.add(String(user.tenant_slug));
    const tenantSlugs = Array.from(slugSet);
    const tenant = await tenant_repository_1.tenantRepository.findBySlug(user.tenant_slug);
    // Resolve all tenant ids for multi-company staff (needed by BI SessionUser.tenantIds)
    const tenantIds = [];
    const tenantNames = [];
    for (const slug of tenantSlugs) {
        const t = await tenant_repository_1.tenantRepository.findBySlug(slug);
        if (t?.id)
            tenantIds.push(String(t.id));
        if (t?.name)
            tenantNames.push(String(t.name));
    }
    const hash = user.password_hash || '';
    const isPlaceholder = !hash ||
        hash.startsWith('synced-from-bi') ||
        hash.startsWith('pending-reset') ||
        hash.endsWith(':0000');
    return reply.send({
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        passwordHash: hash,
        passwordUsable: !isPlaceholder,
        role: user.role,
        tenantSlug: user.tenant_slug,
        tenantSlugs,
        tenantName: tenant?.name || tenantNames[0],
        tenantId: tenant?.id || tenantIds[0],
        tenantIds,
        phone: user.phone,
        email: user.email,
        active: Boolean(user.active),
    });
}
async function staffVerifyHandler(req, reply) {
    const parsed = StaffVerifySchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { username, password } = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const user = db
        .prepare(`SELECT * FROM staff WHERE LOWER(username) = ? AND active = 1`)
        .get(username.toLowerCase());
    if (!user) {
        return reply.code(404).send({ error: 'not_found' });
    }
    const hash = user.password_hash || '';
    if (!hash || hash.startsWith('synced-from-bi') || hash.startsWith('pending-reset') || hash.endsWith(':0000')) {
        return reply.code(403).send({ error: 'password_not_available', message: 'Password is managed externally' });
    }
    // Same dual-salt scrypt + bcrypt path as public /api/auth/verify
    const { verifyPasswordSync } = await Promise.resolve().then(() => __importStar(require('../../core/workers/passwordWorker')));
    const ok = verifyPasswordSync(password, hash);
    if (!ok) {
        return reply.code(401).send({ error: 'invalid_password' });
    }
    return reply.send({ ok: true, userId: user.id, username: user.username });
}
// ── Registrations ────────────────────────────────────────────
const CreateRegSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(5),
    email: zod_1.z.string().email(),
    username: zod_1.z.string().min(3),
    passwordHash: zod_1.z.string().min(1),
    requestedRole: zod_1.z.enum(['admin', 'editor', 'manager', 'viewer']).optional(),
});
async function createRegistrationHandler(req, reply) {
    const parsed = CreateRegSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;
    const tenant = await tenant_repository_1.tenantRepository.findBySlug(data.tenantSlug);
    if (!tenant || !tenant.isActive) {
        return reply.code(404).send({ error: 'Company not found' });
    }
    const db = (0, sqliteDb_1.getDb)();
    const unameLower = data.username.toLowerCase();
    const staffExists = db.prepare(`SELECT 1 FROM staff WHERE LOWER(username) = ?`).get(unameLower);
    const regExists = db.prepare(`SELECT 1 FROM registrations WHERE LOWER(username) = ? AND status = 'pending'`).get(unameLower);
    if (staffExists || regExists) {
        return reply.code(409).send({ error: 'Username already taken' });
    }
    let phone = data.phone.trim();
    if (!phone.startsWith('+'))
        phone = '+993' + phone.replace(/^993/, '');
    if (!phone.startsWith('+993'))
        phone = '+993' + phone.replace(/^\+?/, '');
    const now = new Date().toISOString();
    const id = randomId();
    db.prepare(`
    INSERT INTO registrations (id, tenant_slug, tenant_name, first_name, last_name, phone, email, username, password_hash, status, requested_role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, tenant.slug, tenant.name, data.firstName, data.lastName, phone, data.email, data.username, data.passwordHash, data.requestedRole || 'viewer', now);
    (0, sqliteDb_1.logSync)('create', 'registration', id, 'bi', { username: data.username, tenantSlug: tenant.slug });
    return reply.send({
        ok: true,
        registrationId: id,
        status: 'pending',
        deliveredAt: null,
        message: 'Registration submitted to VPS. Waiting for company Electron admin.',
    });
}
async function getRegistrationHandler(req, reply) {
    const { id } = req.params;
    const db = (0, sqliteDb_1.getDb)();
    const reg = db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(id);
    if (!reg)
        return reply.code(404).send({ error: 'not found' });
    return reply.send({
        id: reg.id,
        status: reg.status,
        deliveredAt: reg.delivered_at || null,
        tenantSlug: reg.tenant_slug,
        tenantName: reg.tenant_name,
        username: reg.username,
        reviewedAt: reg.reviewed_at || null,
        note: reg.note || null,
    });
}
async function listRegistrationsHandler(req, reply) {
    const q = req.query;
    const db = (0, sqliteDb_1.getDb)();
    let sql = 'SELECT id, tenant_slug as tenantSlug, tenant_name as tenantName, first_name as firstName, last_name as lastName, phone, email, username, status, requested_role as requestedRole, reviewed_by as reviewedBy, reviewed_at as reviewedAt, note, delivered_at as deliveredAt, created_at as createdAt FROM registrations WHERE 1=1';
    const params = [];
    if (q.tenantSlug) {
        sql += ' AND tenant_slug = ?';
        params.push(q.tenantSlug);
    }
    if (q.status) {
        sql += ' AND status = ?';
        params.push(q.status);
    }
    sql += ' ORDER BY created_at DESC';
    const list = db.prepare(sql).all(...params);
    const mark = q.markDelivered === '1' || q.markDelivered === 'true';
    if (mark) {
        const now = new Date().toISOString();
        db.prepare(`UPDATE registrations SET delivered_at = ? WHERE status = 'pending' AND (delivered_at IS NULL OR delivered_at = '')`).run(now);
    }
    return reply.send({ registrations: list });
}
const UpdateRegSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1).optional(),
    lastName: zod_1.z.string().min(1).optional(),
    phone: zod_1.z.string().min(5).optional(),
    email: zod_1.z.string().email().optional(),
    username: zod_1.z.string().min(3).optional(),
    requestedRole: zod_1.z.enum(['admin', 'editor', 'manager', 'viewer']).optional(),
    note: zod_1.z.string().optional(),
});
async function updateRegistrationHandler(req, reply) {
    const parsed = UpdateRegSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { id, ...patch } = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const reg = db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(id);
    if (!reg)
        return reply.code(404).send({ error: 'Registration not found' });
    if (reg.status !== 'pending') {
        return reply.code(400).send({ error: 'Only pending registrations can be edited' });
    }
    db.prepare(`
    UPDATE registrations SET
      first_name = COALESCE(?, first_name),
      last_name = COALESCE(?, last_name),
      phone = COALESCE(?, phone),
      email = COALESCE(?, email),
      username = COALESCE(?, username),
      requested_role = COALESCE(?, requested_role),
      note = COALESCE(?, note)
    WHERE id = ?
  `).run(patch.firstName ?? null, patch.lastName ?? null, patch.phone ?? null, patch.email ?? null, patch.username ?? null, patch.requestedRole ?? null, patch.note ?? null, id);
    (0, sqliteDb_1.logSync)('update', 'registration', id, 'electron', patch);
    const updated = db.prepare(`SELECT id, tenant_slug as tenantSlug, tenant_name as tenantName, first_name as firstName, last_name as lastName, phone, email, username, status, requested_role as requestedRole, note, created_at as createdAt FROM registrations WHERE id = ?`).get(id);
    return reply.send({ ok: true, registration: updated });
}
const ResolveRegSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    action: zod_1.z.enum(['approve', 'reject']),
    note: zod_1.z.string().optional(),
    role: zod_1.z.enum(['admin', 'editor', 'manager', 'viewer']).optional(),
    reviewedBy: zod_1.z.string().optional(),
    firstName: zod_1.z.string().optional(),
    lastName: zod_1.z.string().optional(),
    phone: zod_1.z.string().optional(),
    email: zod_1.z.string().optional(),
});
async function resolveRegistrationHandler(req, reply) {
    const parsed = ResolveRegSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { id, action, note, role, reviewedBy, firstName, lastName, phone, email } = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const reg = db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(id);
    if (!reg)
        return reply.code(404).send({ error: 'Registration not found' });
    if (reg.status !== 'pending') {
        return reply.code(400).send({ error: 'Already resolved' });
    }
    const now = new Date().toISOString();
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    db.prepare(`
    UPDATE registrations SET
      status = ?,
      reviewed_at = ?,
      reviewed_by = ?,
      note = ?,
      first_name = COALESCE(?, first_name),
      last_name = COALESCE(?, last_name),
      phone = COALESCE(?, phone),
      email = COALESCE(?, email)
    WHERE id = ?
  `).run(newStatus, now, reviewedBy || null, note || null, firstName || null, lastName || null, phone || null, email || null, id);
    let staffOut = null;
    if (action === 'approve') {
        const staffRole = role || reg.requested_role || 'viewer';
        const existingStaff = db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`).get(reg.username.toLowerCase());
        const staffId = existingStaff ? existingStaff.id : randomId();
        const finalFn = firstName || reg.first_name;
        const finalLn = lastName || reg.last_name;
        db.prepare(`
      INSERT INTO staff (id, tenant_slug, tenant_slugs, full_name, username, password_hash, role, phone, email, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_slug = excluded.tenant_slug,
        tenant_slugs = excluded.tenant_slugs,
        full_name = excluded.full_name,
        password_hash = excluded.password_hash,
        role = excluded.role,
        phone = excluded.phone,
        email = excluded.email,
        active = 1,
        updated_at = excluded.updated_at
    `).run(staffId, reg.tenant_slug, JSON.stringify([reg.tenant_slug]), `${finalFn} ${finalLn}`.trim(), reg.username, reg.password_hash, staffRole, phone || reg.phone || '', email || reg.email || '', now, now);
        staffOut = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(staffId);
    }
    // Create notification for user
    const notifId = randomId();
    db.prepare(`
    INSERT INTO notifications (id, username, type, title, message, read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(notifId, reg.username, action === 'approve' ? 'registration_approved' : 'registration_rejected', action === 'approve' ? 'Hasaba alyş tassyklanyldy' : 'Hasaba alyş ret edildi', action === 'approve'
        ? `${reg.tenant_name || reg.tenant_slug} kompaniýasynda hasabyňyz açyldy. Indi girip bilersiňiz.`
        : `Hasaba alyş islegiňiz ret edildi.` + (note ? ` Sebäp: ${note}` : ''), now);
    (0, sqliteDb_1.logSync)(action === 'approve' ? 'update' : 'delete', 'registration', id, 'electron', { action, staffOut });
    return reply.send({
        ok: true,
        status: newStatus,
        staff: staffOut
            ? {
                id: staffOut.id,
                username: staffOut.username,
                fullName: staffOut.full_name,
                passwordHash: staffOut.password_hash,
                role: staffOut.role,
                phone: staffOut.phone,
                email: staffOut.email,
                tenantSlug: staffOut.tenant_slug,
            }
            : null,
    });
}
// ── Notifications ────────────────────────────────────────────
async function listNotificationsHandler(req, reply) {
    const q = req.query;
    if (!q.username) {
        return reply.code(400).send({ error: 'username required' });
    }
    const db = (0, sqliteDb_1.getDb)();
    let sql = 'SELECT * FROM notifications WHERE LOWER(username) = ?';
    const params = [q.username.toLowerCase()];
    if (q.unreadOnly === '1') {
        sql += ' AND read = 0';
    }
    sql += ' ORDER BY created_at DESC';
    const list = db.prepare(sql).all(...params);
    return reply.send({ notifications: list });
}
const MarkReadSchema = zod_1.z.object({
    ids: zod_1.z.array(zod_1.z.string()).optional(),
    username: zod_1.z.string().optional(),
});
async function markNotificationsReadHandler(req, reply) {
    const parsed = MarkReadSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: 'bad body' });
    const db = (0, sqliteDb_1.getDb)();
    const { ids, username } = parsed.data;
    if (ids && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
    }
    else if (username) {
        db.prepare(`UPDATE notifications SET read = 1 WHERE LOWER(username) = ?`).run(username.toLowerCase());
    }
    return reply.send({ ok: true });
}
// ── Tenant & Endpoint updates ────────────────────────────────
const TenantUpdateSchema = zod_1.z.object({
    slug: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1).optional(),
    isActive: zod_1.z.boolean().optional(),
    /** Client's last known updated_at — reject if server is newer (concurrent edit) */
    expectedUpdatedAt: zod_1.z.string().optional(),
});
async function tenantUpdateHandler(req, reply) {
    const parsed = TenantUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const now = new Date().toISOString();
    let t = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.slug);
    if (!t) {
        if (!parsed.data.name) {
            return reply.code(404).send({ error: 'Tenant not found' });
        }
        // New companies are always active by default
        const id = randomId();
        const active = parsed.data.isActive !== false ? 1 : 0;
        db.prepare(`
      INSERT INTO tenants (id, slug, name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, parsed.data.slug, parsed.data.name, active, now, now);
        t = { id, slug: parsed.data.slug, name: parsed.data.name, is_active: active };
        // Electron created company via tenant-update → auto-link this device
        const deviceId = req.headers['x-device-id'] ||
            req.body?.deviceId ||
            undefined;
        const assign = ensureDeviceAssignment(db, deviceId, parsed.data.slug);
        if (!assign.ok && assign.error) {
            return reply.code(409).send({
                error: assign.error,
                code: 'FIRM_ALREADY_ASSIGNED',
                tenantId: id,
            });
        }
        (0, sqliteDb_1.logSync)('create', 'tenant', id, deviceId ? 'electron' : 'bi', {
            slug: parsed.data.slug,
            isActive: active,
            deviceId,
            deviceAssigned: Boolean(deviceId),
        });
    }
    else {
        // Concurrency: if client sends expectedUpdatedAt and server is newer → conflict
        if (parsed.data.expectedUpdatedAt && t.updated_at) {
            const clientTs = Date.parse(parsed.data.expectedUpdatedAt);
            const serverTs = Date.parse(t.updated_at);
            if (!Number.isNaN(clientTs) && !Number.isNaN(serverTs) && serverTs > clientTs) {
                return reply.code(409).send({
                    error: 'conflict',
                    message: 'Başga ýerde üýtgedildi. Maglumatlar täzeden çekildi.',
                    tenant: {
                        id: t.id,
                        slug: t.slug,
                        name: t.name,
                        isActive: Boolean(t.is_active),
                        updatedAt: t.updated_at,
                    },
                });
            }
        }
        const newName = parsed.data.name ?? t.name;
        const newActive = parsed.data.isActive !== undefined ? (parsed.data.isActive ? 1 : 0) : t.is_active;
        db.prepare(`UPDATE tenants SET name = ?, is_active = ?, updated_at = ?, is_open = 0, opened_at = NULL, opened_by = NULL WHERE id = ?`).run(newName, newActive, now, t.id);
        t.name = newName;
        t.is_active = newActive;
        (0, sqliteDb_1.logSync)('update', 'tenant', t.id, 'electron', { slug: parsed.data.slug, isActive: newActive });
    }
    // Soft-delete: keep is_active = 0; if related APIs exist, notify and deactivate staff
    if (parsed.data.isActive === false) {
        const epCount = db.prepare(`SELECT COUNT(*) as cnt FROM endpoints WHERE tenant_slug = ?`).get(t.slug)?.cnt ?? 0;
        // Do not hard-delete endpoints — only soft-deactivate the company
        db.prepare(`UPDATE staff SET active = 0 WHERE tenant_slug = ?`).run(t.slug);
        const notifId = randomId();
        const title = 'Kompaniýa öçürildi (passiw)';
        const message = epCount > 0
            ? `«${t.name}» (${t.slug}) is_active=0 edildi. Bagly API sany: ${epCount}. API-lar saklandy, kompaniýa passiw.`
            : `«${t.name}» (${t.slug}) is_active=0 edildi. Bagly API ýok.`;
        // Notify all super/admin staff (or system-wide via empty username marker)
        const admins = db
            .prepare(`SELECT DISTINCT username FROM staff WHERE role IN ('admin', 'super_admin') AND active = 1`)
            .all();
        if (admins.length === 0) {
            db.prepare(`
        INSERT INTO notifications (id, username, type, title, message, read, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(notifId, 'system', 'tenant_deactivated', title, message, now);
        }
        else {
            for (const a of admins) {
                db.prepare(`
          INSERT INTO notifications (id, username, type, title, message, read, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(randomId(), a.username, 'tenant_deactivated', title, message, now);
            }
        }
        (0, sqliteDb_1.logSync)('update', 'tenant', t.id, 'electron', {
            slug: t.slug,
            isActive: 0,
            relatedApis: epCount,
            notification: true,
        });
    }
    return reply.send({
        ok: true,
        tenant: { id: t.id, slug: t.slug, name: t.name, isActive: Boolean(t.is_active) },
    });
}
const EndpointUpdateSchema = zod_1.z.object({
    id: zod_1.z.string(),
    tenantSlug: zod_1.z.string(),
    name: zod_1.z.string().min(1),
    pathTemplate: zod_1.z.string().min(1),
    method: zod_1.z.string().min(1),
    dbKey: zod_1.z.string().optional(),
    sqlQuery: zod_1.z.string().optional(),
    paramsSchema: zod_1.z.any().optional(),
    responseSchema: zod_1.z.any().optional(),
    cacheTtlSec: zod_1.z.number().optional(),
    authRequired: zod_1.z.boolean().optional(),
    connectionId: zod_1.z.string().optional(),
    databaseName: zod_1.z.string().optional(),
});
async function endpointUpdateHandler(req, reply) {
    const parsed = EndpointUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const now = new Date().toISOString();
    const ep = db.prepare(`SELECT * FROM endpoints WHERE id = ?`).get(parsed.data.id);
    if (!ep)
        return reply.code(404).send({ error: 'Endpoint not found' });
    // Duplicate path+method under same tenant (exclude self)
    const dup = db
        .prepare(`SELECT id FROM endpoints WHERE tenant_slug = ? AND method = ? AND path_template = ? AND id != ?`)
        .get(parsed.data.tenantSlug, parsed.data.method.toUpperCase(), parsed.data.pathTemplate, ep.id);
    if (dup) {
        return reply.code(409).send({
            error: 'duplicate',
            message: 'Şu method + path bu firmada eýýäm bar.',
        });
    }
    const sqlQuery = parsed.data.sqlQuery !== undefined ? parsed.data.sqlQuery : ep.sql_query;
    const paramsSchema = parsed.data.paramsSchema !== undefined
        ? JSON.stringify(parsed.data.paramsSchema)
        : ep.params_schema;
    const responseSchema = parsed.data.responseSchema !== undefined
        ? JSON.stringify(parsed.data.responseSchema)
        : ep.response_schema;
    const cacheTtl = parsed.data.cacheTtlSec !== undefined ? parsed.data.cacheTtlSec : ep.cache_ttl_sec;
    const authReq = parsed.data.authRequired !== undefined
        ? parsed.data.authRequired
            ? 1
            : 0
        : ep.auth_required;
    db.prepare(`
    UPDATE endpoints SET
      name = ?,
      path_template = ?,
      method = ?,
      db_key = COALESCE(?, db_key),
      sql_query = ?,
      params_schema = ?,
      response_schema = ?,
      cache_ttl_sec = ?,
      auth_required = ?,
      connection_id = COALESCE(?, connection_id),
      database_name = COALESCE(?, database_name),
      updated_at = ?
    WHERE id = ?
  `).run(parsed.data.name, parsed.data.pathTemplate, parsed.data.method.toUpperCase(), parsed.data.dbKey ?? null, sqlQuery, paramsSchema, responseSchema, cacheTtl, authReq, parsed.data.connectionId ?? null, parsed.data.databaseName ?? null, now, ep.id);
    (0, sqliteDb_1.logSync)('update', 'endpoint', ep.id, 'electron', {
        name: parsed.data.name,
        path: parsed.data.pathTemplate,
        sqlUpdated: parsed.data.sqlQuery !== undefined,
    });
    const pathTemplate = parsed.data.pathTemplate.startsWith('/')
        ? parsed.data.pathTemplate
        : `/${parsed.data.pathTemplate}`;
    const dbKeyNorm = (parsed.data.dbKey || ep.db_key || 'primary').toString().toLowerCase() || 'primary';
    try {
        db.prepare(`UPDATE endpoints SET path_template = ?, db_key = ? WHERE id = ?`).run(pathTemplate, dbKeyNorm, ep.id);
    }
    catch { /* */ }
    try {
        const { routeRegistry } = await Promise.resolve().then(() => __importStar(require('../../core/router/routeRegistry')));
        routeRegistry.upsert(parsed.data.tenantSlug, {
            id: ep.id,
            tenantSlug: parsed.data.tenantSlug,
            name: parsed.data.name,
            method: parsed.data.method.toUpperCase(),
            pathTemplate,
            sqlQuery,
            paramsSchema: parsed.data.paramsSchema,
            cacheTtlSec: parsed.data.cacheTtlSec ?? ep.cache_ttl_sec ?? 0,
            authRequired: parsed.data.authRequired !== false,
            dbKey: dbKeyNorm,
        });
        const tenantEps = await tenant_repository_1.tenantRepository.listAllEndpoints();
        const filtered = tenantEps.filter((e) => e.tenantSlug === parsed.data.tenantSlug);
        routeRegistry.replaceTenantRoutes(parsed.data.tenantSlug, filtered.map((e) => ({
            ...e,
            pathTemplate: e.pathTemplate?.startsWith?.('/') ? e.pathTemplate : `/${e.pathTemplate || ''}`,
            dbKey: (e.dbKey || 'primary').toLowerCase(),
        })));
    }
    catch (err) {
        console.error('[endpoint-update] routeRegistry refresh failed', err);
    }
    return reply.send({
        ok: true,
        endpoint: {
            id: ep.id,
            name: parsed.data.name,
            pathTemplate,
            method: parsed.data.method.toUpperCase(),
            sqlQuery,
            dbKey: dbKeyNorm,
        },
    });
}
// ── Endpoint create / delete (single-record, VPS primary) ─────
const EndpointCreateSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    tenantSlug: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    pathTemplate: zod_1.z.string().min(1),
    method: zod_1.z.string().min(1),
    sqlQuery: zod_1.z.string().default('SELECT 1'),
    paramsSchema: zod_1.z.any().optional(),
    responseSchema: zod_1.z.any().optional(),
    cacheTtlSec: zod_1.z.number().optional(),
    authRequired: zod_1.z.boolean().optional(),
    dbKey: zod_1.z.string().optional(),
    connectionId: zod_1.z.string().optional(),
    databaseName: zod_1.z.string().optional(),
});
async function endpointCreateHandler(req, reply) {
    const parsed = EndpointCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const now = new Date().toISOString();
    const d = parsed.data;
    const method = d.method.toUpperCase();
    const tenant = db.prepare(`SELECT id, slug FROM tenants WHERE slug = ?`).get(d.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Tenant not found', tenantSlug: d.tenantSlug });
    const dup = db
        .prepare(`SELECT id FROM endpoints WHERE tenant_slug = ? AND method = ? AND path_template = ?`)
        .get(d.tenantSlug, method, d.pathTemplate);
    if (dup) {
        return reply.code(409).send({
            error: 'duplicate',
            message: 'Şu method + path bu firmada eýýäm bar.',
            id: dup.id,
        });
    }
    const id = d.id || randomId();
    if (d.id) {
        const exists = db.prepare(`SELECT id FROM endpoints WHERE id = ?`).get(d.id);
        if (exists) {
            return reply.code(409).send({ error: 'duplicate', message: 'Endpoint id eýýäm bar.', id: d.id });
        }
    }
    db.prepare(`
    INSERT INTO endpoints (
      id, tenant_id, tenant_slug, name, method, path_template, sql_query,
      params_schema, response_schema, cache_ttl_sec, auth_required, db_key,
      connection_id, database_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenant.id, d.tenantSlug, d.name, method, d.pathTemplate, d.sqlQuery || 'SELECT 1', JSON.stringify(d.paramsSchema || { urlParams: [], queryParams: [], bodyParams: [] }), d.responseSchema ? JSON.stringify(d.responseSchema) : null, d.cacheTtlSec ?? 0, d.authRequired === false ? 0 : 1, d.dbKey || 'primary', d.connectionId || '', d.databaseName || '', now, now);
    (0, sqliteDb_1.logSync)('create', 'endpoint', id, 'api', { tenantSlug: d.tenantSlug, path: d.pathTemplate });
    const pathTemplate = d.pathTemplate.startsWith('/') ? d.pathTemplate : `/${d.pathTemplate}`;
    const dbKeyNorm = (d.dbKey || 'primary').toLowerCase().replace(/[^a-z0-9-_]+/g, '-') || 'primary';
    // Fix path/dbKey in DB if needed
    try {
        db.prepare(`UPDATE endpoints SET path_template = ?, db_key = ? WHERE id = ?`).run(pathTemplate, dbKeyNorm, id);
    }
    catch { /* */ }
    try {
        const { routeRegistry } = await Promise.resolve().then(() => __importStar(require('../../core/router/routeRegistry')));
        // 1) Direct upsert of this endpoint (guarantees live route even if list fails)
        routeRegistry.upsert(d.tenantSlug, {
            id,
            tenantSlug: d.tenantSlug,
            name: d.name,
            method,
            pathTemplate,
            sqlQuery: d.sqlQuery || 'SELECT 1',
            paramsSchema: d.paramsSchema || { urlParams: [], queryParams: [], bodyParams: [] },
            cacheTtlSec: d.cacheTtlSec ?? 0,
            authRequired: d.authRequired !== false,
            dbKey: dbKeyNorm,
            connectionId: d.connectionId,
            database: d.databaseName,
        });
        // 2) Full tenant refresh from SQLite
        const tenantEps = await tenant_repository_1.tenantRepository.listAllEndpoints();
        const filtered = tenantEps.filter((e) => e.tenantSlug === d.tenantSlug);
        routeRegistry.replaceTenantRoutes(d.tenantSlug, filtered.map((e) => ({
            ...e,
            pathTemplate: e.pathTemplate?.startsWith?.('/') ? e.pathTemplate : `/${e.pathTemplate || ''}`,
            dbKey: (e.dbKey || 'primary').toLowerCase(),
        })));
    }
    catch (err) {
        console.error('[endpoint-create] routeRegistry refresh failed', err);
    }
    return reply.send({
        ok: true,
        endpoint: {
            id,
            tenantSlug: d.tenantSlug,
            name: d.name,
            method,
            pathTemplate,
            sqlQuery: d.sqlQuery || 'SELECT 1',
            dbKey: dbKeyNorm,
        },
    });
}
const EndpointDeleteSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    tenantSlug: zod_1.z.string().optional(),
    method: zod_1.z.string().optional(),
    pathTemplate: zod_1.z.string().optional(),
});
async function endpointDeleteHandler(req, reply) {
    const parsed = EndpointDeleteSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    let ep = null;
    if (parsed.data.id) {
        ep = db.prepare(`SELECT * FROM endpoints WHERE id = ?`).get(parsed.data.id);
    }
    else if (parsed.data.tenantSlug && parsed.data.method && parsed.data.pathTemplate) {
        ep = db
            .prepare(`SELECT * FROM endpoints WHERE tenant_slug = ? AND method = ? AND path_template = ?`)
            .get(parsed.data.tenantSlug, parsed.data.method.toUpperCase(), parsed.data.pathTemplate);
    }
    if (!ep)
        return reply.code(404).send({ error: 'Endpoint not found' });
    // Block delete if assigned to a device assignment
    try {
        const asg = db
            .prepare(`SELECT COUNT(*) as c FROM device_assignments WHERE endpoint_id = ?`)
            .get(ep.id);
        if (asg && asg.c > 0) {
            return reply.code(409).send({
                error: 'has_dependencies',
                message: `Bu API ${asg.c} device assignment-e bagly. Ilki assignment aýyryň.`,
                assignmentCount: asg.c,
            });
        }
    }
    catch {
        /* table may lack rows */
    }
    db.prepare(`DELETE FROM endpoints WHERE id = ?`).run(ep.id);
    (0, sqliteDb_1.logSync)('delete', 'endpoint', ep.id, 'api', {
        tenantSlug: ep.tenant_slug,
        path: ep.path_template,
    });
    try {
        const { routeRegistry } = await Promise.resolve().then(() => __importStar(require('../../core/router/routeRegistry')));
        const tenantEps = await tenant_repository_1.tenantRepository.listAllEndpoints();
        const filtered = tenantEps.filter((e) => e.tenantSlug === ep.tenant_slug);
        routeRegistry.replaceTenantRoutes(ep.tenant_slug, filtered.map((e) => ({ ...e, dbKey: e.dbKey || 'primary' })));
    }
    catch { /* */ }
    return reply.send({
        ok: true,
        deleted: true,
        id: ep.id,
        tenantSlug: ep.tenant_slug,
    });
}
// ── Device settings (Firma Sazlamalary) — device_app_settings columns ──
const DeviceSettingsUpsertSchema = zod_1.z.object({
    deviceId: zod_1.z.string().min(1),
    tenantSlug: zod_1.z.string().default(''),
    settings: zod_1.z.record(zod_1.z.any()),
    updatedBy: zod_1.z.string().optional(),
    /** Client clock ISO — LWW: reject if server row is strictly newer */
    clientUpdatedAt: zod_1.z.string().optional(),
});
/** Row → API settings object (camelCase, interval in seconds) */
function rowToDeviceAppSettings(r) {
    return {
        autostart: Boolean(r.autostart),
        startMinimized: Boolean(r.start_minimized),
        trayMinimize: r.tray_minimize !== 0 && r.tray_minimize !== false,
        autoLogin: Boolean(r.auto_login),
        autoLoginUsername: String(r.auto_login_username || ''),
        autoSync: r.auto_sync !== 0 && r.auto_sync !== false,
        /** Canonical: seconds */
        syncIntervalSec: Number(r.sync_interval_sec) || 30,
        /** Deprecated alias for older Electron builds */
        syncIntervalMin: Math.max(1, Math.round((Number(r.sync_interval_sec) || 30) / 60)),
        offlineQueue: r.offline_queue !== 0 && r.offline_queue !== false,
        notifyOnSync: r.notify_on_sync !== 0 && r.notify_on_sync !== false,
        autoSignOutMin: Math.max(0, Number(r.auto_sign_out_min) || 0),
        theme: String(r.theme || 'dark'),
        language: String(r.language || 'tk'),
    };
}
/** Normalize incoming settings patch → column values (sync always in seconds) */
function normalizeDeviceAppPatch(prev, patch) {
    const m = { ...prev, ...patch };
    let sec = Number(m.syncIntervalSec ?? m.sync_interval_sec ?? 0);
    if (!sec || sec <= 0) {
        const min = Number(m.syncIntervalMin ?? m.sync_interval_min ?? 0);
        // BI historically sent "minutes"; Electron UI uses seconds (15, 30, 60, 300)
        // If value looks like minutes (1–14) convert; if already large, treat as seconds
        if (min > 0 && min <= 14)
            sec = Math.round(min * 60);
        else if (min > 14)
            sec = Math.round(min); // already seconds misnamed as Min
        else
            sec = 30;
    }
    // Cap: 0 = manual-only represented as 0; else min 15s max 24h
    if (sec < 0)
        sec = 0;
    if (sec > 0 && sec < 15)
        sec = 15;
    if (sec > 86400)
        sec = 86400;
    m.syncIntervalSec = sec;
    m.syncIntervalMin = sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0;
    const autoLoginUsername = String(m.autoLoginUsername ?? m.auto_login_username ?? '').trim();
    const cols = {
        autostart: m.autostart ? 1 : 0,
        start_minimized: m.startMinimized || m.start_minimized ? 1 : 0,
        tray_minimize: m.trayMinimize === false || m.tray_minimize === false ? 0 : 1,
        auto_login: m.autoLogin || m.auto_login ? 1 : 0,
        auto_login_username: autoLoginUsername,
        auto_sync: m.autoSync === false || m.auto_sync === false ? 0 : 1,
        sync_interval_sec: sec,
        offline_queue: m.offlineQueue === false || m.offline_queue === false ? 0 : 1,
        notify_on_sync: m.notifyOnSync === false || m.notify_on_sync === false ? 0 : 1,
        auto_sign_out_min: Math.max(0, Number(m.autoSignOutMin ?? m.auto_sign_out_min ?? 0) || 0),
        theme: String(m.theme || 'dark'),
        language: String(m.language || 'tk'),
    };
    const merged = {
        autostart: Boolean(cols.autostart),
        startMinimized: Boolean(cols.start_minimized),
        trayMinimize: Boolean(cols.tray_minimize),
        autoLogin: Boolean(cols.auto_login),
        autoLoginUsername: cols.auto_login_username,
        autoSync: Boolean(cols.auto_sync),
        syncIntervalSec: cols.sync_interval_sec,
        syncIntervalMin: cols.sync_interval_sec > 0 ? Math.max(1, Math.round(cols.sync_interval_sec / 60)) : 0,
        offlineQueue: Boolean(cols.offline_queue),
        notifyOnSync: Boolean(cols.notify_on_sync),
        autoSignOutMin: cols.auto_sign_out_min,
        theme: cols.theme,
        language: cols.language,
    };
    return { cols, merged };
}
async function deviceSettingsGetHandler(req, reply) {
    const q = req.query;
    const db = (0, sqliteDb_1.getDb)();
    let rows = [];
    try {
        // Prefer structured table
        if (q.deviceId && q.tenantSlug !== undefined) {
            rows = db
                .prepare(`SELECT * FROM device_app_settings WHERE device_id = ? AND tenant_slug = ?`)
                .all(q.deviceId, q.tenantSlug || '');
        }
        else if (q.deviceId) {
            rows = db.prepare(`SELECT * FROM device_app_settings WHERE device_id = ?`).all(q.deviceId);
        }
        else if (q.tenantSlug) {
            rows = db
                .prepare(`SELECT * FROM device_app_settings WHERE tenant_slug = ?`)
                .all(q.tenantSlug);
        }
        else {
            rows = db.prepare(`SELECT * FROM device_app_settings`).all();
        }
    }
    catch {
        rows = [];
    }
    // Fallback to legacy JSON table if structured empty
    if (rows.length === 0) {
        try {
            let legacy = [];
            if (q.deviceId && q.tenantSlug !== undefined) {
                legacy = db
                    .prepare(`SELECT * FROM device_settings WHERE device_id = ? AND tenant_slug = ?`)
                    .all(q.deviceId, q.tenantSlug || '');
            }
            else if (q.deviceId) {
                legacy = db.prepare(`SELECT * FROM device_settings WHERE device_id = ?`).all(q.deviceId);
            }
            else {
                legacy = [];
            }
            return reply.send({
                ok: true,
                settings: legacy.map((r) => {
                    let s = {};
                    try {
                        s = JSON.parse(r.settings_json || '{}');
                    }
                    catch {
                        s = {};
                    }
                    const { merged } = normalizeDeviceAppPatch({}, s);
                    return {
                        id: r.id,
                        deviceId: r.device_id,
                        tenantSlug: r.tenant_slug || '',
                        settings: merged,
                        updatedAt: r.updated_at,
                        updatedBy: r.updated_by || '',
                    };
                }),
            });
        }
        catch {
            return reply.send({ ok: true, settings: [] });
        }
    }
    return reply.send({
        ok: true,
        settings: rows.map((r) => ({
            id: r.id,
            deviceId: r.device_id,
            tenantSlug: r.tenant_slug || '',
            settings: rowToDeviceAppSettings(r),
            updatedAt: r.updated_at,
            updatedBy: r.updated_by || '',
        })),
    });
}
async function deviceSettingsUpsertHandler(req, reply) {
    const parsed = DeviceSettingsUpsertSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const { deviceId, tenantSlug, settings, updatedBy, clientUpdatedAt } = parsed.data;
    const now = new Date().toISOString();
    const slug = tenantSlug || '';
    const device = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId);
    if (!device)
        return reply.code(404).send({ error: 'Device not found' });
    let prev = {};
    let existingId = null;
    let existingUpdatedAt = '';
    try {
        const existing = db
            .prepare(`SELECT * FROM device_app_settings WHERE device_id = ? AND tenant_slug = ?`)
            .get(deviceId, slug);
        if (existing) {
            existingId = existing.id;
            existingUpdatedAt = String(existing.updated_at || '');
            prev = rowToDeviceAppSettings(existing);
        }
    }
    catch {
        /* table may not exist yet on very old builds — migration should have run */
    }
    // LWW: if client sends older timestamp than server, keep server (do not overwrite)
    if (clientUpdatedAt && existingUpdatedAt) {
        const cTs = Date.parse(clientUpdatedAt);
        const sTs = Date.parse(existingUpdatedAt);
        if (Number.isFinite(cTs) && Number.isFinite(sTs) && sTs > cTs) {
            return reply.send({
                ok: true,
                skipped: true,
                reason: 'server_newer',
                id: existingId,
                deviceId,
                tenantSlug: slug,
                settings: prev,
                updatedAt: existingUpdatedAt,
            });
        }
    }
    const { cols, merged } = normalizeDeviceAppPatch(prev, settings);
    const id = existingId || randomId();
    // Ensure auto_login_username column exists (older DBs may miss v11)
    try {
        const tableCols = db.prepare(`PRAGMA table_info(device_app_settings)`).all().map((c) => c.name);
        if (!tableCols.includes('auto_login_username')) {
            db.exec(`ALTER TABLE device_app_settings ADD COLUMN auto_login_username TEXT DEFAULT ''`);
        }
    }
    catch {
        /* */
    }
    db.prepare(`INSERT INTO device_app_settings (
      id, device_id, tenant_slug,
      autostart, start_minimized, tray_minimize, auto_login, auto_login_username,
      auto_sync, sync_interval_sec, offline_queue, notify_on_sync,
      auto_sign_out_min, theme, language, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, tenant_slug) DO UPDATE SET
      autostart=excluded.autostart,
      start_minimized=excluded.start_minimized,
      tray_minimize=excluded.tray_minimize,
      auto_login=excluded.auto_login,
      auto_login_username=excluded.auto_login_username,
      auto_sync=excluded.auto_sync,
      sync_interval_sec=excluded.sync_interval_sec,
      offline_queue=excluded.offline_queue,
      notify_on_sync=excluded.notify_on_sync,
      auto_sign_out_min=excluded.auto_sign_out_min,
      theme=excluded.theme,
      language=excluded.language,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by`).run(id, deviceId, slug, cols.autostart, cols.start_minimized, cols.tray_minimize, cols.auto_login, cols.auto_login_username, cols.auto_sync, cols.sync_interval_sec, cols.offline_queue, cols.notify_on_sync, cols.auto_sign_out_min, cols.theme, cols.language, now, updatedBy || '');
    // Mirror to legacy device_settings JSON for older clients / catalog
    try {
        const leg = db
            .prepare(`SELECT id FROM device_settings WHERE device_id = ? AND tenant_slug = ?`)
            .get(deviceId, slug);
        if (leg) {
            db.prepare(`UPDATE device_settings SET settings_json = ?, updated_at = ?, updated_by = ? WHERE id = ?`).run(JSON.stringify(merged), now, updatedBy || '', leg.id);
        }
        else {
            db.prepare(`INSERT INTO device_settings (id, device_id, tenant_slug, settings_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`).run(id, deviceId, slug, JSON.stringify(merged), now, updatedBy || '');
        }
    }
    catch {
        /* optional */
    }
    (0, sqliteDb_1.logSync)('update', 'device', deviceId, 'bi_admin', {
        action: 'device_app_settings',
        tenantSlug: slug,
        keys: Object.keys(settings),
        syncIntervalSec: cols.sync_interval_sec,
    });
    try {
        deviceEventManager_1.deviceEventManager.broadcast(deviceId, {
            type: 'SETTINGS_UPDATED',
            deviceId,
            tenantSlug: slug,
            settings: merged,
        });
    }
    catch {
        /* optional live push */
    }
    return reply.send({
        ok: true,
        id,
        deviceId,
        tenantSlug: slug,
        settings: merged,
        updatedAt: now,
    });
}
/** BI → Electron remote command: restart app or check for updates */
const DeviceCommandSchema = zod_1.z.object({
    deviceId: zod_1.z.string().min(1),
    action: zod_1.z.enum(['restart', 'check_update']),
});
async function deviceCommandHandler(req, reply) {
    const parsed = DeviceCommandSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const { deviceId, action } = parsed.data;
    const device = db.prepare(`SELECT id, status FROM devices WHERE id = ?`).get(deviceId);
    if (!device)
        return reply.code(404).send({ error: 'Device not found' });
    const eventType = action === 'restart' ? 'DEVICE_RESTART' : 'DEVICE_CHECK_UPDATE';
    let delivered = false;
    try {
        delivered = deviceEventManager_1.deviceEventManager.broadcast(deviceId, {
            type: eventType,
            deviceId,
        });
    }
    catch (e) {
        console.warn('[deviceCommand] broadcast failed', e);
    }
    (0, sqliteDb_1.logSync)('update', 'device', deviceId, 'bi_admin', { action: eventType, delivered });
    return reply.send({
        ok: true,
        deviceId,
        action,
        delivered,
        message: delivered
            ? 'Electron-a buýruk ugradyldy'
            : 'Enjam offline ýa-da device-events bagly däl — Electron açyk bolmaly',
    });
}
// ── Admin test SQL (runs on Electron agent via tunnel) ────────
const TestQuerySchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    sqlQuery: zod_1.z.string().min(1),
    dbKey: zod_1.z.string().optional(),
    params: zod_1.z.record(zod_1.z.any()).optional(),
    timeoutMs: zod_1.z.number().optional(),
});
const ListDatabasesSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    host: zod_1.z.string().optional(),
    port: zod_1.z.number().optional(),
    username: zod_1.z.string().optional(),
    password: zod_1.z.string().optional(),
    encrypt: zod_1.z.boolean().optional(),
    trustServerCertificate: zod_1.z.boolean().optional(),
    dbKey: zod_1.z.string().optional(),
    timeoutMs: zod_1.z.number().optional(),
});
/** List MSSQL databases via Electron tunnel (saved conn or ad-hoc credentials). */
async function listDatabasesHandler(req, reply) {
    const parsed = ListDatabasesSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    const { agentTunnelManager } = await Promise.resolve().then(() => __importStar(require('../../core/tunnel/agentTunnelManager')));
    const result = await agentTunnelManager.executeRemoteQuery(d.tenantSlug, {
        sqlQuery: "SELECT name FROM sys.databases WHERE state = 0 AND name NOT IN ('master','tempdb','model','msdb') ORDER BY name",
        dbKey: d.dbKey || 'primary',
        params: {},
        timeoutMs: d.timeoutMs || 25_000,
        // Ad-hoc connection (before save) — Electron uses these when provided
        connection: d.host
            ? {
                host: d.host,
                port: d.port || 1433,
                username: d.username || '',
                password: d.password || '',
                encrypt: d.encrypt !== false,
                trustServerCertificate: d.trustServerCertificate !== false,
                database: 'master',
            }
            : undefined,
    });
    if (!result.ok) {
        return reply.code(502).send({
            ok: false,
            error: result.error || 'DB sanawy alynmady',
        });
    }
    const rows = result.rows || [];
    const databases = rows
        .map((r) => String(r.name || r.NAME || Object.values(r)[0] || ''))
        .filter(Boolean);
    return reply.send({ ok: true, databases, rowCount: databases.length });
}
async function testQueryHandler(req, reply) {
    const parsed = TestQuerySchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const { tenantSlug, sqlQuery, dbKey, params, timeoutMs } = parsed.data;
    const { agentTunnelManager } = await Promise.resolve().then(() => __importStar(require('../../core/tunnel/agentTunnelManager')));
    const result = await agentTunnelManager.executeRemoteQuery(tenantSlug, {
        sqlQuery,
        dbKey: dbKey || 'primary',
        params: params || {},
        timeoutMs: timeoutMs || 35_000,
    });
    if (!result.ok) {
        return reply.code(502).send({
            ok: false,
            error: result.error || 'Query failed',
        });
    }
    return reply.send({
        ok: true,
        rows: result.rows || [],
        rowCount: result.rowCount ?? (result.rows?.length || 0),
        elapsedMs: result.elapsedMs,
    });
}
// ── Edit locks (is_open) ─────────────────────────────────────
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const EntityLockSchema = zod_1.z.object({
    entityType: zod_1.z.enum(['tenant', 'staff', 'endpoint']),
    entityId: zod_1.z.string().min(1),
    action: zod_1.z.enum(['lock', 'unlock', 'heartbeat']),
    openedBy: zod_1.z.string().optional(),
});
function lockTable(entityType) {
    if (entityType === 'tenant')
        return 'tenants';
    if (entityType === 'staff')
        return 'staff';
    return 'endpoints';
}
async function entityLockHandler(req, reply) {
    const parsed = EntityLockSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const { entityType, entityId, action, openedBy } = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const table = lockTable(entityType);
    const now = new Date().toISOString();
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId);
    if (!row)
        return reply.code(404).send({ error: 'Entity not found' });
    const isOpen = Boolean(row.is_open);
    const openedAtMs = row.opened_at ? Date.parse(row.opened_at) : 0;
    const lockExpired = !openedAtMs || Date.now() - openedAtMs > LOCK_TTL_MS;
    const sameUser = openedBy && row.opened_by && openedBy === row.opened_by;
    if (action === 'lock') {
        if (isOpen && !lockExpired && !sameUser) {
            return reply.code(423).send({
                error: 'locked',
                message: `Bu ýazgy häzir başga ýerde üýtgedilýär (${row.opened_by || 'näbelli'}).`,
                openedBy: row.opened_by,
                openedAt: row.opened_at,
            });
        }
        db.prepare(`UPDATE ${table} SET is_open = 1, opened_at = ?, opened_by = ? WHERE id = ?`).run(now, openedBy || 'unknown', entityId);
        return reply.send({ ok: true, locked: true, openedAt: now, openedBy: openedBy || 'unknown' });
    }
    if (action === 'heartbeat') {
        if (!isOpen || lockExpired) {
            return reply.code(423).send({ error: 'not_locked', message: 'Lock ýok ýa-da möhleti gutardy' });
        }
        if (!sameUser) {
            return reply.code(423).send({ error: 'locked', message: 'Lock başga ulanyjyda' });
        }
        db.prepare(`UPDATE ${table} SET opened_at = ? WHERE id = ?`).run(now, entityId);
        return reply.send({ ok: true, heartbeat: true, openedAt: now });
    }
    // unlock
    db.prepare(`UPDATE ${table} SET is_open = 0, opened_at = NULL, opened_by = NULL WHERE id = ?`).run(entityId);
    return reply.send({ ok: true, locked: false });
}
// ── Hard delete tenant ───────────────────────────────────────
const TenantDeleteSchema = zod_1.z.object({
    slug: zod_1.z.string().min(1),
});
async function tenantDeleteHandler(req, reply) {
    const parsed = TenantDeleteSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const t = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.slug);
    if (!t)
        return reply.code(404).send({ error: 'Tenant not found' });
    const staffCount = db.prepare(`SELECT COUNT(*) as c FROM staff WHERE tenant_slug = ?`).get(t.slug).c;
    const epCount = db.prepare(`SELECT COUNT(*) as c FROM endpoints WHERE tenant_slug = ?`).get(t.slug).c;
    const connCount = db.prepare(`SELECT COUNT(*) as c FROM tenant_connections WHERE tenant_id = ?`).get(t.id).c;
    if (staffCount > 0 || epCount > 0 || connCount > 0) {
        return reply.code(409).send({
            error: 'has_dependencies',
            message: `Kompaniýany pozup bolmaýar: ${staffCount} işgär, ${epCount} API, ${connCount} DB baglanyşyk bar. Ilki olary aýyryň.`,
            staffCount,
            endpointCount: epCount,
            connectionCount: connCount,
        });
    }
    // Unassign all devices from this firm (do NOT set device status back to pending)
    try {
        const assignedDevices = db
            .prepare(`SELECT DISTINCT device_id FROM device_assignments WHERE tenant_slug = ?`)
            .all(t.slug);
        db.prepare(`DELETE FROM device_assignments WHERE tenant_slug = ?`).run(t.slug);
        for (const row of assignedDevices) {
            const remaining = db
                .prepare(`SELECT tenant_slug FROM device_assignments WHERE device_id = ?`)
                .all(row.device_id);
            const nextPrimary = remaining[0]?.tenant_slug || '';
            db.prepare(`UPDATE devices SET tenant_slug = ?, updated_at = datetime('now') WHERE id = ? AND (tenant_slug = ? OR tenant_slug = '' OR tenant_slug IS NULL)`).run(nextPrimary, row.device_id, t.slug);
            // If primary was this slug, point to another assignment
            db.prepare(`UPDATE devices SET tenant_slug = COALESCE(NULLIF(tenant_slug, ?), ?), updated_at = datetime('now') WHERE id = ?`).run(t.slug, nextPrimary, row.device_id);
            try {
                deviceEventManager_1.deviceEventManager.broadcast(row.device_id, {
                    type: 'DEVICE_UPDATED',
                    deviceId: row.device_id,
                    companySlugs: remaining.map((r) => r.tenant_slug),
                    removedSlug: t.slug,
                });
            }
            catch {
                /* */
            }
        }
    }
    catch (e) {
        console.warn('[tenant-delete] unassign devices', e);
    }
    db.prepare(`DELETE FROM tenant_connections WHERE tenant_id = ?`).run(t.id);
    db.prepare(`DELETE FROM tenants WHERE id = ?`).run(t.id);
    (0, sqliteDb_1.logSync)('delete', 'tenant', t.id, 'electron', { slug: t.slug });
    return reply.send({ ok: true, deleted: true, slug: t.slug, unassigned: true });
}
// ── Hard delete staff ────────────────────────────────────────
// ── Single staff upsert (create/update, VPS primary) ─────────
const StaffUpsertSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    tenantSlug: zod_1.z.string().min(1),
    tenantSlugs: zod_1.z.array(zod_1.z.string()).optional(),
    fullName: zod_1.z.string().min(1),
    username: zod_1.z.string().min(1),
    passwordHash: zod_1.z.string().optional(),
    passwordPlain: zod_1.z.string().optional(),
    role: zod_1.z.string().default('viewer'),
    phone: zod_1.z.string().optional(),
    email: zod_1.z.string().optional(),
    active: zod_1.z.boolean().optional(),
});
async function staffUpsertHandler(req, reply) {
    const parsed = StaffUpsertSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const d = parsed.data;
    const now = new Date().toISOString();
    const uname = d.username.toLowerCase();
    // Duplicate username check (global)
    const existingByUser = db
        .prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`)
        .get(uname);
    let id = d.id;
    let prev = null;
    if (id) {
        prev = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(id);
    }
    if (!prev && existingByUser) {
        prev = existingByUser;
        id = existingByUser.id;
    }
    if (!prev && existingByUser && d.id && existingByUser.id !== d.id) {
        return reply.code(409).send({
            error: 'duplicate',
            message: `Username "${d.username}" eýýäm bar.`,
        });
    }
    if (existingByUser && (!prev || existingByUser.id !== (prev?.id || id))) {
        // another record with same username
        if (!d.id || existingByUser.id !== d.id) {
            return reply.code(409).send({
                error: 'duplicate',
                message: `Username "${d.username}" eýýäm bar.`,
            });
        }
    }
    const passwordEnc = d.passwordPlain
        ? (0, passwordEnc_1.encryptPasswordPlain)(d.passwordPlain)
        : prev?.password_enc || '';
    let passwordHash = d.passwordHash || prev?.password_hash || '';
    if (d.passwordPlain && !passwordHash) {
        passwordHash = 'pending-reset:' + now;
    }
    const tenantSlugs = JSON.stringify(d.tenantSlugs?.length ? d.tenantSlugs : [d.tenantSlug]);
    const active = d.active === false ? 0 : 1;
    if (prev) {
        db.prepare(`
      UPDATE staff SET
        tenant_slug = ?, tenant_slugs = ?, full_name = ?, username = ?,
        password_hash = COALESCE(NULLIF(?, ''), password_hash),
        password_enc = COALESCE(NULLIF(?, ''), password_enc),
        role = ?, phone = ?, email = ?, active = ?, updated_at = ?
      WHERE id = ?
    `).run(d.tenantSlug, tenantSlugs, d.fullName, d.username, passwordHash, passwordEnc, d.role, d.phone ?? prev.phone ?? '', d.email ?? prev.email ?? '', active, now, prev.id);
        id = prev.id;
        (0, sqliteDb_1.logSync)('update', 'staff', id ?? null, 'api', { username: d.username });
    }
    else {
        id = d.id || randomId();
        db.prepare(`
      INSERT INTO staff (
        id, tenant_slug, tenant_slugs, full_name, username, password_hash, password_enc,
        role, phone, email, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, d.tenantSlug, tenantSlugs, d.fullName, d.username, passwordHash || 'pending-reset:' + now, passwordEnc, d.role, d.phone || '', d.email || '', active, now, now);
        (0, sqliteDb_1.logSync)('create', 'staff', id, 'api', { username: d.username });
    }
    return reply.send({
        ok: true,
        staff: {
            id,
            tenantSlug: d.tenantSlug,
            fullName: d.fullName,
            username: d.username,
            role: d.role,
            active: active === 1,
        },
    });
}
const StaffDeleteSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    username: zod_1.z.string().optional(),
    tenantSlug: zod_1.z.string().optional(),
});
async function staffDeleteHandler(req, reply) {
    const parsed = StaffDeleteSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    let row = null;
    if (parsed.data.id) {
        row = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(parsed.data.id);
    }
    else if (parsed.data.username) {
        row = parsed.data.tenantSlug
            ? db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ? AND tenant_slug = ?`).get(parsed.data.username.toLowerCase(), parsed.data.tenantSlug)
            : db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`).get(parsed.data.username.toLowerCase());
    }
    if (!row)
        return reply.code(404).send({ error: 'Staff not found' });
    db.prepare(`DELETE FROM staff WHERE id = ?`).run(row.id);
    (0, sqliteDb_1.logSync)('delete', 'staff', row.id, 'electron', { username: row.username });
    return reply.send({ ok: true, deleted: true, id: row.id, username: row.username });
}
// ── Device Management Handlers ──────────────────────────────────────────
const DeviceRegisterSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    token: zod_1.z.string().min(1),
    name: zod_1.z.string().default(''),
    hostname: zod_1.z.string().default(''),
    osPlatform: zod_1.z.string().default(''),
    osRelease: zod_1.z.string().default(''),
    ramGb: zod_1.z.number().default(0),
    cpuModel: zod_1.z.string().default(''),
    macAddress: zod_1.z.string().optional().default(''),
    ipAddress: zod_1.z.string().optional().default(''),
    appVersion: zod_1.z.string().optional().default('1.0.0'),
    deviceSyncSecret: zod_1.z.string().optional().default(''),
});
async function deviceRegisterHandler(req, reply) {
    const parsed = DeviceRegisterSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const existing = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(d.id);
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    const hasSyncSecretCol = cols('devices').includes('device_sync_secret');
    if (existing) {
        // Pending: Electron iberen secret bilen syncla (tunnel HMAC gabat gelsin).
        // Approved: bar bolan secret-i sakla (BI tassyklanandan soň üýtgemez).
        let deviceSyncSecret;
        if (hasSyncSecretCol) {
            if (existing.status === 'pending' && d.deviceSyncSecret) {
                deviceSyncSecret = d.deviceSyncSecret;
            }
            else {
                deviceSyncSecret =
                    existing.device_sync_secret || d.deviceSyncSecret || node_crypto_1.default.randomBytes(32).toString('hex');
            }
        }
        const setClauses = [
            'name = COALESCE(NULLIF(?, \'\'), name)',
            'hostname = ?',
            'os_platform = ?',
            'os_release = ?',
            'ram_gb = ?',
            'cpu_model = ?',
            'mac_address = ?',
            'ip_address = ?',
            'app_version = ?',
            'last_seen_at = datetime(\'now\')',
            'updated_at = datetime(\'now\')',
        ];
        const setParams = [
            d.name || existing.name,
            d.hostname,
            d.osPlatform,
            d.osRelease,
            d.ramGb,
            d.cpuModel,
            d.macAddress,
            d.ipAddress,
            d.appVersion,
        ];
        if (hasSyncSecretCol && deviceSyncSecret) {
            setClauses.push('device_sync_secret = ?');
            setParams.push(deviceSyncSecret);
        }
        db.prepare(`
      UPDATE devices
      SET ${setClauses.join(',\n          ')}
      WHERE id = ?
    `).run(...setParams, d.id);
    }
    else {
        const deviceSyncSecret = d.deviceSyncSecret || node_crypto_1.default.randomBytes(32).toString('hex');
        if (hasSyncSecretCol) {
            db.prepare(`
        INSERT INTO devices (
          id, token, name, hostname, os_platform, os_release,
          ram_gb, cpu_model, mac_address, ip_address, tenant_id,
          tenant_slug, status, app_version, device_sync_secret, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 'pending', ?, ?, datetime('now'), datetime('now'), datetime('now'))
      `).run(d.id, d.token, d.name || d.hostname || 'Client Server', d.hostname, d.osPlatform, d.osRelease, d.ramGb, d.cpuModel, d.macAddress, d.ipAddress, d.appVersion, deviceSyncSecret);
        }
        else {
            db.prepare(`
        INSERT INTO devices (
          id, token, name, hostname, os_platform, os_release,
          ram_gb, cpu_model, mac_address, ip_address, tenant_id,
          tenant_slug, status, app_version, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 'pending', ?, datetime('now'), datetime('now'), datetime('now'))
      `).run(d.id, d.token, d.name || d.hostname || 'Client Server', d.hostname, d.osPlatform, d.osRelease, d.ramGb, d.cpuModel, d.macAddress, d.ipAddress, d.appVersion);
        }
        (0, sqliteDb_1.logSync)('create', 'device', d.id, 'electron', { hostname: d.hostname, name: d.name });
    }
    const updated = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(d.id);
    let companyName = '';
    if (updated.tenant_slug) {
        const t = db.prepare(`SELECT name FROM tenants WHERE slug = ?`).get(updated.tenant_slug);
        if (t)
            companyName = t.name;
    }
    return reply.send({
        ok: true,
        id: updated.id,
        token: updated.token,
        status: updated.status,
        tenantId: updated.tenant_id,
        tenantSlug: updated.tenant_slug,
        companyName,
        name: updated.name,
        deviceSyncSecret: updated.device_sync_secret || undefined,
    });
}
async function deviceStatusHandler(req, reply) {
    const query = req.query;
    if (!query.deviceId)
        return reply.code(400).send({ error: 'deviceId query param is required' });
    const db = (0, sqliteDb_1.getDb)();
    const row = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(query.deviceId);
    if (!row) {
        return reply.code(404).send({ error: 'Device not found', status: 'not_found' });
    }
    // Auth: valid device-sig OR matching token (never fail signature before trying token —
    // Electron may send local secret that differs from DB until approved/synced)
    const deviceSyncSecretHeader = req.headers['x-device-sync-signature'] || '';
    const deviceIdHeader = req.headers['x-device-id'] || '';
    let authed = false;
    if (deviceSyncSecretHeader && deviceIdHeader && row.device_sync_secret) {
        const payload = JSON.stringify({ deviceId: deviceIdHeader });
        const expected = node_crypto_1.default
            .createHmac('sha256', row.device_sync_secret)
            .update(payload)
            .digest('hex');
        const sigBuf = Buffer.from(deviceSyncSecretHeader);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length === expBuf.length && node_crypto_1.default.timingSafeEqual(sigBuf, expBuf)) {
            authed = true;
        }
        // invalid signature → fall through to token auth (pending devices)
    }
    if (!authed && query.token && row.token && String(query.token) === String(row.token)) {
        authed = true;
    }
    // Also accept deviceId-only match for pending if token missing on old rows
    if (!authed && row.status === 'pending' && query.deviceId === row.id) {
        if (query.token && row.token && String(query.token) === String(row.token)) {
            authed = true;
        }
        else if (!row.token && query.deviceId) {
            authed = true; // legacy rows without token
        }
    }
    if (!authed) {
        return reply.code(401).send({
            error: 'Unauthorized — device token query param required (or valid X-Device-Sync-Signature)',
            status: 'unauthorized',
        });
    }
    {
        const now = new Date().toISOString();
        db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(now, now, query.deviceId);
    }
    const assignments = db.prepare(`
    SELECT da.tenant_slug, t.name as tenant_name
    FROM device_assignments da
    LEFT JOIN tenants t ON da.tenant_slug = t.slug
    WHERE da.device_id = ?
  `).all(query.deviceId);
    const companySlugs = assignments.map((a) => a.tenant_slug);
    const companyNames = assignments.map((a) => a.tenant_name);
    let companyName = '';
    if (row.tenant_slug) {
        const t = db.prepare(`SELECT name FROM tenants WHERE slug = ?`).get(row.tenant_slug);
        if (t)
            companyName = t.name;
    }
    return reply.send({
        ok: true,
        id: row.id,
        status: row.status,
        tenantId: row.tenant_id,
        tenantSlug: row.tenant_slug,
        companyName,
        companySlugs,
        companyNames,
        deviceSyncSecret: row.device_sync_secret || undefined,
        name: row.name,
        hostname: row.hostname,
    });
}
async function listDevicesHandler(_req, reply) {
    const db = (0, sqliteDb_1.getDb)();
    const rows = db.prepare(`
    SELECT d.*, 
      t.name as company_name, 
      t.slug as company_slug,
      GROUP_CONCAT(DISTINCT da.tenant_slug) as all_tenant_slugs,
      GROUP_CONCAT(DISTINCT tn.name) as all_tenant_names
    FROM devices d
    LEFT JOIN tenants t ON d.tenant_slug = t.slug
    LEFT JOIN device_assignments da ON d.id = da.device_id
    LEFT JOIN tenants tn ON da.tenant_slug = tn.slug
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all();
    const devices = rows.map((r) => {
        const companySlugs = r.all_tenant_slugs ? r.all_tenant_slugs.split(',') : (r.company_slug ? [r.company_slug] : []);
        const companyNames = r.all_tenant_names ? r.all_tenant_names.split(',') : (r.company_name ? [r.company_name] : []);
        return {
            id: r.id,
            name: r.name,
            hostname: r.hostname,
            osPlatform: r.os_platform,
            osRelease: r.os_release,
            ramGb: r.ram_gb,
            cpuModel: r.cpu_model,
            macAddress: r.mac_address,
            ipAddress: r.ip_address,
            tenantId: r.tenant_id,
            tenantSlug: r.tenant_slug || r.company_slug || '',
            companyName: r.company_name || '',
            companySlugs,
            companyNames,
            status: r.status,
            appVersion: r.app_version,
            deviceSyncSecret: r.device_sync_secret || undefined,
            lastSeenAt: r.last_seen_at,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        };
    });
    return reply.send({ ok: true, devices });
}
async function approveDeviceHandler(req, reply) {
    const params = req.params;
    const body = req.body;
    if (!params.id) {
        return reply.code(400).send({ error: 'Device id is required' });
    }
    const tenantSlugs = Array.isArray(body.tenantSlugs)
        ? body.tenantSlugs.filter(Boolean)
        : body.tenantSlug
            ? [body.tenantSlug]
            : [];
    if (tenantSlugs.length === 0) {
        return reply.code(400).send({ error: 'At least one tenantSlug is required' });
    }
    const db = (0, sqliteDb_1.getDb)();
    const placeholders = tenantSlugs.map(() => '?').join(',');
    const tenants = db.prepare(`SELECT * FROM tenants WHERE slug IN (${placeholders})`).all(...tenantSlugs);
    if (tenants.length === 0) {
        return reply.code(404).send({ error: 'Company (tenant) not found' });
    }
    const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id);
    if (!device)
        return reply.code(404).send({ error: 'Device not found' });
    const primaryTenant = tenants[0];
    // NOTE: previously this did `DELETE FROM device_assignments WHERE device_id = ?`
    // unconditionally, wiping out ALL firms already linked to this device before
    // re-inserting only the slugs sent in *this* request. If the admin/BI approved
    // firms one at a time (e.g. approve "A" today, approve "B" next week without
    // re-sending "A"), the previously assigned firm(s) silently disappeared and
    // only the most recently approved firm remained. claimTenantAssignments()
    // below already handles per-slug conflict resolution (stealing a slug from
    // another device) without touching this device's other, unrelated slugs —
    // so we no longer need (or want) a blanket delete here.
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    const hasSyncSecretCol = cols('devices').includes('device_sync_secret');
    const deviceSyncSecret = hasSyncSecretCol
        ? (device.device_sync_secret || node_crypto_1.default.randomBytes(32).toString('hex'))
        : undefined;
    const setClauses = [
        'tenant_id = ?',
        'tenant_slug = ?',
        'status = \'approved\'',
        'name = COALESCE(NULLIF(?, \'\'), name)',
        'updated_at = datetime(\'now\')',
    ];
    const setParams = [primaryTenant.id, primaryTenant.slug, body.name || ''];
    if (hasSyncSecretCol) {
        setClauses.push('device_sync_secret = ?');
        setParams.push(deviceSyncSecret);
    }
    db.prepare(`
    UPDATE devices
    SET ${setClauses.join(',\n        ')}
    WHERE id = ?
  `).run(...setParams, params.id);
    // 1 firm = 1 device: claim firms (removes them from any other device — admin transfer)
    claimTenantAssignments(db, params.id, tenants.map((t) => t.slug), 'admin-approve');
    (0, sqliteDb_1.logSync)('approve', 'device', params.id, 'bi_admin', { tenantSlugs: tenants.map((t) => t.slug) });
    const updated = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id);
    // ⚡ Real-time push to the Electron device — it will automatically detect it was approved
    deviceEventManager_1.deviceEventManager.broadcast(params.id, {
        type: 'DEVICE_APPROVED',
        deviceId: params.id,
        status: 'approved',
        companySlugs: tenants.map((t) => t.slug),
        companyNames: tenants.map((t) => t.name),
    });
    return reply.send({
        ok: true,
        device: {
            id: updated.id,
            name: updated.name,
            tenantId: updated.tenant_id,
            tenantSlug: updated.tenant_slug,
            companyName: primaryTenant.name,
            companyNames: tenants.map((t) => t.name),
            companySlugs: tenants.map((t) => t.slug),
            status: updated.status,
            deviceSyncSecret: updated.device_sync_secret,
        },
    });
}
async function updateDeviceStatusHandler(req, reply) {
    const params = req.params;
    const body = req.body;
    const db = (0, sqliteDb_1.getDb)();
    const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id);
    if (!device)
        return reply.code(404).send({ error: 'Device not found' });
    if (body.status === 'approved' && !body.tenantSlug && !body.tenantSlugs?.length && !device.tenant_slug) {
        return reply.code(400).send({ error: 'tenantSlug is required to approve a device' });
    }
    const tenantSlugs = Array.isArray(body.tenantSlugs)
        ? body.tenantSlugs.filter(Boolean)
        : body.tenantSlug
            ? [body.tenantSlug]
            : device.tenant_slug
                ? [device.tenant_slug]
                : [];
    let tenantId = device.tenant_id;
    let tenantSlug = device.tenant_slug;
    if (tenantSlugs.length > 0) {
        const placeholders = tenantSlugs.map(() => '?').join(',');
        const tenants = db.prepare(`SELECT * FROM tenants WHERE slug IN (${placeholders})`).all(...tenantSlugs);
        if (tenants.length > 0) {
            tenantId = tenants[0].id;
            tenantSlug = tenants[0].slug;
        }
    }
    if (body.status === 'approved' && tenantSlugs.length > 0) {
        // 1 firm = 1 device: claim (transfer off other devices) + ensure this device has rows
        claimTenantAssignments(db, params.id, tenantSlugs, 'admin-update');
    }
    db.prepare(`
    UPDATE devices
    SET status = COALESCE(?, status),
        tenant_id = ?,
        tenant_slug = ?,
        name = COALESCE(NULLIF(?, ''), name),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(body.status, tenantId, tenantSlug, body.name || '', params.id);
    (0, sqliteDb_1.logSync)('update', 'device', params.id, 'bi_admin', { status: body.status, tenantSlugs });
    // ⚡ Real-time push — Electron immediately switches to blocked/pending state
    if (body.status === 'blocked') {
        deviceEventManager_1.deviceEventManager.broadcast(params.id, {
            type: 'DEVICE_BLOCKED',
            deviceId: params.id,
            status: 'blocked',
        });
    }
    else if (body.status === 'approved') {
        deviceEventManager_1.deviceEventManager.broadcast(params.id, {
            type: 'DEVICE_APPROVED',
            deviceId: params.id,
            status: 'approved',
            companySlugs: tenantSlugs,
        });
    }
    else if (body.status === 'pending') {
        deviceEventManager_1.deviceEventManager.broadcast(params.id, {
            type: 'DEVICE_UPDATED',
            deviceId: params.id,
            status: 'pending',
        });
    }
    return reply.send({ ok: true, status: body.status, tenantSlugs });
}
async function deleteDeviceHandler(req, reply) {
    const params = req.params;
    const db = (0, sqliteDb_1.getDb)();
    const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id);
    if (!device)
        return reply.code(404).send({ error: 'Device not found' });
    // ⚡ Real-time push to the Electron device — it sees the device was deleted
    deviceEventManager_1.deviceEventManager.broadcast(params.id, {
        type: 'DEVICE_DELETED',
        deviceId: params.id,
        status: 'deleted',
    });
    db.prepare(`DELETE FROM devices WHERE id = ?`).run(params.id);
    (0, sqliteDb_1.logSync)('delete', 'device', params.id, 'bi_admin', { hostname: device.hostname });
    return reply.send({ ok: true, deleted: true, id: params.id });
}
// ── Tenant DB connections CRUD (BI + Electron sync) ───────────
function buildMssqlConnString(input) {
    const port = input.port || 1433;
    const encrypt = input.encrypt !== false ? 'true' : 'false';
    const trust = input.trustServerCertificate !== false ? 'true' : 'false';
    return [
        `Server=${input.host},${port}`,
        `Database=${input.database || ''}`,
        `User Id=${input.username || ''}`,
        `Password=${input.password || ''}`,
        `Encrypt=${encrypt}`,
        `TrustServerCertificate=${trust}`,
    ].join(';');
}
const ConnectionUpsertSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    tenantSlug: zod_1.z.string().min(1),
    dbKey: zod_1.z.string().min(1).optional(),
    label: zod_1.z.string().optional(),
    database: zod_1.z.string().optional(),
    host: zod_1.z.string().min(1),
    port: zod_1.z.number().optional(),
    username: zod_1.z.string().optional(),
    password: zod_1.z.string().optional(), // empty = keep existing
    encrypt: zod_1.z.boolean().optional(),
    trustServerCertificate: zod_1.z.boolean().optional(),
    isPrimary: zod_1.z.boolean().optional(),
});
async function connectionUpsertHandler(req, reply) {
    const parsed = ConnectionUpsertSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const d = parsed.data;
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(d.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Tenant not found' });
    const now = new Date().toISOString();
    const dbKey = d.dbKey ||
        (d.label || d.database || 'primary')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') ||
        'primary';
    let existing = null;
    if (d.id) {
        existing = db.prepare(`SELECT * FROM tenant_connections WHERE id = ?`).get(d.id);
    }
    if (!existing) {
        existing = db
            .prepare(`SELECT * FROM tenant_connections WHERE tenant_id = ? AND db_key = ?`)
            .get(tenant.id, dbKey);
    }
    let password = d.password || '';
    if (!password && existing?.db_conn_enc && existing?.db_conn_iv) {
        try {
            const { decryptConnString } = await Promise.resolve().then(() => __importStar(require('../../core/db/crypto')));
            const plain = decryptConnString(existing.db_conn_enc, existing.db_conn_iv);
            const m = plain.match(/Password=([^;]*)/i);
            password = m ? m[1] : '';
        }
        catch {
            password = '';
        }
    }
    const connStr = buildMssqlConnString({
        host: d.host,
        port: d.port ?? 1433,
        database: d.database || '',
        username: d.username || '',
        password,
        encrypt: d.encrypt !== false,
        trustServerCertificate: d.trustServerCertificate !== false,
    });
    const { encryptConnString } = await Promise.resolve().then(() => __importStar(require('../../core/db/crypto')));
    const { enc, iv } = encryptConnString(connStr);
    const isPrimary = d.isPrimary ? 1 : existing?.is_primary ? 1 : 0;
    if (d.isPrimary) {
        db.prepare(`UPDATE tenant_connections SET is_primary = 0 WHERE tenant_id = ?`).run(tenant.id);
    }
    let id;
    if (existing) {
        id = existing.id;
        db.prepare(`UPDATE tenant_connections SET
        db_key = ?, label = ?, database_name = ?,
        db_conn_enc = ?, db_conn_iv = ?,
        host = ?, port = ?, username = ?,
        encrypt = ?, trust_server_certificate = ?, is_primary = ?,
        updated_at = ?
       WHERE id = ?`).run(dbKey, d.label || dbKey, d.database || '', enc, iv, d.host, d.port ?? 1433, d.username || '', d.encrypt !== false ? 1 : 0, d.trustServerCertificate !== false ? 1 : 0, isPrimary || (d.isPrimary === false ? 0 : existing.is_primary || 0), now, existing.id);
    }
    else {
        // Ensure primary if first connection
        const cnt = db.prepare(`SELECT COUNT(*) as c FROM tenant_connections WHERE tenant_id = ?`).get(tenant.id).c;
        const primaryFlag = d.isPrimary || cnt === 0 ? 1 : 0;
        const guid = randomId();
        const info = db
            .prepare(`INSERT INTO tenant_connections (
          tenant_id, db_key, label, database_name, db_conn_enc, db_conn_iv,
          host, port, username, encrypt, trust_server_certificate, is_primary, guid, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(tenant.id, dbKey, d.label || dbKey, d.database || '', enc, iv, d.host, d.port ?? 1433, d.username || '', d.encrypt !== false ? 1 : 0, d.trustServerCertificate !== false ? 1 : 0, primaryFlag, guid, now);
        id = Number(info.lastInsertRowid);
    }
    // Mirror primary into tenants.db_conn_enc for backward compat
    if (isPrimary || d.isPrimary) {
        db.prepare(`UPDATE tenants SET db_conn_enc = ?, db_conn_iv = ?, updated_at = ? WHERE id = ?`).run(enc, iv, now, tenant.id);
    }
    try {
        const { invalidateTenantPool } = await Promise.resolve().then(() => __importStar(require('../../core/db/connectionPoolManager')));
        invalidateTenantPool(d.tenantSlug);
    }
    catch {
        /* */
    }
    (0, sqliteDb_1.logSync)('update', 'connection', String(id), 'bi_admin', { tenantSlug: d.tenantSlug, dbKey });
    return reply.send({
        ok: true,
        connection: {
            id: String(id),
            tenantSlug: d.tenantSlug,
            dbKey,
            label: d.label || dbKey,
            database: d.database || '',
            host: d.host,
            port: d.port ?? 1433,
            username: d.username || '',
            encrypt: d.encrypt !== false,
            trustServerCertificate: d.trustServerCertificate !== false,
            isPrimary: Boolean(d.isPrimary || isPrimary),
        },
    });
}
const ConnectionDeleteSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    tenantSlug: zod_1.z.string().min(1),
    dbKey: zod_1.z.string().optional(),
});
async function connectionDeleteHandler(req, reply) {
    const parsed = ConnectionDeleteSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Tenant not found' });
    let row = null;
    if (parsed.data.id) {
        row = db.prepare(`SELECT * FROM tenant_connections WHERE id = ?`).get(parsed.data.id);
    }
    else if (parsed.data.dbKey) {
        row = db
            .prepare(`SELECT * FROM tenant_connections WHERE tenant_id = ? AND db_key = ?`)
            .get(tenant.id, parsed.data.dbKey);
    }
    if (!row)
        return reply.code(404).send({ error: 'Connection not found' });
    // Block delete if endpoints use this db_key
    const epCnt = db
        .prepare(`SELECT COUNT(*) as c FROM endpoints WHERE tenant_slug = ? AND db_key = ?`)
        .get(tenant.slug, row.db_key).c;
    if (epCnt > 0) {
        return reply.code(409).send({
            error: 'has_dependencies',
            message: `Bu baglanyşyk ${epCnt} API tarapyndan ulanylýar. Ilki API-lary üýtgediň ýa-da aýyryň.`,
            endpointCount: epCnt,
        });
    }
    db.prepare(`DELETE FROM tenant_connections WHERE id = ?`).run(row.id);
    (0, sqliteDb_1.logSync)('delete', 'connection', String(row.id), 'bi_admin', {
        tenantSlug: tenant.slug,
        dbKey: row.db_key,
    });
    try {
        const { invalidateTenantPool } = await Promise.resolve().then(() => __importStar(require('../../core/db/connectionPoolManager')));
        invalidateTenantPool(tenant.slug);
    }
    catch {
        /* */
    }
    return reply.send({ ok: true, deleted: true, id: String(row.id) });
}
// ── Staff password reset (BI forgot-password) ────────────────
const StaffPasswordResetSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    username: zod_1.z.string().min(1),
    passwordHash: zod_1.z.string().min(1),
    passwordPlain: zod_1.z.string().optional(),
    tenantSlug: zod_1.z.string().optional(),
});
async function staffPasswordResetHandler(req, reply) {
    const parsed = StaffPasswordResetSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const now = new Date().toISOString();
    let row = null;
    if (parsed.data.id) {
        row = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(parsed.data.id);
    }
    if (!row) {
        row = parsed.data.tenantSlug
            ? db
                .prepare(`SELECT * FROM staff WHERE LOWER(username) = ? AND tenant_slug = ?`)
                .get(parsed.data.username.toLowerCase(), parsed.data.tenantSlug)
            : db
                .prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`)
                .get(parsed.data.username.toLowerCase());
    }
    if (!row)
        return reply.code(404).send({ error: 'Staff not found' });
    let passwordEnc = row.password_enc || '';
    if (parsed.data.passwordPlain) {
        try {
            passwordEnc = (0, passwordEnc_1.encryptPasswordPlain)(parsed.data.passwordPlain);
        }
        catch {
            /* keep old */
        }
    }
    db.prepare(`UPDATE staff SET password_hash = ?, password_enc = ?, updated_at = ? WHERE id = ?`).run(parsed.data.passwordHash, passwordEnc, now, row.id);
    (0, sqliteDb_1.logSync)('update', 'staff', row.id, 'bi_admin', {
        action: 'password_reset',
        username: row.username,
    });
    return reply.send({ ok: true, id: row.id, username: row.username });
}
/** GET /api/admin/debug-routes — list in-memory routes (+ optional tenant filter) */
async function debugRoutesHandler(req, reply) {
    const q = req.query;
    try {
        const { routeRegistry } = await Promise.resolve().then(() => __importStar(require('../../core/router/routeRegistry')));
        if (q.rebuild === '1') {
            const all = await tenant_repository_1.tenantRepository.listAllEndpoints();
            const byTenant = new Map();
            for (const e of all) {
                const slug = e.tenantSlug;
                if (!slug)
                    continue;
                if (!byTenant.has(slug))
                    byTenant.set(slug, []);
                byTenant.get(slug).push(e);
            }
            for (const [slug, eps] of byTenant) {
                routeRegistry.replaceTenantRoutes(slug, eps.map((e) => ({
                    ...e,
                    pathTemplate: e.pathTemplate?.startsWith?.('/') ? e.pathTemplate : `/${e.pathTemplate || ''}`,
                    dbKey: (e.dbKey || 'primary').toLowerCase(),
                })));
            }
        }
        let routes = routeRegistry.debugAll();
        if (q.tenant) {
            routes = routes.filter((r) => r.tenantSlug === q.tenant || (r.key && String(r.key).startsWith(q.tenant + ':')));
        }
        const db = (0, sqliteDb_1.getDb)();
        const dbCount = db.prepare(`SELECT COUNT(*) as c FROM endpoints`).get()?.c ?? 0;
        const dbRows = q.tenant
            ? db.prepare(`SELECT id, tenant_slug, method, path_template, db_key, name FROM endpoints WHERE tenant_slug = ?`).all(q.tenant)
            : db.prepare(`SELECT id, tenant_slug, method, path_template, db_key, name FROM endpoints LIMIT 100`).all();
        return reply.send({
            ok: true,
            memoryRoutes: routes.length,
            dbEndpoints: dbCount,
            routes,
            dbSample: dbRows,
        });
    }
    catch (err) {
        return reply.code(500).send({ error: String(err) });
    }
}
//# sourceMappingURL=hub.controller.js.map
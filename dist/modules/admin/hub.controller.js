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
exports.entityLockHandler = entityLockHandler;
exports.tenantDeleteHandler = tenantDeleteHandler;
exports.staffDeleteHandler = staffDeleteHandler;
exports.deviceRegisterHandler = deviceRegisterHandler;
exports.deviceStatusHandler = deviceStatusHandler;
exports.listDevicesHandler = listDevicesHandler;
exports.approveDeviceHandler = approveDeviceHandler;
exports.updateDeviceStatusHandler = updateDeviceStatusHandler;
exports.deleteDeviceHandler = deleteDeviceHandler;
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const sqliteDb_1 = require("../../store/sqliteDb");
const tenant_repository_1 = require("../tenant/tenant.repository");
const passwordEnc_1 = require("../../core/db/passwordEnc");
// ── Catalog ──────────────────────────────────────────────────
async function catalogHandler(_req, reply) {
    const db = (0, sqliteDb_1.getDb)();
    // Return all tenants (active + passive) so admin UIs can show / reactivate them
    const tenantRows = db.prepare(`SELECT * FROM tenants`).all();
    const connStmt = db.prepare(`SELECT db_key as dbKey, label, database_name as database FROM tenant_connections WHERE tenant_id = ?`);
    const tenants = tenantRows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        isActive: Boolean(t.is_active),
        connections: connStmt.all(t.id),
        updatedAt: t.updated_at,
    }));
    const endpointRows = db.prepare(`SELECT * FROM endpoints`).all();
    const endpoints = endpointRows.map((e) => ({
        id: e.id,
        tenantSlug: e.tenant_slug,
        name: e.name,
        method: e.method,
        pathTemplate: e.path_template,
        paramsSchema: JSON.parse(e.params_schema || '{}'),
        cacheTtlSec: e.cache_ttl_sec,
        authRequired: Boolean(e.auth_required),
        dbKey: e.db_key,
    }));
    const staffRows = db.prepare(`SELECT * FROM staff`).all();
    const staff = staffRows.map((s) => ({
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
        updatedAt: s.updated_at,
    }));
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
    return reply.send({
        tenants,
        endpoints,
        staff,
        devices,
        syncedAt: new Date().toISOString(),
    });
}
// ── Tenant (Company) CRUD ─────────────────────────────────────
const CreateTenantSchema = zod_1.z.object({
    slug: zod_1.z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
    name: zod_1.z.string().min(1).max(200),
});
async function createTenantHandler(req, reply) {
    const parsed = CreateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { slug, name } = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const existing = db.prepare(`SELECT id FROM tenants WHERE slug = ?`).get(slug);
    if (existing) {
        return reply.code(409).send({ error: `Tenant "${slug}" already exists`, tenantId: existing.id });
    }
    const now = new Date().toISOString();
    const id = node_crypto_1.default.randomUUID();
    db.prepare(`
    INSERT INTO tenants (id, slug, name, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(id, slug, name, now, now);
    (0, sqliteDb_1.logSync)('create', 'tenant', id, 'bi_admin', { slug, name });
    return reply.send({ ok: true, tenant: { id, slug, name, isActive: true, createdAt: now, updatedAt: now } });
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
    const existingForTenant = db
        .prepare(`SELECT * FROM staff WHERE tenant_slug = ?`)
        .all(tenantSlug);
    const byUsername = new Map(existingForTenant.map((s) => [s.username.toLowerCase(), s]));
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
        // Hard-remove staff for this tenant that are no longer in the payload
        for (const prev of existingForTenant) {
            if (!incomingUsernames.has(String(prev.username || '').toLowerCase())) {
                db.prepare(`DELETE FROM staff WHERE id = ?`).run(prev.id);
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
    const tenant = await tenant_repository_1.tenantRepository.findBySlug(user.tenant_slug);
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
        tenantSlugs: JSON.parse(user.tenant_slugs || '[]'),
        tenantName: tenant?.name,
        tenantId: tenant?.id,
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
    let ok = false;
    try {
        if (hash.includes(':')) {
            const [salt, stored] = hash.split(':');
            const candidate = node_crypto_1.default.scryptSync(password, salt, 64).toString('hex');
            const a = Buffer.from(stored, 'hex');
            const b = Buffer.from(candidate, 'hex');
            ok = a.length === b.length && node_crypto_1.default.timingSafeEqual(a, b);
        }
        else if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
            const bcrypt = require('bcryptjs');
            ok = bcrypt.compareSync(password, hash);
        }
        else {
            ok = hash === password;
        }
    }
    catch {
        ok = false;
    }
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
    const id = node_crypto_1.default.randomUUID();
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
        const staffId = existingStaff ? existingStaff.id : node_crypto_1.default.randomUUID();
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
    const notifId = node_crypto_1.default.randomUUID();
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
        const id = node_crypto_1.default.randomUUID();
        const active = parsed.data.isActive !== false ? 1 : 0;
        db.prepare(`
      INSERT INTO tenants (id, slug, name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, parsed.data.slug, parsed.data.name, active, now, now);
        t = { id, slug: parsed.data.slug, name: parsed.data.name, is_active: active };
        (0, sqliteDb_1.logSync)('create', 'tenant', id, 'bi', { slug: parsed.data.slug, isActive: active });
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
        const notifId = node_crypto_1.default.randomUUID();
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
        `).run(node_crypto_1.default.randomUUID(), a.username, 'tenant_deactivated', title, message, now);
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
    db.prepare(`
    UPDATE endpoints SET
      name = ?,
      path_template = ?,
      method = ?,
      db_key = COALESCE(?, db_key),
      updated_at = ?
    WHERE id = ?
  `).run(parsed.data.name, parsed.data.pathTemplate, parsed.data.method.toUpperCase(), parsed.data.dbKey ?? null, now, ep.id);
    (0, sqliteDb_1.logSync)('update', 'endpoint', ep.id, 'electron', { name: parsed.data.name, path: parsed.data.pathTemplate });
    try {
        const { routeRegistry } = await Promise.resolve().then(() => __importStar(require('../../core/router/routeRegistry')));
        const tenantEps = await tenant_repository_1.tenantRepository.listAllEndpoints();
        const filtered = tenantEps.filter((e) => e.tenantSlug === parsed.data.tenantSlug);
        routeRegistry.replaceTenantRoutes(parsed.data.tenantSlug, filtered.map((e) => ({ ...e, dbKey: e.dbKey || 'primary' })));
    }
    catch { /* */ }
    return reply.send({ ok: true, endpoint: { id: ep.id, name: parsed.data.name, pathTemplate: parsed.data.pathTemplate, method: parsed.data.method.toUpperCase() } });
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
    if (staffCount > 0 || epCount > 0) {
        return reply.code(409).send({
            error: 'has_dependencies',
            message: `Kompaniýany pozup bolmaýar: ${staffCount} işgär, ${epCount} API bar. Ilki olary aýyryň.`,
            staffCount,
            endpointCount: epCount,
        });
    }
    db.prepare(`DELETE FROM tenant_connections WHERE tenant_id = ?`).run(t.id);
    db.prepare(`DELETE FROM tenants WHERE id = ?`).run(t.id);
    (0, sqliteDb_1.logSync)('delete', 'tenant', t.id, 'electron', { slug: t.slug });
    return reply.send({ ok: true, deleted: true, slug: t.slug });
}
// ── Hard delete staff ────────────────────────────────────────
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
});
async function deviceRegisterHandler(req, reply) {
    const parsed = DeviceRegisterSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    const db = (0, sqliteDb_1.getDb)();
    const existing = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(d.id);
    if (existing) {
        db.prepare(`
      UPDATE devices
      SET name = COALESCE(NULLIF(?, ''), name),
          hostname = ?,
          os_platform = ?,
          os_release = ?,
          ram_gb = ?,
          cpu_model = ?,
          mac_address = ?,
          ip_address = ?,
          app_version = ?,
          last_seen_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(d.name || existing.name, d.hostname, d.osPlatform, d.osRelease, d.ramGb, d.cpuModel, d.macAddress, d.ipAddress, d.appVersion, d.id);
    }
    else {
        db.prepare(`
      INSERT INTO devices (
        id, token, name, hostname, os_platform, os_release,
        ram_gb, cpu_model, mac_address, ip_address, tenant_id,
        tenant_slug, status, app_version, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 'pending', ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(d.id, d.token, d.name || d.hostname || 'Client Server', d.hostname, d.osPlatform, d.osRelease, d.ramGb, d.cpuModel, d.macAddress, d.ipAddress, d.appVersion);
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
    db.prepare(`UPDATE devices SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(query.deviceId);
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
    db.prepare(`DELETE FROM device_assignments WHERE device_id = ?`).run(params.id);
    db.prepare(`
    UPDATE devices
    SET tenant_id = ?,
        tenant_slug = ?,
        status = 'approved',
        name = COALESCE(NULLIF(?, ''), name),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(primaryTenant.id, primaryTenant.slug, body.name || '', params.id);
    const now = new Date().toISOString();
    const insertAssignment = db.prepare(`
    INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
    VALUES (?, ?, ?, NULL, '', ?, ?)
  `);
    for (const tenant of tenants) {
        const assignmentId = node_crypto_1.default.randomUUID();
        insertAssignment.run(assignmentId, params.id, tenant.slug, now, now);
    }
    (0, sqliteDb_1.logSync)('approve', 'device', params.id, 'bi_admin', { tenantSlugs: tenants.map((t) => t.slug) });
    const updated = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id);
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
        const existingSlugs = db.prepare(`SELECT tenant_slug FROM device_assignments WHERE device_id = ?`).all(params.id);
        const existingSet = new Set(existingSlugs.map((r) => r.tenant_slug));
        const newSlugs = tenantSlugs.filter((s) => !existingSet.has(s));
        if (newSlugs.length > 0) {
            const now = new Date().toISOString();
            const insertAssignment = db.prepare(`
        INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
        VALUES (?, ?, ?, NULL, '', ?, ?)
      `);
            for (const slug of newSlugs) {
                insertAssignment.run(node_crypto_1.default.randomUUID(), params.id, slug, now, now);
            }
        }
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
    return reply.send({ ok: true, status: body.status, tenantSlugs });
}
async function deleteDeviceHandler(req, reply) {
    const params = req.params;
    const db = (0, sqliteDb_1.getDb)();
    const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id);
    if (!device)
        return reply.code(404).send({ error: 'Device not found' });
    db.prepare(`DELETE FROM devices WHERE id = ?`).run(params.id);
    (0, sqliteDb_1.logSync)('delete', 'device', params.id, 'bi_admin', { hostname: device.hostname });
    return reply.send({ ok: true, deleted: true, id: params.id });
}
//# sourceMappingURL=hub.controller.js.map
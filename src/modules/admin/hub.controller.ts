import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getDb, logSync } from '../../store/sqliteDb';
import { tenantRepository } from '../tenant/tenant.repository';
import { encryptPasswordPlain } from '../../core/db/passwordEnc';
import { deviceEventManager } from '../../core/tunnel/deviceEventManager';
import type {
  StaffRecord,
  RegistrationRecord,
  StaffRole,
  UserNotification,
} from '../../types/contracts';

const randomId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// ── Catalog ──────────────────────────────────────────────────

export async function catalogHandler(_req: FastifyRequest, reply: FastifyReply) {
  const db = getDb();

  // Return all tenants (active + passive) so admin UIs can show / reactivate them
  const tenantRows = db.prepare(`SELECT * FROM tenants`).all() as any[];
  const connStmt = db.prepare(
    `SELECT db_key as dbKey, label, database_name as database FROM tenant_connections WHERE tenant_id = ?`
  );

  const tenants = tenantRows.map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
    isActive: Boolean(t.is_active),
    connections: connStmt.all(t.id),
    updatedAt: t.updated_at,
  }));

  const endpointRows = db.prepare(`SELECT * FROM endpoints`).all() as any[];
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

  const staffRows = db.prepare(`SELECT * FROM staff`).all() as any[];
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
  `).all() as any[];
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

const CreateTenantSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
});

export async function createTenantHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = CreateTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const { slug, name } = parsed.data;
  const db = getDb();

  const existing = db.prepare(`SELECT id FROM tenants WHERE slug = ?`).get(slug) as any;
  if (existing) {
    return reply.code(409).send({ error: `Tenant "${slug}" already exists`, tenantId: existing.id });
  }

  const now = new Date().toISOString();
  const id = randomId();

  db.prepare(`
    INSERT INTO tenants (id, slug, name, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(id, slug, name, now, now);

  logSync('create', 'tenant', id, 'bi_admin', { slug, name });

  return reply.send({ ok: true, tenant: { id, slug, name, isActive: true, createdAt: now, updatedAt: now } });
}

// ── Staff sync ───────────────────────────────────────────────

const StaffSyncSchema = z.object({
  tenantSlug: z.string().min(1),
  staff: z.array(
    z.object({
      id: z.string().min(1),
      fullName: z.string().min(1),
      username: z.string().min(1),
      passwordHash: z.string().min(1),
      role: z.enum(['admin', 'editor', 'manager', 'viewer']),
      tenantSlugs: z.array(z.string()).optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      active: z.boolean().default(true),
      passwordEnc: z.string().optional(),
      passwordPlain: z.string().optional(),
    })
  ),
});

export async function syncStaffHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = StaffSyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const { tenantSlug, staff } = parsed.data;
  const tenant = await tenantRepository.findBySlug(tenantSlug);
  if (!tenant) {
    return reply.code(404).send({ error: `Tenant "${tenantSlug}" not found. Sync schema first.` });
  }

  const db = getDb();
  const now = new Date().toISOString();

  const isPlaceholder = (hash: string) =>
    !hash ||
    hash.startsWith('synced-from-bi') ||
    hash.startsWith('pending-reset') ||
    hash.endsWith(':0000');

  const existingForTenant = db
    .prepare(`SELECT * FROM staff WHERE tenant_slug = ?`)
    .all(tenantSlug) as any[];
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

  const incomingUsernames = new Set(
    staff.map((s) => String(s.username || '').toLowerCase()).filter(Boolean)
  );

  const tx = db.transaction(() => {
    for (const s of staff) {
      const prev = byUsername.get(s.username.toLowerCase());
      let passwordHash = s.passwordHash;
      if (isPlaceholder(passwordHash) && prev && !isPlaceholder(prev.password_hash)) {
        passwordHash = prev.password_hash;
      }

      const passwordEnc = (s as any).passwordPlain
        ? encryptPasswordPlain((s as any).passwordPlain)
        : (s as any).passwordEnc || prev?.password_enc || '';

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
  logSync('sync', 'staff', tenant.id, 'electron', { count: staff.length, tenantSlug });

  return reply.send({
    status: 'success',
    tenantSlug,
    staffLoaded: staff.length,
    syncedAt: now,
  });
}

// ── Staff lookup (login) ─────────────────────────────────────

const AuthLookupSchema = z.object({
  username: z.string().min(1),
});

const StaffVerifySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function staffLookupHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = AuthLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'username required' });
  }

  const db = getDb();
  const username = String(parsed.data.username || '').trim().toLowerCase();

  // Check pending registration first
  const pending = db
    .prepare(`SELECT * FROM registrations WHERE LOWER(username) = ? AND status = 'pending'`)
    .get(username) as any;
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
    .get(username) as any;

  const staffCount = (db.prepare(`SELECT COUNT(*) as c FROM staff WHERE LOWER(username) = ? AND active = 1`).get(username) as any).c;

  if (rejected && staffCount === 0) {
    return reply.code(403).send({
      error: 'registration_rejected',
      message: 'Hasaba alyş islegiňiz ret edildi.' + (rejected.note ? ` Sebäp: ${rejected.note}` : ''),
      registrationId: rejected.id,
      status: 'rejected',
    });
  }

  const matches = db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`).all(username) as any[];

  if (matches.length === 0) {
    const totalStaffCount = (db.prepare(`SELECT COUNT(*) as c FROM staff`).get() as any).c;
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

  const tenant = await tenantRepository.findBySlug(user.tenant_slug);
  const hash = user.password_hash || '';
  const isPlaceholder =
    !hash ||
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

export async function staffVerifyHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = StaffVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const { username, password } = parsed.data;
  const db = getDb();
  const user = db
    .prepare(`SELECT * FROM staff WHERE LOWER(username) = ? AND active = 1`)
    .get(username.toLowerCase()) as any;

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
      const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
      const a = Buffer.from(stored, 'hex');
      const b = Buffer.from(candidate, 'hex');
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    } else if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
      const bcrypt = require('bcryptjs') as typeof import('bcryptjs');
      ok = bcrypt.compareSync(password, hash);
    } else {
      ok = hash === password;
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    return reply.code(401).send({ error: 'invalid_password' });
  }

  return reply.send({ ok: true, userId: user.id, username: user.username });
}

// ── Registrations ────────────────────────────────────────────

const CreateRegSchema = z.object({
  tenantSlug: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(5),
  email: z.string().email(),
  username: z.string().min(3),
  passwordHash: z.string().min(1),
  requestedRole: z.enum(['admin', 'editor', 'manager', 'viewer']).optional(),
});

export async function createRegistrationHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = CreateRegSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const tenant = await tenantRepository.findBySlug(data.tenantSlug);
  if (!tenant || !tenant.isActive) {
    return reply.code(404).send({ error: 'Company not found' });
  }

  const db = getDb();
  const unameLower = data.username.toLowerCase();

  const staffExists = db.prepare(`SELECT 1 FROM staff WHERE LOWER(username) = ?`).get(unameLower);
  const regExists = db.prepare(`SELECT 1 FROM registrations WHERE LOWER(username) = ? AND status = 'pending'`).get(unameLower);

  if (staffExists || regExists) {
    return reply.code(409).send({ error: 'Username already taken' });
  }

  let phone = data.phone.trim();
  if (!phone.startsWith('+')) phone = '+993' + phone.replace(/^993/, '');
  if (!phone.startsWith('+993')) phone = '+993' + phone.replace(/^\+?/, '');

  const now = new Date().toISOString();
  const id = randomId();

  db.prepare(`
    INSERT INTO registrations (id, tenant_slug, tenant_name, first_name, last_name, phone, email, username, password_hash, status, requested_role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, tenant.slug, tenant.name, data.firstName, data.lastName, phone, data.email, data.username, data.passwordHash, data.requestedRole || 'viewer', now);

  logSync('create', 'registration', id, 'bi', { username: data.username, tenantSlug: tenant.slug });

  return reply.send({
    ok: true,
    registrationId: id,
    status: 'pending',
    deliveredAt: null,
    message: 'Registration submitted to VPS. Waiting for company Electron admin.',
  });
}

export async function getRegistrationHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const db = getDb();
  const reg = db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(id) as any;
  if (!reg) return reply.code(404).send({ error: 'not found' });

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

export async function listRegistrationsHandler(req: FastifyRequest, reply: FastifyReply) {
  const q = req.query as { tenantSlug?: string; status?: string; markDelivered?: string };
  const db = getDb();

  let sql = 'SELECT id, tenant_slug as tenantSlug, tenant_name as tenantName, first_name as firstName, last_name as lastName, phone, email, username, status, requested_role as requestedRole, reviewed_by as reviewedBy, reviewed_at as reviewedAt, note, delivered_at as deliveredAt, created_at as createdAt FROM registrations WHERE 1=1';
  const params: unknown[] = [];

  if (q.tenantSlug) {
    sql += ' AND tenant_slug = ?';
    params.push(q.tenantSlug);
  }
  if (q.status) {
    sql += ' AND status = ?';
    params.push(q.status);
  }
  sql += ' ORDER BY created_at DESC';

  const list = db.prepare(sql).all(...params) as any[];

  const mark = q.markDelivered === '1' || q.markDelivered === 'true';
  if (mark) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE registrations SET delivered_at = ? WHERE status = 'pending' AND (delivered_at IS NULL OR delivered_at = '')`).run(now);
  }

  return reply.send({ registrations: list });
}

const UpdateRegSchema = z.object({
  id: z.string().min(1),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(5).optional(),
  email: z.string().email().optional(),
  username: z.string().min(3).optional(),
  requestedRole: z.enum(['admin', 'editor', 'manager', 'viewer']).optional(),
  note: z.string().optional(),
});

export async function updateRegistrationHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = UpdateRegSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const { id, ...patch } = parsed.data;
  const db = getDb();
  const reg = db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(id) as any;

  if (!reg) return reply.code(404).send({ error: 'Registration not found' });
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
  `).run(
    patch.firstName ?? null,
    patch.lastName ?? null,
    patch.phone ?? null,
    patch.email ?? null,
    patch.username ?? null,
    patch.requestedRole ?? null,
    patch.note ?? null,
    id
  );

  logSync('update', 'registration', id, 'electron', patch);

  const updated = db.prepare(`SELECT id, tenant_slug as tenantSlug, tenant_name as tenantName, first_name as firstName, last_name as lastName, phone, email, username, status, requested_role as requestedRole, note, created_at as createdAt FROM registrations WHERE id = ?`).get(id);

  return reply.send({ ok: true, registration: updated });
}

const ResolveRegSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['approve', 'reject']),
  note: z.string().optional(),
  role: z.enum(['admin', 'editor', 'manager', 'viewer']).optional(),
  reviewedBy: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
});

export async function resolveRegistrationHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = ResolveRegSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const { id, action, note, role, reviewedBy, firstName, lastName, phone, email } = parsed.data;
  const db = getDb();
  const reg = db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(id) as any;

  if (!reg) return reply.code(404).send({ error: 'Registration not found' });
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

  let staffOut: any = null;

  if (action === 'approve') {
    const staffRole = role || reg.requested_role || 'viewer';
    const existingStaff = db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`).get(reg.username.toLowerCase()) as any;
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
    `).run(
      staffId,
      reg.tenant_slug,
      JSON.stringify([reg.tenant_slug]),
      `${finalFn} ${finalLn}`.trim(),
      reg.username,
      reg.password_hash,
      staffRole,
      phone || reg.phone || '',
      email || reg.email || '',
      now,
      now
    );

    staffOut = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(staffId);
  }

  // Create notification for user
  const notifId = randomId();
  db.prepare(`
    INSERT INTO notifications (id, username, type, title, message, read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(
    notifId,
    reg.username,
    action === 'approve' ? 'registration_approved' : 'registration_rejected',
    action === 'approve' ? 'Hasaba alyş tassyklanyldy' : 'Hasaba alyş ret edildi',
    action === 'approve'
      ? `${reg.tenant_name || reg.tenant_slug} kompaniýasynda hasabyňyz açyldy. Indi girip bilersiňiz.`
      : `Hasaba alyş islegiňiz ret edildi.` + (note ? ` Sebäp: ${note}` : ''),
    now
  );

  logSync(action === 'approve' ? 'update' : 'delete', 'registration', id, 'electron', { action, staffOut });

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

export async function listNotificationsHandler(req: FastifyRequest, reply: FastifyReply) {
  const q = req.query as { username?: string; unreadOnly?: string };
  if (!q.username) {
    return reply.code(400).send({ error: 'username required' });
  }

  const db = getDb();
  let sql = 'SELECT * FROM notifications WHERE LOWER(username) = ?';
  const params: unknown[] = [q.username.toLowerCase()];

  if (q.unreadOnly === '1') {
    sql += ' AND read = 0';
  }
  sql += ' ORDER BY created_at DESC';

  const list = db.prepare(sql).all(...params) as any[];
  return reply.send({ notifications: list });
}

const MarkReadSchema = z.object({
  ids: z.array(z.string()).optional(),
  username: z.string().optional(),
});

export async function markNotificationsReadHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = MarkReadSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'bad body' });

  const db = getDb();
  const { ids, username } = parsed.data;

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
  } else if (username) {
    db.prepare(`UPDATE notifications SET read = 1 WHERE LOWER(username) = ?`).run(username.toLowerCase());
  }

  return reply.send({ ok: true });
}

// ── Tenant & Endpoint updates ────────────────────────────────

const TenantUpdateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  /** Client's last known updated_at — reject if server is newer (concurrent edit) */
  expectedUpdatedAt: z.string().optional(),
});

export async function tenantUpdateHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = TenantUpdateSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const now = new Date().toISOString();
  let t = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.slug) as any;

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
    logSync('create', 'tenant', id, 'bi', { slug: parsed.data.slug, isActive: active });
  } else {
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
    logSync('update', 'tenant', t.id, 'electron', { slug: parsed.data.slug, isActive: newActive });
  }

  // Soft-delete: keep is_active = 0; if related APIs exist, notify and deactivate staff
  if (parsed.data.isActive === false) {
    const epCount = (
      db.prepare(`SELECT COUNT(*) as cnt FROM endpoints WHERE tenant_slug = ?`).get(t.slug) as { cnt: number }
    )?.cnt ?? 0;

    // Do not hard-delete endpoints — only soft-deactivate the company
    db.prepare(`UPDATE staff SET active = 0 WHERE tenant_slug = ?`).run(t.slug);

    const notifId = randomId();
    const title = 'Kompaniýa öçürildi (passiw)';
    const message =
      epCount > 0
        ? `«${t.name}» (${t.slug}) is_active=0 edildi. Bagly API sany: ${epCount}. API-lar saklandy, kompaniýa passiw.`
        : `«${t.name}» (${t.slug}) is_active=0 edildi. Bagly API ýok.`;

    // Notify all super/admin staff (or system-wide via empty username marker)
    const admins = db
      .prepare(
        `SELECT DISTINCT username FROM staff WHERE role IN ('admin', 'super_admin') AND active = 1`
      )
      .all() as { username: string }[];

    if (admins.length === 0) {
      db.prepare(`
        INSERT INTO notifications (id, username, type, title, message, read, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(notifId, 'system', 'tenant_deactivated', title, message, now);
    } else {
      for (const a of admins) {
        db.prepare(`
          INSERT INTO notifications (id, username, type, title, message, read, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(randomId(), a.username, 'tenant_deactivated', title, message, now);
      }
    }

    logSync('update', 'tenant', t.id, 'electron', {
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

const EndpointUpdateSchema = z.object({
  id: z.string(),
  tenantSlug: z.string(),
  name: z.string().min(1),
  pathTemplate: z.string().min(1),
  method: z.string().min(1),
  dbKey: z.string().optional(),
});

export async function endpointUpdateHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = EndpointUpdateSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const now = new Date().toISOString();
  const ep = db.prepare(`SELECT * FROM endpoints WHERE id = ?`).get(parsed.data.id) as any;
  if (!ep) return reply.code(404).send({ error: 'Endpoint not found' });

  db.prepare(`
    UPDATE endpoints SET
      name = ?,
      path_template = ?,
      method = ?,
      db_key = COALESCE(?, db_key),
      updated_at = ?
    WHERE id = ?
  `).run(
    parsed.data.name,
    parsed.data.pathTemplate,
    parsed.data.method.toUpperCase(),
    parsed.data.dbKey ?? null,
    now,
    ep.id
  );

  logSync('update', 'endpoint', ep.id, 'electron', { name: parsed.data.name, path: parsed.data.pathTemplate });

  try {
    const { routeRegistry } = await import('../../core/router/routeRegistry');
    const tenantEps = await tenantRepository.listAllEndpoints();
    const filtered = tenantEps.filter((e) => e.tenantSlug === parsed.data.tenantSlug);
    routeRegistry.replaceTenantRoutes(
      parsed.data.tenantSlug,
      filtered.map((e: any) => ({ ...e, dbKey: e.dbKey || 'primary' })) as any
    );
  } catch { /* */ }

  return reply.send({ ok: true, endpoint: { id: ep.id, name: parsed.data.name, pathTemplate: parsed.data.pathTemplate, method: parsed.data.method.toUpperCase() } });
}


// ── Edit locks (is_open) ─────────────────────────────────────

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

const EntityLockSchema = z.object({
  entityType: z.enum(['tenant', 'staff', 'endpoint']),
  entityId: z.string().min(1),
  action: z.enum(['lock', 'unlock', 'heartbeat']),
  openedBy: z.string().optional(),
});

function lockTable(entityType: 'tenant' | 'staff' | 'endpoint'): string {
  if (entityType === 'tenant') return 'tenants';
  if (entityType === 'staff') return 'staff';
  return 'endpoints';
}

export async function entityLockHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = EntityLockSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const { entityType, entityId, action, openedBy } = parsed.data;
  const db = getDb();
  const table = lockTable(entityType);
  const now = new Date().toISOString();

  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId) as any;
  if (!row) return reply.code(404).send({ error: 'Entity not found' });

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
    db.prepare(
      `UPDATE ${table} SET is_open = 1, opened_at = ?, opened_by = ? WHERE id = ?`
    ).run(now, openedBy || 'unknown', entityId);
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
  db.prepare(
    `UPDATE ${table} SET is_open = 0, opened_at = NULL, opened_by = NULL WHERE id = ?`
  ).run(entityId);
  return reply.send({ ok: true, locked: false });
}

// ── Hard delete tenant ───────────────────────────────────────

const TenantDeleteSchema = z.object({
  slug: z.string().min(1),
});

export async function tenantDeleteHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = TenantDeleteSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const t = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.slug) as any;
  if (!t) return reply.code(404).send({ error: 'Tenant not found' });

  const staffCount = (
    db.prepare(`SELECT COUNT(*) as c FROM staff WHERE tenant_slug = ?`).get(t.slug) as { c: number }
  ).c;
  const epCount = (
    db.prepare(`SELECT COUNT(*) as c FROM endpoints WHERE tenant_slug = ?`).get(t.slug) as { c: number }
  ).c;

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
  logSync('delete', 'tenant', t.id, 'electron', { slug: t.slug });

  return reply.send({ ok: true, deleted: true, slug: t.slug });
}

// ── Hard delete staff ────────────────────────────────────────

const StaffDeleteSchema = z.object({
  id: z.string().optional(),
  username: z.string().optional(),
  tenantSlug: z.string().optional(),
});

export async function staffDeleteHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = StaffDeleteSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  let row: any = null;
  if (parsed.data.id) {
    row = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(parsed.data.id);
  } else if (parsed.data.username) {
    row = parsed.data.tenantSlug
      ? db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ? AND tenant_slug = ?`).get(
          parsed.data.username.toLowerCase(),
          parsed.data.tenantSlug
        )
      : db.prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`).get(parsed.data.username.toLowerCase());
  }
  if (!row) return reply.code(404).send({ error: 'Staff not found' });

  db.prepare(`DELETE FROM staff WHERE id = ?`).run(row.id);
  logSync('delete', 'staff', row.id, 'electron', { username: row.username });

  return reply.send({ ok: true, deleted: true, id: row.id, username: row.username });
}

// ── Device Management Handlers ──────────────────────────────────────────

const DeviceRegisterSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
  name: z.string().default(''),
  hostname: z.string().default(''),
  osPlatform: z.string().default(''),
  osRelease: z.string().default(''),
  ramGb: z.number().default(0),
  cpuModel: z.string().default(''),
  macAddress: z.string().optional().default(''),
  ipAddress: z.string().optional().default(''),
  appVersion: z.string().optional().default('1.0.0'),
  deviceSyncSecret: z.string().optional().default(''),
});

export async function deviceRegisterHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = DeviceRegisterSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const d = parsed.data;
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(d.id) as any;

  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
  const hasSyncSecretCol = cols('devices').includes('device_sync_secret');

  if (existing) {
    const deviceSyncSecret = hasSyncSecretCol
      ? (existing.device_sync_secret || d.deviceSyncSecret || crypto.randomBytes(32).toString('hex'))
      : undefined;
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
    const setParams: any[] = [
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
    if (hasSyncSecretCol) {
      setClauses.push('device_sync_secret = COALESCE(NULLIF(device_sync_secret, \'\'), ?)');
      setParams.push(deviceSyncSecret);
    }
    db.prepare(`
      UPDATE devices
      SET ${setClauses.join(',\n          ')}
      WHERE id = ?
    `).run(...setParams, d.id);
  } else {
    const deviceSyncSecret = d.deviceSyncSecret || crypto.randomBytes(32).toString('hex');
    if (hasSyncSecretCol) {
      db.prepare(`
        INSERT INTO devices (
          id, token, name, hostname, os_platform, os_release,
          ram_gb, cpu_model, mac_address, ip_address, tenant_id,
          tenant_slug, status, app_version, device_sync_secret, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 'pending', ?, ?, datetime('now'), datetime('now'), datetime('now'))
      `).run(
        d.id,
        d.token,
        d.name || d.hostname || 'Client Server',
        d.hostname,
        d.osPlatform,
        d.osRelease,
        d.ramGb,
        d.cpuModel,
        d.macAddress,
        d.ipAddress,
        d.appVersion,
        deviceSyncSecret
      );
    } else {
      db.prepare(`
        INSERT INTO devices (
          id, token, name, hostname, os_platform, os_release,
          ram_gb, cpu_model, mac_address, ip_address, tenant_id,
          tenant_slug, status, app_version, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 'pending', ?, datetime('now'), datetime('now'), datetime('now'))
      `).run(
        d.id,
        d.token,
        d.name || d.hostname || 'Client Server',
        d.hostname,
        d.osPlatform,
        d.osRelease,
        d.ramGb,
        d.cpuModel,
        d.macAddress,
        d.ipAddress,
        d.appVersion
      );
    }
    logSync('create', 'device', d.id, 'electron', { hostname: d.hostname, name: d.name });
  }

  const updated = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(d.id) as any;
  let companyName = '';
  if (updated.tenant_slug) {
    const t = db.prepare(`SELECT name FROM tenants WHERE slug = ?`).get(updated.tenant_slug) as any;
    if (t) companyName = t.name;
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

export async function deviceStatusHandler(req: FastifyRequest, reply: FastifyReply) {
  const query = req.query as { deviceId?: string; token?: string };
  if (!query.deviceId) return reply.code(400).send({ error: 'deviceId query param is required' });

  const db = getDb();
  const row = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(query.deviceId) as any;
  if (!row) {
    return reply.code(404).send({ error: 'Device not found', status: 'not_found' });
  }

  // Auth: device signature OR device token (Electron pending poll — no ADMIN_SYNC_SECRET)
  const deviceSyncSecretHeader = (req.headers['x-device-sync-signature'] as string | undefined) || '';
  const deviceIdHeader = (req.headers['x-device-id'] as string | undefined) || '';
  let authed = false;

  if (deviceSyncSecretHeader && deviceIdHeader && row.device_sync_secret) {
    const payload = JSON.stringify({ deviceId: deviceIdHeader });
    const expected = crypto
      .createHmac('sha256', row.device_sync_secret)
      .update(payload)
      .digest('hex');
    const sigBuf = Buffer.from(deviceSyncSecretHeader);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
      authed = true;
    } else {
      return reply.code(403).send({ error: 'Invalid device sync signature', status: 'rejected' });
    }
  } else if (query.token && row.token && query.token === row.token) {
    authed = true;
  }

  if (!authed) {
    return reply.code(401).send({
      error: 'Unauthorized — provide device token or X-Device-Sync-Signature',
      status: 'unauthorized',
    });
  }

  db.prepare(`UPDATE devices SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(query.deviceId);

  const assignments = db.prepare(`
    SELECT da.tenant_slug, t.name as tenant_name
    FROM device_assignments da
    LEFT JOIN tenants t ON da.tenant_slug = t.slug
    WHERE da.device_id = ?
  `).all(query.deviceId) as any[];

  const companySlugs = assignments.map((a) => a.tenant_slug);
  const companyNames = assignments.map((a) => a.tenant_name);

  let companyName = '';
  if (row.tenant_slug) {
    const t = db.prepare(`SELECT name FROM tenants WHERE slug = ?`).get(row.tenant_slug) as any;
    if (t) companyName = t.name;
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

export async function listDevicesHandler(_req: FastifyRequest, reply: FastifyReply) {
  const db = getDb();
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
  `).all() as any[];

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

export async function approveDeviceHandler(req: FastifyRequest, reply: FastifyReply) {
  const params = req.params as { id: string };
  const body = req.body as { tenantSlugs?: string[]; tenantSlug?: string; name?: string };

  if (!params.id) {
    return reply.code(400).send({ error: 'Device id is required' });
  }

  const tenantSlugs: string[] = Array.isArray(body.tenantSlugs)
    ? body.tenantSlugs.filter(Boolean)
    : body.tenantSlug
      ? [body.tenantSlug]
      : [];

  if (tenantSlugs.length === 0) {
    return reply.code(400).send({ error: 'At least one tenantSlug is required' });
  }

  const db = getDb();
  const placeholders = tenantSlugs.map(() => '?').join(',');
  const tenants = db.prepare(`SELECT * FROM tenants WHERE slug IN (${placeholders})`).all(...tenantSlugs) as any[];
  if (tenants.length === 0) {
    return reply.code(404).send({ error: 'Company (tenant) not found' });
  }

  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id) as any;
  if (!device) return reply.code(404).send({ error: 'Device not found' });

  const primaryTenant = tenants[0];

  db.prepare(`DELETE FROM device_assignments WHERE device_id = ?`).run(params.id);

  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
  const hasSyncSecretCol = cols('devices').includes('device_sync_secret');
  const deviceSyncSecret = hasSyncSecretCol
    ? (device.device_sync_secret || crypto.randomBytes(32).toString('hex'))
    : undefined;

  const setClauses = [
    'tenant_id = ?',
    'tenant_slug = ?',
    'status = \'approved\'',
    'name = COALESCE(NULLIF(?, \'\'), name)',
    'updated_at = datetime(\'now\')',
  ];
  const setParams: any[] = [primaryTenant.id, primaryTenant.slug, body.name || ''];

  if (hasSyncSecretCol) {
    setClauses.push('device_sync_secret = ?');
    setParams.push(deviceSyncSecret);
  }

  db.prepare(`
    UPDATE devices
    SET ${setClauses.join(',\n        ')}
    WHERE id = ?
  `).run(...setParams, params.id);

  const now = new Date().toISOString();
  const insertAssignment = db.prepare(`
    INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
    VALUES (?, ?, ?, NULL, '', ?, ?)
  `);

  for (const tenant of tenants) {
    const assignmentId = randomId();
    insertAssignment.run(assignmentId, params.id, tenant.slug, now, now);
  }

  logSync('approve', 'device', params.id, 'bi_admin', { tenantSlugs: tenants.map((t) => t.slug) });

  const updated = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id) as any;

  // ⚡ Real-time push to the Electron device — it will automatically detect it was approved
  deviceEventManager.broadcast(params.id, {
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

export async function updateDeviceStatusHandler(req: FastifyRequest, reply: FastifyReply) {
  const params = req.params as { id: string };
  const body = req.body as {
    status: 'pending' | 'approved' | 'blocked';
    tenantSlug?: string;
    tenantSlugs?: string[];
    name?: string;
  };

  const db = getDb();
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id) as any;
  if (!device) return reply.code(404).send({ error: 'Device not found' });

  if (body.status === 'approved' && !body.tenantSlug && !body.tenantSlugs?.length && !device.tenant_slug) {
    return reply.code(400).send({ error: 'tenantSlug is required to approve a device' });
  }

  const tenantSlugs: string[] = Array.isArray(body.tenantSlugs)
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
    const tenants = db.prepare(`SELECT * FROM tenants WHERE slug IN (${placeholders})`).all(...tenantSlugs) as any[];
    if (tenants.length > 0) {
      tenantId = tenants[0].id;
      tenantSlug = tenants[0].slug;
    }
  }

  if (body.status === 'approved' && tenantSlugs.length > 0) {
    const existingSlugs = db.prepare(`SELECT tenant_slug FROM device_assignments WHERE device_id = ?`).all(params.id) as any[];
    const existingSet = new Set(existingSlugs.map((r) => r.tenant_slug));
    const newSlugs = tenantSlugs.filter((s) => !existingSet.has(s));
    if (newSlugs.length > 0) {
      const now = new Date().toISOString();
      const insertAssignment = db.prepare(`
        INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
        VALUES (?, ?, ?, NULL, '', ?, ?)
      `);
      for (const slug of newSlugs) {
        insertAssignment.run(randomId(), params.id, slug, now, now);
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

  logSync('update', 'device', params.id, 'bi_admin', { status: body.status, tenantSlugs });

  // ⚡ Real-time push — Electron immediately switches to blocked/pending state
  if (body.status === 'blocked') {
    deviceEventManager.broadcast(params.id, {
      type: 'DEVICE_BLOCKED',
      deviceId: params.id,
      status: 'blocked',
    });
  } else if (body.status === 'approved') {
    deviceEventManager.broadcast(params.id, {
      type: 'DEVICE_APPROVED',
      deviceId: params.id,
      status: 'approved',
      companySlugs: tenantSlugs,
    });
  } else if (body.status === 'pending') {
    deviceEventManager.broadcast(params.id, {
      type: 'DEVICE_UPDATED',
      deviceId: params.id,
      status: 'pending',
    });
  }

  return reply.send({ ok: true, status: body.status, tenantSlugs });
}

export async function deleteDeviceHandler(req: FastifyRequest, reply: FastifyReply) {
  const params = req.params as { id: string };
  const db = getDb();
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(params.id) as any;
  if (!device) return reply.code(404).send({ error: 'Device not found' });

  // ⚡ Real-time push to the Electron device — it sees the device was deleted
  deviceEventManager.broadcast(params.id, {
    type: 'DEVICE_DELETED',
    deviceId: params.id,
    status: 'deleted',
  });

  db.prepare(`DELETE FROM devices WHERE id = ?`).run(params.id);
  logSync('delete', 'device', params.id, 'bi_admin', { hostname: device.hostname });

  return reply.send({ ok: true, deleted: true, id: params.id });
}


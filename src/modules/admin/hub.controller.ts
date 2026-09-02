import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getDb, logSync } from '../../store/sqliteDb';
import { tenantRepository } from '../tenant/tenant.repository';
import { encryptPasswordPlain, decryptPasswordPlain } from '../../core/db/passwordEnc';
import { decryptConnString } from '../../core/db/crypto';
import { parseConnectionString } from '../../core/db/connectionPoolManager';
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


/** Update devices.last_seen_at when Electron identifies itself */
function touchDeviceLastSeen(req: FastifyRequest) {
  try {
    const h = req.headers as Record<string, string | string[] | undefined>;
    const id =
      (typeof h['x-device-id'] === 'string' && h['x-device-id']) ||
      (typeof h['x-deviceid'] === 'string' && h['x-deviceid']) ||
      '';
    if (!id) return;
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
  } catch (e) {
    console.warn('[touchDeviceLastSeen]', e);
  }
}

export async function catalogHandler(req: FastifyRequest, reply: FastifyReply) {
  touchDeviceLastSeen(req);
  const db = getDb();

  // Return all tenants (active + passive) so admin UIs can show / reactivate them
  const tenantRows = db.prepare(`SELECT * FROM tenants`).all() as any[];
  const connStmt = db.prepare(
    `SELECT * FROM tenant_connections WHERE tenant_id = ?`
  );
  const staffCountStmt = db.prepare(
    `SELECT COUNT(*) as c FROM staff WHERE tenant_slug = ? AND active = 1`
  );
  const epCountStmt = db.prepare(
    `SELECT COUNT(*) as c FROM endpoints WHERE tenant_slug = ?`
  );
  const deviceCountStmt = db.prepare(
    `SELECT COUNT(*) as c FROM devices WHERE tenant_slug = ? OR id IN (SELECT device_id FROM device_assignments WHERE tenant_slug = ?)`
  );

  const tenants = tenantRows.map((t) => {
    const rawConns = connStmt.all(t.id) as any[];
    const connections = rawConns.map((c) => {
      let host = c.host || '';
      let port = c.port ?? 1433;
      let username = c.username || '';
      let database = c.database_name || '';
      let password = '';
      let encrypt = c.encrypt === undefined ? true : Boolean(c.encrypt);
      let trustServerCertificate =
        c.trust_server_certificate === undefined ? true : Boolean(c.trust_server_certificate);
      // Decrypt stored connection string so BI edit form gets Host/User/Password
      if (c.db_conn_enc && c.db_conn_iv) {
        try {
          const plain = decryptConnString(c.db_conn_enc, c.db_conn_iv);
          const parsed = parseConnectionString(plain);
          if (!host) host = parsed.server || '';
          if (!port) port = parsed.port || 1433;
          if (!username) username = parsed.user || '';
          if (!database) database = parsed.database || '';
          if (parsed.password) password = parsed.password;
          encrypt = parsed.encrypt;
          trustServerCertificate = parsed.trustServerCertificate;
        } catch (e) {
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
    let billing: any = null;
    try {
      const w = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(t.id) as any;
      const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(t.id) as any;
      let tariff: any = null;
      if (sub?.tariff_id) {
        tariff = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(sub.tariff_id) as any;
      }
      if (w) {
        const bal = Number(w.balance_credits) || 0;
        const thr = Number(w.low_balance_threshold) || 50;
        let level: string = 'ok';
        if (bal <= 0) level = 'empty';
        else if (bal <= thr * 0.25) level = 'critical';
        else if (bal <= thr) level = 'low';
        billing = {
          balanceCredits: bal,
          lowBalanceThreshold: thr,
          level,
          warning:
            level === 'empty'
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
    } catch {
      /* billing tables may not exist yet */
    }
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      isActive: Boolean(t.is_active),
      connections,
      connectionCount: connections.length,
      staffCount: (staffCountStmt.get(t.slug) as { c: number })?.c ?? 0,
      endpointCount: (epCountStmt.get(t.slug) as { c: number })?.c ?? 0,
      deviceCount: (deviceCountStmt.get(t.slug, t.slug) as { c: number })?.c ?? 0,
      billing,
      updatedAt: t.updated_at,
      createdAt: t.created_at,
    };
  });

  const endpointRows = db.prepare(`SELECT * FROM endpoints`).all() as any[];
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

  const staffRows = db.prepare(`SELECT * FROM staff`).all() as any[];
  const staff = staffRows.map((s) => {
    let password = '';
    try {
      if (s.password_enc) password = decryptPasswordPlain(s.password_enc) || '';
    } catch {
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

  // Device settings (Firma Sazlamalary)
  let deviceSettings: any[] = [];
  try {
    const dsRows = db.prepare(`SELECT * FROM device_settings`).all() as any[];
    deviceSettings = dsRows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      tenantSlug: r.tenant_slug || '',
      settings: JSON.parse(r.settings_json || '{}'),
      updatedAt: r.updated_at,
      updatedBy: r.updated_by || '',
    }));
  } catch {
    /* table may not exist yet before migration */
  }

  return reply.send({
    tenants,
    endpoints,
    staff,
    devices,
    deviceSettings,
    syncedAt: new Date().toISOString(),
  });
}

// ── Tenant (Company) CRUD ─────────────────────────────────────

const CreateTenantSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
});

/** Electron device creates tenant → auto-assign that device (no BI step required) */
function ensureDeviceAssignment(db: any, deviceId: string | undefined, tenantSlug: string): { ok: boolean; error?: string } {
  if (!deviceId || !tenantSlug) return { ok: true };
  try {
    const device = db.prepare(`SELECT id, status FROM devices WHERE id = ?`).get(deviceId) as any;
    if (!device) return { ok: false, error: 'Device not found' };
    // 1 firm = 1 device: block if another device already has this firm
    const other = db
      .prepare(
        `SELECT device_id FROM device_assignments WHERE tenant_slug = ? AND device_id != ? LIMIT 1`
      )
      .get(tenantSlug, deviceId) as { device_id?: string } | undefined;
    if (other?.device_id) {
      return {
        ok: false,
        error: `Firma "${tenantSlug}" eýýäm başga enjama bagly. Bir firma diňe bir enjama baglanyp bilýär.`,
      };
    }
    const exists = db
      .prepare(`SELECT id FROM device_assignments WHERE device_id = ? AND tenant_slug = ?`)
      .get(deviceId, tenantSlug) as any;
    if (exists) return { ok: true };
    const now = new Date().toISOString();
    const { randomUUID } = require('crypto');
    db.prepare(
      `INSERT INTO device_assignments (id, device_id, tenant_slug, endpoint_id, description, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'auto-from-electron', ?, ?)`
    ).run(randomUUID(), deviceId, tenantSlug, now, now);
    db.prepare(
      `UPDATE devices SET tenant_slug = COALESCE(NULLIF(tenant_slug, ''), ?), last_seen_at = ?, updated_at = ? WHERE id = ?`
    ).run(tenantSlug, now, now, deviceId);
    return { ok: true };
  } catch (e) {
    console.warn('[ensureDeviceAssignment]', e);
    return { ok: false, error: String(e) };
  }
}


export async function createTenantHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = CreateTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const { slug, name } = parsed.data;
  const db = getDb();
  const deviceId =
    (req.headers['x-device-id'] as string | undefined) ||
    (req.body as any)?.deviceId ||
    undefined;

  const existing = db.prepare(`SELECT id FROM tenants WHERE slug = ?`).get(slug) as any;
  if (existing) {
    // Already exists — still auto-assign calling Electron device
    ensureDeviceAssignment(db, deviceId, slug);
    return reply.code(409).send({ error: `Tenant "${slug}" already exists`, tenantId: existing.id, assigned: true });
  }

  const now = new Date().toISOString();
  const id = randomId();

  db.prepare(`
    INSERT INTO tenants (id, slug, name, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(id, slug, name, now, now);

  ensureDeviceAssignment(db, deviceId, slug);

  logSync('create', 'tenant', id, deviceId ? 'api' : 'bi_admin', { slug, name, deviceId });

  return reply.send({
    ok: true,
    tenant: { id, slug, name, isActive: true, createdAt: now, updatedAt: now },
    deviceAssigned: Boolean(deviceId),
  });
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
  touchDeviceLastSeen(req);
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

    // NEVER wipe staff on empty/partial sync — only explicit staff-delete API removes rows.
    // Empty payload used to DELETE ALL staff for the tenant (data-loss bug).
    const replaceStaff = Boolean((parsed.data as any).replace === true);
    if (replaceStaff && staff.length >= 0) {
      for (const prev of existingForTenant) {
        if (!incomingUsernames.has(String(prev.username || '').toLowerCase())) {
          db.prepare(`DELETE FROM staff WHERE id = ?`).run(prev.id);
        }
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

  // Same dual-salt scrypt + bcrypt path as public /api/auth/verify
  const { verifyPasswordSync } = await import('../../core/workers/passwordWorker');
  const ok = verifyPasswordSync(password, hash);

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
  sqlQuery: z.string().optional(),
  paramsSchema: z.any().optional(),
  responseSchema: z.any().optional(),
  cacheTtlSec: z.number().optional(),
  authRequired: z.boolean().optional(),
  connectionId: z.string().optional(),
  databaseName: z.string().optional(),
});

export async function endpointUpdateHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = EndpointUpdateSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const now = new Date().toISOString();
  const ep = db.prepare(`SELECT * FROM endpoints WHERE id = ?`).get(parsed.data.id) as any;
  if (!ep) return reply.code(404).send({ error: 'Endpoint not found' });

  // Duplicate path+method under same tenant (exclude self)
  const dup = db
    .prepare(
      `SELECT id FROM endpoints WHERE tenant_slug = ? AND method = ? AND path_template = ? AND id != ?`
    )
    .get(
      parsed.data.tenantSlug,
      parsed.data.method.toUpperCase(),
      parsed.data.pathTemplate,
      ep.id
    ) as any;
  if (dup) {
    return reply.code(409).send({
      error: 'duplicate',
      message: 'Şu method + path bu firmada eýýäm bar.',
    });
  }

  const sqlQuery = parsed.data.sqlQuery !== undefined ? parsed.data.sqlQuery : ep.sql_query;
  const paramsSchema =
    parsed.data.paramsSchema !== undefined
      ? JSON.stringify(parsed.data.paramsSchema)
      : ep.params_schema;
  const responseSchema =
    parsed.data.responseSchema !== undefined
      ? JSON.stringify(parsed.data.responseSchema)
      : ep.response_schema;
  const cacheTtl =
    parsed.data.cacheTtlSec !== undefined ? parsed.data.cacheTtlSec : ep.cache_ttl_sec;
  const authReq =
    parsed.data.authRequired !== undefined
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
  `).run(
    parsed.data.name,
    parsed.data.pathTemplate,
    parsed.data.method.toUpperCase(),
    parsed.data.dbKey ?? null,
    sqlQuery,
    paramsSchema,
    responseSchema,
    cacheTtl,
    authReq,
    parsed.data.connectionId ?? null,
    parsed.data.databaseName ?? null,
    now,
    ep.id
  );

  logSync('update', 'endpoint', ep.id, 'electron', {
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
  } catch { /* */ }

  try {
    const { routeRegistry } = await import('../../core/router/routeRegistry');
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
    } as any);
    const tenantEps = await tenantRepository.listAllEndpoints();
    const filtered = tenantEps.filter((e) => e.tenantSlug === parsed.data.tenantSlug);
    routeRegistry.replaceTenantRoutes(
      parsed.data.tenantSlug,
      filtered.map((e: any) => ({
        ...e,
        pathTemplate: e.pathTemplate?.startsWith?.('/') ? e.pathTemplate : `/${e.pathTemplate || ''}`,
        dbKey: (e.dbKey || 'primary').toLowerCase(),
      })) as any
    );
  } catch (err) {
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

const EndpointCreateSchema = z.object({
  id: z.string().optional(),
  tenantSlug: z.string().min(1),
  name: z.string().min(1),
  pathTemplate: z.string().min(1),
  method: z.string().min(1),
  sqlQuery: z.string().default('SELECT 1'),
  paramsSchema: z.any().optional(),
  responseSchema: z.any().optional(),
  cacheTtlSec: z.number().optional(),
  authRequired: z.boolean().optional(),
  dbKey: z.string().optional(),
  connectionId: z.string().optional(),
  databaseName: z.string().optional(),
});

export async function endpointCreateHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = EndpointCreateSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const now = new Date().toISOString();
  const d = parsed.data;
  const method = d.method.toUpperCase();

  const tenant = db.prepare(`SELECT id, slug FROM tenants WHERE slug = ?`).get(d.tenantSlug) as any;
  if (!tenant) return reply.code(404).send({ error: 'Tenant not found', tenantSlug: d.tenantSlug });

  const dup = db
    .prepare(
      `SELECT id FROM endpoints WHERE tenant_slug = ? AND method = ? AND path_template = ?`
    )
    .get(d.tenantSlug, method, d.pathTemplate) as any;
  if (dup) {
    return reply.code(409).send({
      error: 'duplicate',
      message: 'Şu method + path bu firmada eýýäm bar.',
      id: dup.id,
    });
  }

  const id = d.id || randomId();
  if (d.id) {
    const exists = db.prepare(`SELECT id FROM endpoints WHERE id = ?`).get(d.id) as any;
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
  `).run(
    id,
    tenant.id,
    d.tenantSlug,
    d.name,
    method,
    d.pathTemplate,
    d.sqlQuery || 'SELECT 1',
    JSON.stringify(d.paramsSchema || { urlParams: [], queryParams: [], bodyParams: [] }),
    d.responseSchema ? JSON.stringify(d.responseSchema) : null,
    d.cacheTtlSec ?? 0,
    d.authRequired === false ? 0 : 1,
    d.dbKey || 'primary',
    d.connectionId || '',
    d.databaseName || '',
    now,
    now
  );

  logSync('create', 'endpoint', id, 'api', { tenantSlug: d.tenantSlug, path: d.pathTemplate });

  const pathTemplate = d.pathTemplate.startsWith('/') ? d.pathTemplate : `/${d.pathTemplate}`;
  const dbKeyNorm = (d.dbKey || 'primary').toLowerCase().replace(/[^a-z0-9-_]+/g, '-') || 'primary';
  // Fix path/dbKey in DB if needed
  try {
    db.prepare(`UPDATE endpoints SET path_template = ?, db_key = ? WHERE id = ?`).run(pathTemplate, dbKeyNorm, id);
  } catch { /* */ }

  try {
    const { routeRegistry } = await import('../../core/router/routeRegistry');
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
    } as any);
    // 2) Full tenant refresh from SQLite
    const tenantEps = await tenantRepository.listAllEndpoints();
    const filtered = tenantEps.filter((e) => e.tenantSlug === d.tenantSlug);
    routeRegistry.replaceTenantRoutes(
      d.tenantSlug,
      filtered.map((e: any) => ({
        ...e,
        pathTemplate: e.pathTemplate?.startsWith?.('/') ? e.pathTemplate : `/${e.pathTemplate || ''}`,
        dbKey: (e.dbKey || 'primary').toLowerCase(),
      })) as any
    );
  } catch (err) {
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

const EndpointDeleteSchema = z.object({
  id: z.string().optional(),
  tenantSlug: z.string().optional(),
  method: z.string().optional(),
  pathTemplate: z.string().optional(),
});

export async function endpointDeleteHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = EndpointDeleteSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  let ep: any = null;
  if (parsed.data.id) {
    ep = db.prepare(`SELECT * FROM endpoints WHERE id = ?`).get(parsed.data.id);
  } else if (parsed.data.tenantSlug && parsed.data.method && parsed.data.pathTemplate) {
    ep = db
      .prepare(
        `SELECT * FROM endpoints WHERE tenant_slug = ? AND method = ? AND path_template = ?`
      )
      .get(parsed.data.tenantSlug, parsed.data.method.toUpperCase(), parsed.data.pathTemplate);
  }
  if (!ep) return reply.code(404).send({ error: 'Endpoint not found' });

  // Block delete if assigned to a device assignment
  try {
    const asg = db
      .prepare(`SELECT COUNT(*) as c FROM device_assignments WHERE endpoint_id = ?`)
      .get(ep.id) as { c: number };
    if (asg && asg.c > 0) {
      return reply.code(409).send({
        error: 'has_dependencies',
        message: `Bu API ${asg.c} device assignment-e bagly. Ilki assignment aýyryň.`,
        assignmentCount: asg.c,
      });
    }
  } catch {
    /* table may lack rows */
  }

  db.prepare(`DELETE FROM endpoints WHERE id = ?`).run(ep.id);
  logSync('delete', 'endpoint', ep.id, 'api', {
    tenantSlug: ep.tenant_slug,
    path: ep.path_template,
  });

  try {
    const { routeRegistry } = await import('../../core/router/routeRegistry');
    const tenantEps = await tenantRepository.listAllEndpoints();
    const filtered = tenantEps.filter((e) => e.tenantSlug === ep.tenant_slug);
    routeRegistry.replaceTenantRoutes(
      ep.tenant_slug,
      filtered.map((e: any) => ({ ...e, dbKey: e.dbKey || 'primary' })) as any
    );
  } catch { /* */ }

  return reply.send({
    ok: true,
    deleted: true,
    id: ep.id,
    tenantSlug: ep.tenant_slug,
  });
}

// ── Device settings (Firma Sazlamalary) — device_app_settings columns ──

const DeviceSettingsUpsertSchema = z.object({
  deviceId: z.string().min(1),
  tenantSlug: z.string().default(''),
  settings: z.record(z.any()),
  updatedBy: z.string().optional(),
  /** Client clock ISO — LWW: reject if server row is strictly newer */
  clientUpdatedAt: z.string().optional(),
});

/** Row → API settings object (camelCase, interval in seconds) */
function rowToDeviceAppSettings(r: any): Record<string, unknown> {
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
function normalizeDeviceAppPatch(
  prev: Record<string, unknown>,
  patch: Record<string, unknown>
): {
  cols: {
    autostart: number;
    start_minimized: number;
    tray_minimize: number;
    auto_login: number;
    auto_login_username: string;
    auto_sync: number;
    sync_interval_sec: number;
    offline_queue: number;
    notify_on_sync: number;
    auto_sign_out_min: number;
    theme: string;
    language: string;
  };
  merged: Record<string, unknown>;
} {
  const m = { ...prev, ...patch };

  let sec = Number(m.syncIntervalSec ?? m.sync_interval_sec ?? 0);
  if (!sec || sec <= 0) {
    const min = Number(m.syncIntervalMin ?? m.sync_interval_min ?? 0);
    // BI historically sent "minutes"; Electron UI uses seconds (15, 30, 60, 300)
    // If value looks like minutes (1–14) convert; if already large, treat as seconds
    if (min > 0 && min <= 14) sec = Math.round(min * 60);
    else if (min > 14) sec = Math.round(min); // already seconds misnamed as Min
    else sec = 30;
  }
  // Cap: 0 = manual-only represented as 0; else min 15s max 24h
  if (sec < 0) sec = 0;
  if (sec > 0 && sec < 15) sec = 15;
  if (sec > 86400) sec = 86400;

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

export async function deviceSettingsGetHandler(req: FastifyRequest, reply: FastifyReply) {
  const q = req.query as { deviceId?: string; tenantSlug?: string };
  const db = getDb();
  let rows: any[] = [];
  try {
    // Prefer structured table
    if (q.deviceId && q.tenantSlug !== undefined) {
      rows = db
        .prepare(`SELECT * FROM device_app_settings WHERE device_id = ? AND tenant_slug = ?`)
        .all(q.deviceId, q.tenantSlug || '') as any[];
    } else if (q.deviceId) {
      rows = db.prepare(`SELECT * FROM device_app_settings WHERE device_id = ?`).all(q.deviceId) as any[];
    } else if (q.tenantSlug) {
      rows = db
        .prepare(`SELECT * FROM device_app_settings WHERE tenant_slug = ?`)
        .all(q.tenantSlug) as any[];
    } else {
      rows = db.prepare(`SELECT * FROM device_app_settings`).all() as any[];
    }
  } catch {
    rows = [];
  }

  // Fallback to legacy JSON table if structured empty
  if (rows.length === 0) {
    try {
      let legacy: any[] = [];
      if (q.deviceId && q.tenantSlug !== undefined) {
        legacy = db
          .prepare(`SELECT * FROM device_settings WHERE device_id = ? AND tenant_slug = ?`)
          .all(q.deviceId, q.tenantSlug || '') as any[];
      } else if (q.deviceId) {
        legacy = db.prepare(`SELECT * FROM device_settings WHERE device_id = ?`).all(q.deviceId) as any[];
      } else {
        legacy = [];
      }
      return reply.send({
        ok: true,
        settings: legacy.map((r) => {
          let s: Record<string, unknown> = {};
          try {
            s = JSON.parse(r.settings_json || '{}');
          } catch {
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
    } catch {
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

export async function deviceSettingsUpsertHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = DeviceSettingsUpsertSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const { deviceId, tenantSlug, settings, updatedBy, clientUpdatedAt } = parsed.data;
  const now = new Date().toISOString();
  const slug = tenantSlug || '';

  const device = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId) as any;
  if (!device) return reply.code(404).send({ error: 'Device not found' });

  let prev: Record<string, unknown> = {};
  let existingId: string | null = null;
  let existingUpdatedAt = '';
  try {
    const existing = db
      .prepare(`SELECT * FROM device_app_settings WHERE device_id = ? AND tenant_slug = ?`)
      .get(deviceId, slug) as any;
    if (existing) {
      existingId = existing.id;
      existingUpdatedAt = String(existing.updated_at || '');
      prev = rowToDeviceAppSettings(existing);
    }
  } catch {
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
    const tableCols = (
      db.prepare(`PRAGMA table_info(device_app_settings)`).all() as { name: string }[]
    ).map((c) => c.name);
    if (!tableCols.includes('auto_login_username')) {
      db.exec(`ALTER TABLE device_app_settings ADD COLUMN auto_login_username TEXT DEFAULT ''`);
    }
  } catch {
    /* */
  }

  db.prepare(
    `INSERT INTO device_app_settings (
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
      updated_by=excluded.updated_by`
  ).run(
    id,
    deviceId,
    slug,
    cols.autostart,
    cols.start_minimized,
    cols.tray_minimize,
    cols.auto_login,
    cols.auto_login_username,
    cols.auto_sync,
    cols.sync_interval_sec,
    cols.offline_queue,
    cols.notify_on_sync,
    cols.auto_sign_out_min,
    cols.theme,
    cols.language,
    now,
    updatedBy || ''
  );

  // Mirror to legacy device_settings JSON for older clients / catalog
  try {
    const leg = db
      .prepare(`SELECT id FROM device_settings WHERE device_id = ? AND tenant_slug = ?`)
      .get(deviceId, slug) as any;
    if (leg) {
      db.prepare(
        `UPDATE device_settings SET settings_json = ?, updated_at = ?, updated_by = ? WHERE id = ?`
      ).run(JSON.stringify(merged), now, updatedBy || '', leg.id);
    } else {
      db.prepare(
        `INSERT INTO device_settings (id, device_id, tenant_slug, settings_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, deviceId, slug, JSON.stringify(merged), now, updatedBy || '');
    }
  } catch {
    /* optional */
  }

  logSync('update', 'device', deviceId, 'bi_admin', {
    action: 'device_app_settings',
    tenantSlug: slug,
    keys: Object.keys(settings),
    syncIntervalSec: cols.sync_interval_sec,
  });

  try {
    deviceEventManager.broadcast(deviceId, {
      type: 'SETTINGS_UPDATED',
      deviceId,
      tenantSlug: slug,
      settings: merged,
    });
  } catch {
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
const DeviceCommandSchema = z.object({
  deviceId: z.string().min(1),
  action: z.enum(['restart', 'check_update']),
});

export async function deviceCommandHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = DeviceCommandSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const { deviceId, action } = parsed.data;
  const device = db.prepare(`SELECT id, status FROM devices WHERE id = ?`).get(deviceId) as any;
  if (!device) return reply.code(404).send({ error: 'Device not found' });

  const eventType = action === 'restart' ? 'DEVICE_RESTART' : 'DEVICE_CHECK_UPDATE';
  let delivered = false;
  try {
    delivered = deviceEventManager.broadcast(deviceId, {
      type: eventType as any,
      deviceId,
    });
  } catch (e) {
    console.warn('[deviceCommand] broadcast failed', e);
  }

  logSync('update', 'device', deviceId, 'bi_admin', { action: eventType, delivered });

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

const TestQuerySchema = z.object({
  tenantSlug: z.string().min(1),
  sqlQuery: z.string().min(1),
  dbKey: z.string().optional(),
  params: z.record(z.any()).optional(),
  timeoutMs: z.number().optional(),
});

export async function testQueryHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = TestQuerySchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const { tenantSlug, sqlQuery, dbKey, params, timeoutMs } = parsed.data;
  const { agentTunnelManager } = await import('../../core/tunnel/agentTunnelManager');

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
  const connCount = (
    db.prepare(`SELECT COUNT(*) as c FROM tenant_connections WHERE tenant_id = ?`).get(t.id) as {
      c: number;
    }
  ).c;

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
      .all(t.slug) as { device_id: string }[];
    db.prepare(`DELETE FROM device_assignments WHERE tenant_slug = ?`).run(t.slug);
    for (const row of assignedDevices) {
      const remaining = db
        .prepare(`SELECT tenant_slug FROM device_assignments WHERE device_id = ?`)
        .all(row.device_id) as { tenant_slug: string }[];
      const nextPrimary = remaining[0]?.tenant_slug || '';
      db.prepare(
        `UPDATE devices SET tenant_slug = ?, updated_at = datetime('now') WHERE id = ? AND (tenant_slug = ? OR tenant_slug = '' OR tenant_slug IS NULL)`
      ).run(nextPrimary, row.device_id, t.slug);
      // If primary was this slug, point to another assignment
      db.prepare(
        `UPDATE devices SET tenant_slug = COALESCE(NULLIF(tenant_slug, ?), ?), updated_at = datetime('now') WHERE id = ?`
      ).run(t.slug, nextPrimary, row.device_id);
      try {
        deviceEventManager.broadcast(row.device_id, {
          type: 'DEVICE_UPDATED',
          deviceId: row.device_id,
          companySlugs: remaining.map((r) => r.tenant_slug),
          removedSlug: t.slug,
        });
      } catch {
        /* */
      }
    }
  } catch (e) {
    console.warn('[tenant-delete] unassign devices', e);
  }

  db.prepare(`DELETE FROM tenant_connections WHERE tenant_id = ?`).run(t.id);
  db.prepare(`DELETE FROM tenants WHERE id = ?`).run(t.id);
  logSync('delete', 'tenant', t.id, 'electron', { slug: t.slug });

  return reply.send({ ok: true, deleted: true, slug: t.slug, unassigned: true });
}

// ── Hard delete staff ────────────────────────────────────────


// ── Single staff upsert (create/update, VPS primary) ─────────

const StaffUpsertSchema = z.object({
  id: z.string().optional(),
  tenantSlug: z.string().min(1),
  tenantSlugs: z.array(z.string()).optional(),
  fullName: z.string().min(1),
  username: z.string().min(1),
  passwordHash: z.string().optional(),
  passwordPlain: z.string().optional(),
  role: z.string().default('viewer'),
  phone: z.string().optional(),
  email: z.string().optional(),
  active: z.boolean().optional(),
});

export async function staffUpsertHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = StaffUpsertSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const d = parsed.data;
  const now = new Date().toISOString();
  const uname = d.username.toLowerCase();

  // Duplicate username check (global)
  const existingByUser = db
    .prepare(`SELECT * FROM staff WHERE LOWER(username) = ?`)
    .get(uname) as any;

  let id = d.id;
  let prev: any = null;
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
    ? encryptPasswordPlain(d.passwordPlain)
    : prev?.password_enc || '';
  let passwordHash = d.passwordHash || prev?.password_hash || '';
  if (d.passwordPlain && !passwordHash) {
    passwordHash = 'pending-reset:' + now;
  }

  const tenantSlugs = JSON.stringify(
    d.tenantSlugs?.length ? d.tenantSlugs : [d.tenantSlug]
  );
  const active = d.active === false ? 0 : 1;

  if (prev) {
    db.prepare(`
      UPDATE staff SET
        tenant_slug = ?, tenant_slugs = ?, full_name = ?, username = ?,
        password_hash = COALESCE(NULLIF(?, ''), password_hash),
        password_enc = COALESCE(NULLIF(?, ''), password_enc),
        role = ?, phone = ?, email = ?, active = ?, updated_at = ?
      WHERE id = ?
    `).run(
      d.tenantSlug,
      tenantSlugs,
      d.fullName,
      d.username,
      passwordHash,
      passwordEnc,
      d.role,
      d.phone ?? prev.phone ?? '',
      d.email ?? prev.email ?? '',
      active,
      now,
      prev.id
    );
    id = prev.id;
    logSync('update', 'staff', id ?? null, 'api', { username: d.username });
  } else {
    id = d.id || randomId();
    db.prepare(`
      INSERT INTO staff (
        id, tenant_slug, tenant_slugs, full_name, username, password_hash, password_enc,
        role, phone, email, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      d.tenantSlug,
      tenantSlugs,
      d.fullName,
      d.username,
      passwordHash || 'pending-reset:' + now,
      passwordEnc,
      d.role,
      d.phone || '',
      d.email || '',
      active,
      now,
      now
    );
    logSync('create', 'staff', id, 'api', { username: d.username });
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
    // Pending: Electron iberen secret bilen syncla (tunnel HMAC gabat gelsin).
    // Approved: bar bolan secret-i sakla (BI tassyklanandan soň üýtgemez).
    let deviceSyncSecret: string | undefined;
    if (hasSyncSecretCol) {
      if (existing.status === 'pending' && d.deviceSyncSecret) {
        deviceSyncSecret = d.deviceSyncSecret;
      } else {
        deviceSyncSecret =
          existing.device_sync_secret || d.deviceSyncSecret || crypto.randomBytes(32).toString('hex');
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
    if (hasSyncSecretCol && deviceSyncSecret) {
      setClauses.push('device_sync_secret = ?');
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

  // Auth: valid device-sig OR matching token (never fail signature before trying token —
  // Electron may send local secret that differs from DB until approved/synced)
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
    } else if (!row.token && query.deviceId) {
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
    db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(
      now,
      now,
      query.deviceId
    );
  }

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


// ── Tenant DB connections CRUD (BI + Electron sync) ───────────

function buildMssqlConnString(input: {
  host: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}): string {
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

const ConnectionUpsertSchema = z.object({
  id: z.string().optional(),
  tenantSlug: z.string().min(1),
  dbKey: z.string().min(1).optional(),
  label: z.string().optional(),
  database: z.string().optional(),
  host: z.string().min(1),
  port: z.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(), // empty = keep existing
  encrypt: z.boolean().optional(),
  trustServerCertificate: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
});

export async function connectionUpsertHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = ConnectionUpsertSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const d = parsed.data;
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(d.tenantSlug) as any;
  if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

  const now = new Date().toISOString();
  const dbKey =
    d.dbKey ||
    (d.label || d.database || 'primary')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    'primary';

  let existing: any = null;
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
      const { decryptConnString } = await import('../../core/db/crypto');
      const plain = decryptConnString(existing.db_conn_enc, existing.db_conn_iv);
      const m = plain.match(/Password=([^;]*)/i);
      password = m ? m[1] : '';
    } catch {
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

  const { encryptConnString } = await import('../../core/db/crypto');
  const { enc, iv } = encryptConnString(connStr);

  const isPrimary = d.isPrimary ? 1 : existing?.is_primary ? 1 : 0;
  if (d.isPrimary) {
    db.prepare(`UPDATE tenant_connections SET is_primary = 0 WHERE tenant_id = ?`).run(tenant.id);
  }

  let id: string | number;
  if (existing) {
    id = existing.id;
    db.prepare(
      `UPDATE tenant_connections SET
        db_key = ?, label = ?, database_name = ?,
        db_conn_enc = ?, db_conn_iv = ?,
        host = ?, port = ?, username = ?,
        encrypt = ?, trust_server_certificate = ?, is_primary = ?,
        updated_at = ?
       WHERE id = ?`
    ).run(
      dbKey,
      d.label || dbKey,
      d.database || '',
      enc,
      iv,
      d.host,
      d.port ?? 1433,
      d.username || '',
      d.encrypt !== false ? 1 : 0,
      d.trustServerCertificate !== false ? 1 : 0,
      isPrimary || (d.isPrimary === false ? 0 : existing.is_primary || 0),
      now,
      existing.id
    );
  } else {
    // Ensure primary if first connection
    const cnt = (
      db.prepare(`SELECT COUNT(*) as c FROM tenant_connections WHERE tenant_id = ?`).get(tenant.id) as {
        c: number;
      }
    ).c;
    const primaryFlag = d.isPrimary || cnt === 0 ? 1 : 0;
    const guid = randomId();
    const info = db
      .prepare(
        `INSERT INTO tenant_connections (
          tenant_id, db_key, label, database_name, db_conn_enc, db_conn_iv,
          host, port, username, encrypt, trust_server_certificate, is_primary, guid, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tenant.id,
        dbKey,
        d.label || dbKey,
        d.database || '',
        enc,
        iv,
        d.host,
        d.port ?? 1433,
        d.username || '',
        d.encrypt !== false ? 1 : 0,
        d.trustServerCertificate !== false ? 1 : 0,
        primaryFlag,
        guid,
        now
      );
    id = Number(info.lastInsertRowid);
  }

  // Mirror primary into tenants.db_conn_enc for backward compat
  if (isPrimary || d.isPrimary) {
    db.prepare(
      `UPDATE tenants SET db_conn_enc = ?, db_conn_iv = ?, updated_at = ? WHERE id = ?`
    ).run(enc, iv, now, tenant.id);
  }

  try {
    const { invalidateTenantPool } = await import('../../core/db/connectionPoolManager');
    invalidateTenantPool(d.tenantSlug);
  } catch {
    /* */
  }

  logSync('update', 'connection', String(id), 'bi_admin', { tenantSlug: d.tenantSlug, dbKey });

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

const ConnectionDeleteSchema = z.object({
  id: z.string().optional(),
  tenantSlug: z.string().min(1),
  dbKey: z.string().optional(),
});

export async function connectionDeleteHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = ConnectionDeleteSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.tenantSlug) as any;
  if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

  let row: any = null;
  if (parsed.data.id) {
    row = db.prepare(`SELECT * FROM tenant_connections WHERE id = ?`).get(parsed.data.id);
  } else if (parsed.data.dbKey) {
    row = db
      .prepare(`SELECT * FROM tenant_connections WHERE tenant_id = ? AND db_key = ?`)
      .get(tenant.id, parsed.data.dbKey);
  }
  if (!row) return reply.code(404).send({ error: 'Connection not found' });

  // Block delete if endpoints use this db_key
  const epCnt = (
    db
      .prepare(`SELECT COUNT(*) as c FROM endpoints WHERE tenant_slug = ? AND db_key = ?`)
      .get(tenant.slug, row.db_key) as { c: number }
  ).c;
  if (epCnt > 0) {
    return reply.code(409).send({
      error: 'has_dependencies',
      message: `Bu baglanyşyk ${epCnt} API tarapyndan ulanylýar. Ilki API-lary üýtgediň ýa-da aýyryň.`,
      endpointCount: epCnt,
    });
  }

  db.prepare(`DELETE FROM tenant_connections WHERE id = ?`).run(row.id);
  logSync('delete', 'connection', String(row.id), 'bi_admin', {
    tenantSlug: tenant.slug,
    dbKey: row.db_key,
  });

  try {
    const { invalidateTenantPool } = await import('../../core/db/connectionPoolManager');
    invalidateTenantPool(tenant.slug);
  } catch {
    /* */
  }

  return reply.send({ ok: true, deleted: true, id: String(row.id) });
}


// ── Staff password reset (BI forgot-password) ────────────────

const StaffPasswordResetSchema = z.object({
  id: z.string().optional(),
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  passwordPlain: z.string().optional(),
  tenantSlug: z.string().optional(),
});

export async function staffPasswordResetHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = StaffPasswordResetSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const db = getDb();
  const now = new Date().toISOString();
  let row: any = null;
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
  if (!row) return reply.code(404).send({ error: 'Staff not found' });

  let passwordEnc = row.password_enc || '';
  if (parsed.data.passwordPlain) {
    try {
      passwordEnc = encryptPasswordPlain(parsed.data.passwordPlain);
    } catch {
      /* keep old */
    }
  }

  db.prepare(
    `UPDATE staff SET password_hash = ?, password_enc = ?, updated_at = ? WHERE id = ?`
  ).run(parsed.data.passwordHash, passwordEnc, now, row.id);

  logSync('update', 'staff', row.id, 'bi_admin', {
    action: 'password_reset',
    username: row.username,
  });

  return reply.send({ ok: true, id: row.id, username: row.username });
}


/** GET /api/admin/debug-routes — list in-memory routes (+ optional tenant filter) */
export async function debugRoutesHandler(req: FastifyRequest, reply: FastifyReply) {
  const q = req.query as { tenant?: string; rebuild?: string };
  try {
    const { routeRegistry } = await import('../../core/router/routeRegistry');
    if (q.rebuild === '1') {
      const all = await tenantRepository.listAllEndpoints();
      const byTenant = new Map<string, typeof all>();
      for (const e of all) {
        const slug = e.tenantSlug;
        if (!slug) continue;
        if (!byTenant.has(slug)) byTenant.set(slug, []);
        byTenant.get(slug)!.push(e);
      }
      for (const [slug, eps] of byTenant) {
        routeRegistry.replaceTenantRoutes(
          slug,
          eps.map((e: any) => ({
            ...e,
            pathTemplate: e.pathTemplate?.startsWith?.('/') ? e.pathTemplate : `/${e.pathTemplate || ''}`,
            dbKey: (e.dbKey || 'primary').toLowerCase(),
          })) as any
        );
      }
    }
    let routes = routeRegistry.debugAll();
    if (q.tenant) {
      routes = routes.filter(
        (r) => r.tenantSlug === q.tenant || (r.key && String(r.key).startsWith(q.tenant + ':'))
      );
    }
    const db = getDb();
    const dbCount = (db.prepare(`SELECT COUNT(*) as c FROM endpoints`).get() as any)?.c ?? 0;
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
  } catch (err) {
    return reply.code(500).send({ error: String(err) });
  }
}

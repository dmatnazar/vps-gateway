import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getDb } from '../../store/db';
import { tenantRepository } from '../tenant/tenant.repository';
import { encryptPasswordPlain } from '../../core/db/passwordEnc';
import type {
  StaffRecord,
  RegistrationRecord,
  StaffRole,
  UserNotification,
} from '../../types/contracts';

// ── Catalog ──────────────────────────────────────────────────

export async function catalogHandler(_req: FastifyRequest, reply: FastifyReply) {
  const db = await getDb();
  const tenants = (db.data.tenants || [])
    .filter((t) => t.isActive)
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      isActive: t.isActive,
      connections: (t.connections || []).map((c) => ({
        dbKey: c.dbKey,
        label: c.label,
        database: c.database,
      })),
      updatedAt: t.updatedAt,
    }));

  const endpoints = (db.data.endpoints || []).map((e: any) => ({
    id: e.id,
    tenantSlug: e.tenantSlug,
    name: e.name,
    method: e.method,
    pathTemplate: e.pathTemplate,
    paramsSchema: e.paramsSchema,
    cacheTtlSec: e.cacheTtlSec,
    authRequired: e.authRequired,
    dbKey: e.dbKey,
  }));

  const staff = (db.data.staff || [])
    .filter((s) => s.active)
    .map((s) => ({
      id: s.id,
      tenantSlug: s.tenantSlug,
      tenantSlugs: s.tenantSlugs,
      fullName: s.fullName,
      username: s.username,
      role: s.role,
      phone: s.phone,
      email: s.email,
      active: s.active,
      passwordEnc: s.passwordEnc,
      updatedAt: s.updatedAt,
    }));

  return reply.send({
    tenants,
    endpoints,
    staff,
    syncedAt: new Date().toISOString(),
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
      role: z.enum(['admin', 'editor', 'viewer']),
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

  const db = await getDb();
  const now = new Date().toISOString();
  const existingForTenant = (db.data.staff || []).filter((s) => s.tenantSlug === tenantSlug);
  const others = (db.data.staff || []).filter((s) => s.tenantSlug !== tenantSlug);

  const isPlaceholder = (hash: string) =>
    !hash ||
    hash.startsWith('synced-from-bi') ||
    hash.startsWith('pending-reset') ||
    hash.endsWith(':0000');

  const byUsername = new Map(existingForTenant.map((s) => [s.username.toLowerCase(), s]));

  const incoming: StaffRecord[] = staff.map((s) => {
    const prev = byUsername.get(s.username.toLowerCase());
    let passwordHash = s.passwordHash;
    // Never wipe a real BI/Electron hash with a placeholder from local Electron mirror
    if (isPlaceholder(passwordHash) && prev && !isPlaceholder(prev.passwordHash)) {
      passwordHash = prev.passwordHash;
    }
    return {
      id: prev?.id || s.id,
      tenantSlug,
      tenantSlugs: s.tenantSlugs?.length ? s.tenantSlugs : [tenantSlug],
      fullName: s.fullName,
      username: s.username,
      passwordHash,
      role: s.role as StaffRole,
      phone: s.phone ?? prev?.phone,
      email: s.email ?? prev?.email,
      active: s.active,
      passwordEnc: (s as any).passwordPlain
        ? encryptPasswordPlain((s as any).passwordPlain)
        : (s as any).passwordEnc || prev?.passwordEnc,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
  });

  // Keep VPS-only staff (approved from BI, not yet on Electron local list) if not in incoming
  const incomingUsernames = new Set(incoming.map((s) => s.username.toLowerCase()));
  const preserved = existingForTenant.filter(
    (s) => !incomingUsernames.has(s.username.toLowerCase())
  );

  db.data.staff = [...others, ...preserved, ...incoming];
  await db.write();

  return reply.send({
    status: 'success',
    tenantSlug,
    staffLoaded: incoming.length,
    syncedAt: now,
  });
}

// ── Staff lookup (login) ─────────────────────────────────────

const AuthLookupSchema = z.object({
  username: z.string().min(1),
});

export async function staffLookupHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = AuthLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'username required' });
  }

  const db = await getDb();
  const username = parsed.data.username.toLowerCase();

  // Check pending registration first
  const pending = (db.data.registrations || []).find(
    (r) => r.username.toLowerCase() === username && r.status === 'pending'
  );
  if (pending) {
    return reply.code(403).send({
      error: 'registration_pending',
      message: 'Hasaba alyş heniz tassyklanmady. Kompaniýa administratorynyň tassyklamagyny garaşyň.',
      registrationId: pending.id,
      status: 'pending',
      deliveredAt: pending.deliveredAt || null,
    });
  }

  const rejected = (db.data.registrations || [])
    .filter((r) => r.username.toLowerCase() === username && r.status === 'rejected')
    .sort((a, b) => (b.reviewedAt || '').localeCompare(a.reviewedAt || ''))[0];
  if (rejected && !(db.data.staff || []).some((s) => s.username.toLowerCase() === username && s.active)) {
    return reply.code(403).send({
      error: 'registration_rejected',
      message: 'Hasaba alyş islegiňiz ret edildi.' + (rejected.note ? ` Sebäp: ${rejected.note}` : ''),
      registrationId: rejected.id,
      status: 'rejected',
    });
  }

  const user = (db.data.staff || []).find(
    (s) => s.username.toLowerCase() === username && s.active
  );

  if (!user) {
    return reply.code(404).send({ error: 'not found' });
  }

  const tenant = await tenantRepository.findBySlug(user.tenantSlug);

  return reply.send({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    passwordHash: user.passwordHash,
    role: user.role,
    tenantSlug: user.tenantSlug,
    tenantSlugs: user.tenantSlugs,
    tenantName: tenant?.name,
    tenantId: tenant?.id,
    phone: user.phone,
    email: user.email,
    active: user.active,
  });
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
  requestedRole: z.enum(['admin', 'editor', 'viewer']).optional(),
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

  const db = await getDb();
  const usernameTaken =
    (db.data.staff || []).some((s) => s.username.toLowerCase() === data.username.toLowerCase()) ||
    (db.data.registrations || []).some(
      (r) => r.username.toLowerCase() === data.username.toLowerCase() && r.status === 'pending'
    );
  if (usernameTaken) {
    return reply.code(409).send({ error: 'Username already taken' });
  }

  // normalize phone to +993...
  let phone = data.phone.trim();
  if (!phone.startsWith('+')) phone = '+993' + phone.replace(/^993/, '');
  if (!phone.startsWith('+993')) phone = '+993' + phone.replace(/^\+?/, '');

  const now = new Date().toISOString();
  const reg: RegistrationRecord = {
    id: crypto.randomUUID(),
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    firstName: data.firstName,
    lastName: data.lastName,
    phone,
    email: data.email,
    username: data.username,
    passwordHash: data.passwordHash,
    status: 'pending',
    requestedRole: data.requestedRole || 'viewer',
    createdAt: now,
  };

  db.data.registrations = db.data.registrations || [];
  db.data.registrations.push(reg);
  await db.write();

  return reply.send({
    ok: true,
    registrationId: reg.id,
    status: 'pending',
    deliveredAt: null,
    message: 'Registration submitted to VPS. Waiting for company Electron admin.',
  });
}

/** GET registration status by id (BI polls after submit) */
export async function getRegistrationHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const db = await getDb();
  const reg = (db.data.registrations || []).find((r) => r.id === id);
  if (!reg) return reply.code(404).send({ error: 'not found' });

  return reply.send({
    id: reg.id,
    status: reg.status,
    deliveredAt: reg.deliveredAt || null,
    tenantSlug: reg.tenantSlug,
    tenantName: reg.tenantName,
    username: reg.username,
    reviewedAt: reg.reviewedAt || null,
    note: reg.note || null,
  });
}

export async function listRegistrationsHandler(req: FastifyRequest, reply: FastifyReply) {
  const q = req.query as { tenantSlug?: string; status?: string; markDelivered?: string };
  const db = await getDb();
  let list = db.data.registrations || [];

  if (q.tenantSlug) list = list.filter((r) => r.tenantSlug === q.tenantSlug);
  if (q.status) list = list.filter((r) => r.status === q.status);

  // Electron polling → mark pending items as delivered
  const mark = q.markDelivered === '1' || q.markDelivered === 'true';
  if (mark) {
    const now = new Date().toISOString();
    let changed = false;
    for (const r of list) {
      if (r.status === 'pending' && !r.deliveredAt) {
        r.deliveredAt = now;
        changed = true;
      }
    }
    if (changed) await db.write();
  }

  const safe = list
    .map(({ passwordHash: _, ...rest }) => rest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return reply.send({ registrations: safe });
}

const UpdateRegSchema = z.object({
  id: z.string().min(1),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(5).optional(),
  email: z.string().email().optional(),
  username: z.string().min(3).optional(),
  requestedRole: z.enum(['admin', 'editor', 'viewer']).optional(),
  note: z.string().optional(),
});

/** Electron can edit pending registration before approve */
export async function updateRegistrationHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = UpdateRegSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const { id, ...patch } = parsed.data;
  const db = await getDb();
  const reg = (db.data.registrations || []).find((r) => r.id === id);
  if (!reg) return reply.code(404).send({ error: 'Registration not found' });
  if (reg.status !== 'pending') {
    return reply.code(400).send({ error: 'Only pending registrations can be edited' });
  }

  if (patch.firstName !== undefined) reg.firstName = patch.firstName;
  if (patch.lastName !== undefined) reg.lastName = patch.lastName;
  if (patch.phone !== undefined) reg.phone = patch.phone;
  if (patch.email !== undefined) reg.email = patch.email;
  if (patch.username !== undefined) reg.username = patch.username;
  if (patch.requestedRole !== undefined) reg.requestedRole = patch.requestedRole;
  if (patch.note !== undefined) reg.note = patch.note;

  await db.write();
  const { passwordHash: _, ...safe } = reg;
  return reply.send({ ok: true, registration: safe });
}

const ResolveRegSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['approve', 'reject']),
  note: z.string().optional(),
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
  reviewedBy: z.string().optional(),
  // optional overrides when approving after edit
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
  const db = await getDb();
  const reg = (db.data.registrations || []).find((r) => r.id === id);
  if (!reg) return reply.code(404).send({ error: 'Registration not found' });
  if (reg.status !== 'pending') {
    return reply.code(400).send({ error: 'Already resolved' });
  }

  if (firstName) reg.firstName = firstName;
  if (lastName) reg.lastName = lastName;
  if (phone) reg.phone = phone;
  if (email) reg.email = email;

  const now = new Date().toISOString();
  reg.status = action === 'approve' ? 'approved' : 'rejected';
  reg.reviewedAt = now;
  reg.reviewedBy = reviewedBy;
  reg.note = note;

  if (action === 'approve') {
    const staffRole = (role || reg.requestedRole || 'viewer') as StaffRole;
    const existingIdx = (db.data.staff || []).findIndex(
      (s) => s.username.toLowerCase() === reg.username.toLowerCase()
    );
    const staff: StaffRecord = {
      id: existingIdx >= 0 ? db.data.staff[existingIdx].id : crypto.randomUUID(),
      tenantSlug: reg.tenantSlug,
      tenantSlugs: [reg.tenantSlug],
      fullName: `${reg.firstName} ${reg.lastName}`.trim(),
      username: reg.username,
      passwordHash: reg.passwordHash,
      role: staffRole,
      phone: reg.phone,
      email: reg.email,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    if (existingIdx >= 0) db.data.staff[existingIdx] = staff;
    else {
      db.data.staff = db.data.staff || [];
      db.data.staff.push(staff);
    }
  }

  // notification for the user
  const notif: UserNotification = {
    id: crypto.randomUUID(),
    username: reg.username,
    type: action === 'approve' ? 'registration_approved' : 'registration_rejected',
    title: action === 'approve' ? 'Hasaba alyş tassyklanyldy' : 'Hasaba alyş ret edildi',
    message:
      action === 'approve'
        ? `${reg.tenantName} kompaniýasynda hasabyňyz açyldy. Indi girip bilersiňiz.`
        : `Hasaba alyş islegiňiz ret edildi.` + (note ? ` Sebäp: ${note}` : ''),
    read: false,
    createdAt: now,
  };
  db.data.notifications = db.data.notifications || [];
  db.data.notifications.push(notif);

  await db.write();

  // Return staff record so Electron can mirror without placeholder hash
  let staffOut = null;
  if (action === 'approve') {
    staffOut = (db.data.staff || []).find(
      (s) => s.username.toLowerCase() === reg.username.toLowerCase()
    );
  }

  return reply.send({
    ok: true,
    status: reg.status,
    staff: staffOut
      ? {
          id: staffOut.id,
          username: staffOut.username,
          fullName: staffOut.fullName,
          passwordHash: staffOut.passwordHash,
          role: staffOut.role,
          phone: staffOut.phone,
          email: staffOut.email,
          tenantSlug: staffOut.tenantSlug,
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
  const db = await getDb();
  let list = (db.data.notifications || []).filter(
    (n) => n.username.toLowerCase() === q.username!.toLowerCase()
  );
  if (q.unreadOnly === '1') list = list.filter((n) => !n.read);
  list = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return reply.send({ notifications: list });
}

const MarkReadSchema = z.object({
  ids: z.array(z.string()).optional(),
  username: z.string().optional(),
});

export async function markNotificationsReadHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = MarkReadSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'bad body' });
  const db = await getDb();
  const { ids, username } = parsed.data;
  for (const n of db.data.notifications || []) {
    if (ids?.includes(n.id) || (username && n.username.toLowerCase() === username.toLowerCase())) {
      n.read = true;
    }
  }
  await db.write();
  return reply.send({ ok: true });
}


const TenantUpdateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export async function tenantUpdateHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = TenantUpdateSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const db = await getDb();
  const t = (db.data.tenants || []).find((x) => x.slug === parsed.data.slug);
  if (!t) return reply.code(404).send({ error: 'Tenant not found' });
  if (parsed.data.name !== undefined) t.name = parsed.data.name;
  if (parsed.data.isActive !== undefined) t.isActive = parsed.data.isActive;
  t.updatedAt = new Date().toISOString();
  await db.write();
  return reply.send({ ok: true, tenant: { id: t.id, slug: t.slug, name: t.name, isActive: t.isActive } });
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
  const db = await getDb();
  const ep = (db.data.endpoints || []).find((e: any) => e.id === parsed.data.id);
  if (!ep) return reply.code(404).send({ error: 'Endpoint not found' });
  ep.name = parsed.data.name;
  ep.pathTemplate = parsed.data.pathTemplate;
  ep.method = parsed.data.method.toUpperCase();
  if (parsed.data.dbKey) (ep as any).dbKey = parsed.data.dbKey;
  (ep as any).updatedAt = new Date().toISOString();
  await db.write();
  try {
    const { routeRegistry } = await import('../../core/router/routeRegistry');
    const tenantEps = (db.data.endpoints || []).filter((e: any) => e.tenantSlug === parsed.data.tenantSlug);
    routeRegistry.replaceTenantRoutes(
      parsed.data.tenantSlug,
      tenantEps.map((e: any) => ({ ...e, dbKey: e.dbKey || 'primary' })) as any
    );
  } catch { /* */ }
  return reply.send({ ok: true, endpoint: { id: ep.id, name: ep.name, pathTemplate: ep.pathTemplate, method: ep.method } });
}

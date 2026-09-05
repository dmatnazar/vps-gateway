"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.billingOverviewHandler = billingOverviewHandler;
exports.listTariffsHandler = listTariffsHandler;
exports.tariffUpsertHandler = tariffUpsertHandler;
exports.assignTariffHandler = assignTariffHandler;
exports.topUpHandler = topUpHandler;
exports.adjustBalanceHandler = adjustBalanceHandler;
exports.ledgerHandler = ledgerHandler;
exports.walletGetHandler = walletGetHandler;
exports.mapWallet = mapWallet;
exports.ensureWallet = ensureWallet;
exports.mapTariff = mapTariff;
exports.applyLedger = applyLedger;
exports.maybeRenewSubscriptionPeriod = maybeRenewSubscriptionPeriod;
exports.consumeApiCredit = consumeApiCredit;
exports.requestTariffChangeHandler = requestTariffChangeHandler;
exports.listTariffRequestsHandler = listTariffRequestsHandler;
exports.resolveTariffRequestHandler = resolveTariffRequestHandler;
exports.consumeApiHttpHandler = consumeApiHttpHandler;
exports.deleteLedgerHandler = deleteLedgerHandler;
exports.deleteLedgerBulkHandler = deleteLedgerBulkHandler;
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const sqliteDb_1 = require("../../store/sqliteDb");
const randomId = () => typeof node_crypto_1.default.randomUUID === 'function'
    ? node_crypto_1.default.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
function mapTariff(r) {
    return {
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description || '',
        priceMonthly: Number(r.price_monthly) || 0,
        currency: r.currency || 'TMT',
        includedCredits: Number(r.included_credits) || 0,
        maxStaff: Number(r.max_staff) || 0,
        maxApiCallsDay: Number(r.max_api_calls_day) || 0,
        maxConnections: Number(r.max_connections) || 0,
        features: (() => {
            try {
                return JSON.parse(r.features_json || '{}');
            }
            catch {
                return {};
            }
        })(),
        sortOrder: Number(r.sort_order) || 0,
        isActive: Boolean(r.is_active),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function ensureWallet(db, tenantId, tenantSlug, initial = 0) {
    const existing = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(tenantId);
    if (existing)
        return existing;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tenant_wallets (tenant_id, tenant_slug, balance_credits, low_balance_threshold, updated_at)
     VALUES (?, ?, ?, 50, ?)`).run(tenantId, tenantSlug, initial, now);
    return db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(tenantId);
}
function mapWallet(w, tariff, sub) {
    const balance = Number(w?.balance_credits) || 0;
    const threshold = Number(w?.low_balance_threshold) || 50;
    let level = 'ok';
    if (balance <= 0)
        level = 'empty';
    else if (balance <= threshold * 0.25)
        level = 'critical';
    else if (balance <= threshold)
        level = 'low';
    return {
        tenantId: w?.tenant_id,
        tenantSlug: w?.tenant_slug,
        balanceCredits: balance,
        lowBalanceThreshold: threshold,
        level,
        warning: level === 'empty'
            ? 'Balans gutardy — täze kredit goşuň'
            : level === 'critical'
                ? 'Balans critiki derejede pes'
                : level === 'low'
                    ? 'Balans pes — top-up maslahat berilýär'
                    : null,
        updatedAt: w?.updated_at,
        tariff: tariff ? mapTariff(tariff) : null,
        subscription: sub
            ? {
                tariffId: sub.tariff_id,
                status: sub.status,
                periodStart: sub.period_start,
                periodEnd: sub.period_end,
                autoRenew: Boolean(sub.auto_renew),
            }
            : null,
    };
}
function ensureTariffRequestTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS tariff_change_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      tenant_slug TEXT NOT NULL,
      requested_by TEXT DEFAULT '',
      current_tariff_id TEXT,
      requested_tariff_id TEXT NOT NULL,
      message TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tcr_status ON tariff_change_requests(status, created_at DESC);
  `);
}
/** GET /api/admin/billing/overview — tariffs + all tenant wallets */
async function billingOverviewHandler(_req, reply) {
    const db = (0, sqliteDb_1.getDb)();
    ensureTariffRequestTable(db);
    const tariffs = db.prepare(`SELECT * FROM tariffs ORDER BY sort_order, name`).all().map(mapTariff);
    const tenants = db.prepare(`SELECT id, slug, name, is_active FROM tenants ORDER BY name`).all();
    const wallets = [];
    for (const t of tenants) {
        let w = ensureWallet(db, t.id, t.slug, 0);
        const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(t.id);
        let tariff = null;
        if (sub?.tariff_id) {
            tariff = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(sub.tariff_id);
        }
        wallets.push({
            ...mapWallet(w, tariff, sub),
            tenantName: t.name,
            tenantActive: Boolean(t.is_active),
        });
    }
    return reply.send({
        tariffs,
        wallets,
        syncedAt: new Date().toISOString(),
    });
}
/** GET /api/admin/billing/tariffs */
async function listTariffsHandler(_req, reply) {
    const db = (0, sqliteDb_1.getDb)();
    const rows = db.prepare(`SELECT * FROM tariffs ORDER BY sort_order, name`).all();
    return reply.send({ tariffs: rows.map(mapTariff) });
}
const TariffUpsertSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    code: zod_1.z.string().min(1).max(40),
    name: zod_1.z.string().min(1).max(80),
    description: zod_1.z.string().optional(),
    priceMonthly: zod_1.z.number().min(0).default(0),
    currency: zod_1.z.string().default('TMT'),
    includedCredits: zod_1.z.number().int().min(0).default(0),
    maxStaff: zod_1.z.number().int().min(0).default(5),
    maxApiCallsDay: zod_1.z.number().int().min(0).default(100),
    maxConnections: zod_1.z.number().int().min(0).default(2),
    features: zod_1.z.record(zod_1.z.any()).optional(),
    sortOrder: zod_1.z.number().int().optional(),
    isActive: zod_1.z.boolean().optional(),
});
/** POST /api/admin/billing/tariff-upsert */
async function tariffUpsertHandler(req, reply) {
    const parsed = TariffUpsertSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const d = parsed.data;
    const now = new Date().toISOString();
    const code = d.code.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    let id = d.id;
    const byCode = db.prepare(`SELECT * FROM tariffs WHERE code = ?`).get(code);
    if (!id && byCode)
        id = byCode.id;
    if (!id)
        id = `tariff_${code}`;
    const existing = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(id);
    const featuresJson = JSON.stringify(d.features || existing?.features_json ? JSON.parse(existing?.features_json || '{}') : {});
    if (existing) {
        db.prepare(`UPDATE tariffs SET
        code=?, name=?, description=?, price_monthly=?, currency=?,
        included_credits=?, max_staff=?, max_api_calls_day=?, max_connections=?,
        features_json=?, sort_order=?, is_active=?, updated_at=?
       WHERE id=?`).run(code, d.name, d.description ?? existing.description ?? '', d.priceMonthly, d.currency || 'TMT', d.includedCredits, d.maxStaff, d.maxApiCallsDay, d.maxConnections, JSON.stringify(d.features ?? JSON.parse(existing.features_json || '{}')), d.sortOrder ?? existing.sort_order ?? 0, d.isActive === false ? 0 : 1, now, id);
    }
    else {
        db.prepare(`INSERT INTO tariffs (
        id, code, name, description, price_monthly, currency,
        included_credits, max_staff, max_api_calls_day, max_connections,
        features_json, sort_order, is_active, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, code, d.name, d.description || '', d.priceMonthly, d.currency || 'TMT', d.includedCredits, d.maxStaff, d.maxApiCallsDay, d.maxConnections, JSON.stringify(d.features || {}), d.sortOrder ?? 99, now, now);
    }
    (0, sqliteDb_1.logSync)(existing ? 'update' : 'create', 'tariff', id, 'bi_admin', { code, name: d.name });
    const row = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(id);
    return reply.send({ ok: true, tariff: mapTariff(row) });
}
const ActorFields = {
    createdBy: zod_1.z.string().optional(),
    username: zod_1.z.string().optional(),
    actor: zod_1.z.string().optional(),
    deviceName: zod_1.z.string().optional(),
    source: zod_1.z.string().optional(),
};
function resolveActor(body) {
    const createdBy = (body.createdBy && body.createdBy.trim()) ||
        (body.actor && body.actor.trim()) ||
        (body.username && body.username.trim()) ||
        'bi_admin';
    const deviceName = (body.deviceName && body.deviceName.trim()) ||
        (body.source === 'web' ? 'Web admin' : '') ||
        '';
    return { createdBy, deviceName };
}
const AssignSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    tariffId: zod_1.z.string().min(1),
    grantIncludedCredits: zod_1.z.boolean().optional(),
    ...ActorFields,
});
/** POST /api/admin/billing/assign-tariff */
async function assignTariffHandler(req, reply) {
    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Firma tapylmady' });
    const tariff = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(parsed.data.tariffId);
    if (!tariff || !tariff.is_active)
        return reply.code(404).send({ error: 'Tarif tapylmady ýa-da passiw' });
    const now = new Date().toISOString();
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const actor = resolveActor(parsed.data);
    db.prepare(`INSERT INTO tenant_subscriptions (tenant_id, tenant_slug, tariff_id, status, period_start, period_end, auto_renew, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, 1, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       tariff_id=excluded.tariff_id, status='active',
       period_start=excluded.period_start, period_end=excluded.period_end, updated_at=excluded.updated_at`).run(tenant.id, tenant.slug, tariff.id, now, periodEnd, now);
    ensureWallet(db, tenant.id, tenant.slug, 0);
    let granted = 0;
    if (parsed.data.grantIncludedCredits !== false && tariff.included_credits > 0) {
        granted = await applyLedger(db, {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            type: 'grant',
            amount: Number(tariff.included_credits),
            reason: `Tarif «${tariff.name}» — aýlyk kredit`,
            createdBy: actor.createdBy,
            deviceName: actor.deviceName,
        });
    }
    (0, sqliteDb_1.logSync)('update', 'subscription', tenant.id, 'bi_admin', {
        tariffId: tariff.id,
        code: tariff.code,
        granted,
        by: actor.createdBy,
    });
    const w = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(tenant.id);
    const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(tenant.id);
    return reply.send({
        ok: true,
        granted,
        wallet: mapWallet(w, tariff, sub),
    });
}
const TopUpSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    amount: zod_1.z.number().positive(),
    reason: zod_1.z.string().optional(),
    ...ActorFields,
});
/** POST /api/admin/billing/topup */
async function topUpHandler(req, reply) {
    const parsed = TopUpSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Firma tapylmady' });
    const actor = resolveActor(parsed.data);
    ensureWallet(db, tenant.id, tenant.slug, 0);
    const balanceAfter = await applyLedger(db, {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        type: 'topup',
        amount: parsed.data.amount,
        reason: parsed.data.reason || 'Admin top-up',
        createdBy: actor.createdBy,
        deviceName: actor.deviceName,
    });
    (0, sqliteDb_1.logSync)('update', 'wallet', tenant.id, 'bi_admin', {
        amount: parsed.data.amount,
        balanceAfter,
        by: actor.createdBy,
    });
    const w = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(tenant.id);
    const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(tenant.id);
    const tariff = sub
        ? db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(sub.tariff_id)
        : null;
    return reply.send({
        ok: true,
        balanceAfter,
        wallet: mapWallet(w, tariff, sub),
    });
}
const AdjustSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    amount: zod_1.z.number(), // can be negative
    reason: zod_1.z.string().min(1),
    ...ActorFields,
});
/** POST /api/admin/billing/adjust — manual +/- with reason */
async function adjustBalanceHandler(req, reply) {
    const parsed = AdjustSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Firma tapylmady' });
    const actor = resolveActor(parsed.data);
    ensureWallet(db, tenant.id, tenant.slug, 0);
    const type = parsed.data.amount >= 0 ? 'grant' : 'adjust';
    const balanceAfter = await applyLedger(db, {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        type,
        amount: parsed.data.amount,
        reason: parsed.data.reason,
        createdBy: actor.createdBy,
        deviceName: actor.deviceName,
    });
    const w = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(tenant.id);
    return reply.send({ ok: true, balanceAfter, wallet: mapWallet(w) });
}
/** GET /api/admin/billing/ledger?tenantSlug=&limit=&offset= */
async function ledgerHandler(req, reply) {
    const q = req.query;
    const db = (0, sqliteDb_1.getDb)();
    // Allow large admin history views (BI "Ähli hereketler" + page-size control)
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 5000);
    const offset = Math.max(Number(q.offset) || 0, 0);
    let rows;
    let total = 0;
    if (q.tenantSlug) {
        total = db.prepare(`SELECT COUNT(*) as c FROM wallet_ledger WHERE tenant_slug = ?`).get(q.tenantSlug)?.c || 0;
        rows = db
            .prepare(`SELECT * FROM wallet_ledger WHERE tenant_slug = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
            .all(q.tenantSlug, limit, offset);
    }
    else {
        total = db.prepare(`SELECT COUNT(*) as c FROM wallet_ledger`).get()?.c || 0;
        rows = db
            .prepare(`SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT ? OFFSET ?`)
            .all(limit, offset);
    }
    // Resolve staff_id → human name when created_by looks like an id
    const staffNameById = new Map();
    try {
        const staffRows = db
            .prepare(`SELECT id, username, full_name FROM staff`)
            .all();
        for (const s of staffRows) {
            const label = (s.full_name && s.full_name.trim()) || (s.username && s.username.trim()) || '';
            if (s.id && label)
                staffNameById.set(s.id, label);
            if (s.username && label)
                staffNameById.set(s.username, label);
        }
    }
    catch {
        /* */
    }
    return reply.send({
        total,
        limit,
        offset,
        entries: rows.map((r) => {
            let createdBy = r.created_by || '';
            let username = createdBy;
            if (r.staff_id && staffNameById.has(r.staff_id)) {
                username = staffNameById.get(r.staff_id);
                if (!createdBy || /^[0-9a-f-]{16,}$/i.test(createdBy))
                    createdBy = username;
            }
            else if (createdBy && staffNameById.has(createdBy)) {
                username = staffNameById.get(createdBy);
                createdBy = username;
            }
            const deviceName = r.device_name || '';
            return {
                id: r.id,
                tenantId: r.tenant_id,
                tenantSlug: r.tenant_slug,
                staffId: r.staff_id,
                type: r.type,
                amount: Number(r.amount),
                balanceAfter: Number(r.balance_after),
                reason: r.reason,
                refId: r.ref_id,
                createdBy,
                username,
                user: username,
                deviceName,
                device: deviceName,
                createdAt: r.created_at,
                meta: {
                    createdBy,
                    username,
                    deviceName,
                    deviceLabel: deviceName,
                },
            };
        }),
    });
}
/** GET /api/admin/billing/wallet?tenantSlug= */
async function walletGetHandler(req, reply) {
    const q = req.query;
    if (!q.tenantSlug)
        return reply.code(400).send({ error: 'tenantSlug gerek' });
    const db = (0, sqliteDb_1.getDb)();
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(q.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Firma tapylmady' });
    const w = ensureWallet(db, tenant.id, tenant.slug, 0);
    const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(tenant.id);
    const tariff = sub
        ? db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(sub.tariff_id)
        : null;
    return reply.send({ wallet: mapWallet(w, tariff, sub), tenantName: tenant.name });
}
async function applyLedger(db, opts) {
    const now = new Date().toISOString();
    // Ensure device_name column exists (older DBs) so INSERT never silently skips ledger rows
    try {
        const cols = db.prepare(`PRAGMA table_info(wallet_ledger)`).all().map((c) => c.name);
        if (!cols.includes('device_name')) {
            db.exec(`ALTER TABLE wallet_ledger ADD COLUMN device_name TEXT DEFAULT ''`);
        }
    }
    catch {
        /* ignore */
    }
    const tx = db.transaction(() => {
        const w = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(opts.tenantId);
        if (!w) {
            // Wallet missing mid-tx — create then continue
            db.prepare(`INSERT OR IGNORE INTO tenant_wallets (tenant_id, tenant_slug, balance_credits, low_balance_threshold, updated_at)
         VALUES (?, ?, 0, 50, ?)`).run(opts.tenantId, opts.tenantSlug, now);
        }
        const w2 = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(opts.tenantId);
        const current = Number(w2?.balance_credits) || 0;
        const next = Math.round((current + opts.amount) * 1000) / 1000;
        db.prepare(`UPDATE tenant_wallets SET balance_credits = ?, updated_at = ?, warn_sent_at = CASE WHEN ? > low_balance_threshold THEN NULL ELSE warn_sent_at END WHERE tenant_id = ?`).run(next, now, next, opts.tenantId);
        const ledgerId = randomId();
        try {
            db.prepare(`INSERT INTO wallet_ledger (id, tenant_id, tenant_slug, staff_id, type, amount, balance_after, reason, ref_id, created_by, device_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ledgerId, opts.tenantId, opts.tenantSlug, opts.staffId || null, opts.type, opts.amount, next, opts.reason || '', opts.refId || null, opts.createdBy || '', opts.deviceName || '', now);
        }
        catch (e1) {
            // Fallback without device_name for very old schemas
            try {
                db.prepare(`INSERT INTO wallet_ledger (id, tenant_id, tenant_slug, staff_id, type, amount, balance_after, reason, ref_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ledgerId, opts.tenantId, opts.tenantSlug, opts.staffId || null, opts.type, opts.amount, next, opts.reason || '', opts.refId || null, opts.createdBy || '', now);
            }
            catch (e2) {
                // Re-throw so balance update rolls back — never credit without a ledger row
                throw e2;
            }
        }
        return next;
    });
    return tx();
}
/**
 * 1 successful API hit = −1 REQ on company (tenant) wallet.
 * Admin/super roles skip (free). Empty free plan → { ok:false, code:'NO_CREDITS', suggestUpgrade:true }.
 * When period_end passed → refill included_credits for free/paid auto_renew.
 */
async function maybeRenewSubscriptionPeriod(tenantSlug) {
    const db = (0, sqliteDb_1.getDb)();
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(tenantSlug);
    if (!tenant)
        return false;
    const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(tenant.id);
    if (!sub?.period_end)
        return false;
    if (new Date(sub.period_end).getTime() > Date.now())
        return false;
    const tariff = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(sub.tariff_id);
    if (!tariff)
        return false;
    const now = new Date().toISOString();
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    db.prepare(`UPDATE tenant_subscriptions SET period_start = ?, period_end = ?, updated_at = ? WHERE tenant_id = ?`).run(now, periodEnd, now, tenant.id);
    const grant = Number(tariff.included_credits) || 0;
    if (grant > 0) {
        // Set balance to included (monthly free refill) — user asked free REQ grows again at period end
        const w = ensureWallet(db, tenant.id, tenant.slug, 0);
        const current = Number(w?.balance_credits) || 0;
        // Free: reset to included; paid with remaining: add included (top-up style) — free tariff price=0 resets
        const isFree = Number(tariff.price_monthly) <= 0 || String(tariff.code || '').toLowerCase() === 'free';
        if (isFree) {
            db.prepare(`UPDATE tenant_wallets SET balance_credits = ?, updated_at = ? WHERE tenant_id = ?`).run(grant, now, tenant.id);
            db.prepare(`INSERT INTO wallet_ledger (id, tenant_id, tenant_slug, staff_id, type, amount, balance_after, reason, ref_id, created_by, created_at)
         VALUES (?, ?, ?, NULL, 'period_refill', ?, ?, 'Aýlyk free REQ täzelendi', NULL, 'system', ?)`).run(randomId(), tenant.id, tenant.slug, grant - current, grant, now);
        }
        else if (sub.auto_renew) {
            await applyLedger(db, {
                tenantId: tenant.id,
                tenantSlug: tenant.slug,
                type: 'period_refill',
                amount: grant,
                reason: 'Aýlyk tarif REQ goşuldy',
                createdBy: 'system',
            });
        }
    }
    return true;
}
async function consumeApiCredit(tenantSlug, opts) {
    try {
        await maybeRenewSubscriptionPeriod(tenantSlug);
    }
    catch {
        /* */
    }
    const role = (opts?.staffRole || '').toLowerCase();
    if (role === 'admin' || role === 'super_admin' || role === 'superadmin') {
        return { ok: true, balance: undefined, code: 'ADMIN_FREE' };
    }
    const db = (0, sqliteDb_1.getDb)();
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(tenantSlug);
    if (!tenant)
        return { ok: true }; // no tenant billing → allow
    const w = ensureWallet(db, tenant.id, tenant.slug, 0);
    const balance = Number(w?.balance_credits) || 0;
    const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(tenant.id);
    const tariff = sub
        ? db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(sub.tariff_id)
        : null;
    const isFree = !tariff ||
        Number(tariff.price_monthly) <= 0 ||
        String(tariff.code || '').toLowerCase() === 'free';
    if (balance <= 0) {
        return {
            ok: false,
            balance: 0,
            code: 'NO_CREDITS',
            message: isFree
                ? 'Free REQ gutardy. Tölegli tarife geçiň ýa-da period gutýança garaşyň (REQ täzelener).'
                : 'REQ balans gutardy. Top-up ýa-da tarif üýtgediň.',
            suggestUpgrade: isFree,
            periodEnd: sub?.period_end || null,
        };
    }
    // Prefer human-readable username over raw staff id
    let createdBy = (opts?.username && opts.username.trim()) || '';
    if (!createdBy && opts?.staffId) {
        try {
            const st = db.prepare(`SELECT username, full_name FROM staff WHERE id = ?`).get(opts.staffId);
            createdBy =
                (st?.full_name && st.full_name.trim()) ||
                    (st?.username && st.username.trim()) ||
                    opts.staffId;
        }
        catch {
            createdBy = opts.staffId;
        }
    }
    if (!createdBy)
        createdBy = 'api';
    const next = await applyLedger(db, {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        staffId: opts?.staffId,
        type: 'api_call',
        amount: -1,
        reason: opts?.endpointName ? `API: ${opts.endpointName}` : 'API call',
        refId: opts?.endpointId,
        createdBy,
        deviceName: opts?.deviceName || '',
    });
    return { ok: true, balance: next };
}
const RequestTariffSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    requestedTariffId: zod_1.z.string().min(1),
    message: zod_1.z.string().optional(),
    requestedBy: zod_1.z.string().optional(),
});
/** POST /api/admin/billing/request-tariff-change */
async function requestTariffChangeHandler(req, reply) {
    const parsed = RequestTariffSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    ensureTariffRequestTable(db);
    const tenant = db.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(parsed.data.tenantSlug);
    if (!tenant)
        return reply.code(404).send({ error: 'Firma tapylmady' });
    const newTariff = db.prepare(`SELECT * FROM tariffs WHERE id = ? AND is_active = 1`).get(parsed.data.requestedTariffId);
    if (!newTariff)
        return reply.code(404).send({ error: 'Tarif tapylmady' });
    const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(tenant.id);
    if (sub?.tariff_id === newTariff.id) {
        return reply.code(400).send({ error: 'Bu tarif eýýäm saýlanan' });
    }
    // Prevent duplicate pending
    const pending = db
        .prepare(`SELECT id FROM tariff_change_requests WHERE tenant_slug = ? AND status = 'pending' LIMIT 1`)
        .get(tenant.slug);
    if (pending) {
        return reply.code(409).send({
            error: 'pending_exists',
            message: 'Siziň garaşylýan tarif soragyňyz eýýäm bar',
            requestId: pending.id,
        });
    }
    const now = new Date().toISOString();
    const id = randomId();
    db.prepare(`INSERT INTO tariff_change_requests (
      id, tenant_id, tenant_slug, requested_by, current_tariff_id, requested_tariff_id, message, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, tenant.id, tenant.slug, parsed.data.requestedBy || '', sub?.tariff_id || null, newTariff.id, parsed.data.message || '', now);
    // Notify via notifications table if exists
    try {
        db.prepare(`INSERT INTO notifications (id, username, title, message, read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`).run(randomId(), 'super_admin', 'Tarif üýtgetme soragy', `${tenant.name} (${tenant.slug}): «${newTariff.name}» tarife geçmek isleýär. Balans saklanar.`, now);
    }
    catch {
        /* notifications schema may differ */
    }
    (0, sqliteDb_1.logSync)('create', 'subscription', id, 'bi', {
        tenantSlug: tenant.slug,
        requestedTariffId: newTariff.id,
    });
    return reply.send({
        ok: true,
        request: {
            id,
            status: 'pending',
            requestedTariff: mapTariff(newTariff),
            message: 'Sorag ugradyldy. Admin tassyklansoň tarif üýtgär; galan balans saklanar.',
        },
    });
}
/** GET /api/admin/billing/tariff-requests?status=pending */
async function listTariffRequestsHandler(req, reply) {
    const db = (0, sqliteDb_1.getDb)();
    ensureTariffRequestTable(db);
    const q = req.query;
    let rows;
    if (q.status) {
        rows = db
            .prepare(`SELECT * FROM tariff_change_requests WHERE status = ? ORDER BY created_at DESC LIMIT 100`)
            .all(q.status);
    }
    else {
        rows = db
            .prepare(`SELECT * FROM tariff_change_requests ORDER BY created_at DESC LIMIT 100`)
            .all();
    }
    const entries = rows.map((r) => {
        const tenant = db.prepare(`SELECT name FROM tenants WHERE id = ?`).get(r.tenant_id);
        const cur = r.current_tariff_id
            ? db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(r.current_tariff_id)
            : null;
        const reqT = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(r.requested_tariff_id);
        return {
            id: r.id,
            tenantSlug: r.tenant_slug,
            tenantName: tenant?.name,
            requestedBy: r.requested_by,
            status: r.status,
            message: r.message,
            createdAt: r.created_at,
            currentTariff: cur ? mapTariff(cur) : null,
            requestedTariff: reqT ? mapTariff(reqT) : null,
        };
    });
    return reply.send({ requests: entries });
}
const ResolveRequestSchema = zod_1.z.object({
    requestId: zod_1.z.string().min(1),
    action: zod_1.z.enum(['approve', 'reject']),
    resolvedBy: zod_1.z.string().optional(),
});
/** POST /api/admin/billing/resolve-tariff-request — approve keeps balance, switches tariff + optional grant */
async function resolveTariffRequestHandler(req, reply) {
    const parsed = ResolveRequestSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const db = (0, sqliteDb_1.getDb)();
    ensureTariffRequestTable(db);
    const row = db.prepare(`SELECT * FROM tariff_change_requests WHERE id = ?`).get(parsed.data.requestId);
    if (!row)
        return reply.code(404).send({ error: 'Sorag tapylmady' });
    if (row.status !== 'pending')
        return reply.code(400).send({ error: 'Sorag eýýäm çözülen' });
    const now = new Date().toISOString();
    if (parsed.data.action === 'reject') {
        db.prepare(`UPDATE tariff_change_requests SET status = 'rejected', resolved_at = ?, resolved_by = ? WHERE id = ?`).run(now, parsed.data.resolvedBy || 'admin', row.id);
        return reply.send({ ok: true, status: 'rejected' });
    }
    // approve: assign tariff WITHOUT wiping balance (grantIncludedCredits true adds only)
    const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(row.tenant_id);
    const tariff = db.prepare(`SELECT * FROM tariffs WHERE id = ?`).get(row.requested_tariff_id);
    if (!tenant || !tariff)
        return reply.code(404).send({ error: 'Firma ýa-da tarif ýok' });
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    db.prepare(`INSERT INTO tenant_subscriptions (tenant_id, tenant_slug, tariff_id, status, period_start, period_end, auto_renew, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, 1, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       tariff_id=excluded.tariff_id, status='active',
       period_start=excluded.period_start, period_end=excluded.period_end, updated_at=excluded.updated_at`).run(tenant.id, tenant.slug, tariff.id, now, periodEnd, now);
    ensureWallet(db, tenant.id, tenant.slug, 0);
    // Balance is NEVER reset — remaining credits stay on wallet
    let granted = 0;
    if (tariff.included_credits > 0) {
        granted = await applyLedger(db, {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            type: 'grant',
            amount: Number(tariff.included_credits),
            reason: `Tarif üýtgetme tassyklama — «${tariff.name}» included`,
            createdBy: parsed.data.resolvedBy || 'admin',
        });
    }
    db.prepare(`UPDATE tariff_change_requests SET status = 'approved', resolved_at = ?, resolved_by = ? WHERE id = ?`).run(now, parsed.data.resolvedBy || 'admin', row.id);
    const w = db.prepare(`SELECT * FROM tenant_wallets WHERE tenant_id = ?`).get(tenant.id);
    const sub = db.prepare(`SELECT * FROM tenant_subscriptions WHERE tenant_id = ?`).get(tenant.id);
    return reply.send({
        ok: true,
        status: 'approved',
        granted,
        wallet: mapWallet(w, tariff, sub),
        note: 'Galan balans saklandy we täze tarife geçirildi',
    });
}
const ConsumeSchema = zod_1.z.object({
    tenantSlug: zod_1.z.string().min(1),
    staffId: zod_1.z.string().optional(),
    staffRole: zod_1.z.string().optional(),
    endpointId: zod_1.z.string().optional(),
    endpointName: zod_1.z.string().optional(),
    username: zod_1.z.string().optional(),
    deviceName: zod_1.z.string().optional(),
});
/** POST /api/admin/billing/consume — BI dashboard proxy after successful widget query */
async function consumeApiHttpHandler(req, reply) {
    const parsed = ConsumeSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.flatten() });
    const r = await consumeApiCredit(parsed.data.tenantSlug, {
        staffId: parsed.data.staffId,
        staffRole: parsed.data.staffRole,
        endpointId: parsed.data.endpointId,
        endpointName: parsed.data.endpointName,
        username: parsed.data.username,
        deviceName: parsed.data.deviceName,
    });
    if (!r.ok) {
        return reply.code(402).send(r);
    }
    return reply.send({ ...r, ok: true });
}
/** DELETE /api/admin/billing/ledger/:id */
async function deleteLedgerHandler(req, reply) {
    const id = req.params?.id;
    if (!id)
        return reply.code(400).send({ error: 'id gerek' });
    const db = (0, sqliteDb_1.getDb)();
    const row = db.prepare(`SELECT id FROM wallet_ledger WHERE id = ?`).get(id);
    if (!row)
        return reply.code(404).send({ error: 'Log tapylmady' });
    db.prepare(`DELETE FROM wallet_ledger WHERE id = ?`).run(id);
    return reply.send({ ok: true, deleted: 1, id });
}
/** POST /api/admin/billing/ledger/delete { ids: string[] } */
async function deleteLedgerBulkHandler(req, reply) {
    const body = (req.body || {});
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length)
        return reply.code(400).send({ error: 'ids gerek' });
    const db = (0, sqliteDb_1.getDb)();
    const del = db.prepare(`DELETE FROM wallet_ledger WHERE id = ?`);
    const tx = db.transaction((list) => {
        let n = 0;
        for (const id of list) {
            const info = del.run(id);
            n += info.changes || 0;
        }
        return n;
    });
    const deleted = tx(ids);
    return reply.send({ ok: true, deleted, ids });
}
//# sourceMappingURL=billing.controller.js.map
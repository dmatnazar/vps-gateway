"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicAuthRoutes = publicAuthRoutes;
exports.registerClientConfigRoutes = registerClientConfigRoutes;
const zod_1 = require("zod");
const sqliteDb_1 = require("../../store/sqliteDb");
const tenant_repository_1 = require("../tenant/tenant.repository");
const passwordWorker_1 = require("../../core/workers/passwordWorker");
const passwordEnc_1 = require("../../core/db/passwordEnc");
const StaffVerifySchema = zod_1.z.object({
    username: zod_1.z.string().min(1),
    password: zod_1.z.string().min(1),
});
function parseTenantSlugs(raw) {
    if (Array.isArray(raw))
        return raw.map(String);
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
function hashKind(hash) {
    if (!hash)
        return 'empty';
    if (hash.startsWith('synced-from-bi') || hash.startsWith('pending-reset') || hash.endsWith(':0000')) {
        return 'placeholder';
    }
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$'))
        return 'bcrypt';
    if (hash.includes(':'))
        return 'scrypt';
    return 'plain_or_unknown';
}
async function publicAuthRoutes(app) {
    /**
     * Electron login → POST /api/auth/verify
     * Source of truth: SQLite `staff` table (synced from BI/Electron).
     * Password formats:
     *   - BI: bcrypt ($2a$/$2b$) via hashPasswordBcrypt  → needs bcryptjs
     *   - Electron: scrypt "saltHex:hashHex" (salt as UTF-8 string)
     *   - Optional password_enc AES fallback if present
     */
    app.post('/api/auth/verify', async (req, reply) => {
        const parsed = StaffVerifySchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'username and password required' });
        }
        const { username, password } = parsed.data;
        const db = (0, sqliteDb_1.getDb)();
        const user = db
            .prepare(`SELECT * FROM staff WHERE LOWER(username) = ? AND (active = 1 OR active = '1' OR active = true) LIMIT 1`)
            .get(username.toLowerCase());
        if (!user) {
            const any = db
                .prepare(`SELECT id, active FROM staff WHERE LOWER(username) = ? LIMIT 1`)
                .get(username.toLowerCase());
            if (any) {
                return reply.code(403).send({
                    error: 'account_inactive',
                    message: 'Bu hasap öçürilen (active=false). Administrator bilen habarlaşyň.',
                });
            }
            return reply.code(404).send({ error: 'not_found', message: 'User not found in VPS staff DB' });
        }
        const hash = user.password_hash || '';
        const kind = hashKind(hash);
        const isPlaceholder = kind === 'placeholder';
        let ok = false;
        if (!isPlaceholder) {
            ok = (0, passwordWorker_1.verifyPasswordSync)(password, hash);
        }
        // Fallback: encrypted plaintext column (when sync stored passwordPlain)
        if (!ok && user.password_enc) {
            try {
                const plain = (0, passwordEnc_1.decryptPasswordPlain)(user.password_enc);
                if (plain && plain === password)
                    ok = true;
            }
            catch {
                /* ignore */
            }
        }
        if (!ok) {
            if (isPlaceholder) {
                return reply.code(403).send({
                    error: 'password_not_available',
                    message: 'VPS-de parol hash ýok (placeholder). BI-da işgäriň parolyny täzeden belläň we staff sync ediň.',
                    hashKind: kind,
                });
            }
            return reply.code(401).send({
                error: 'invalid_password',
                message: 'Username or password is incorrect',
                hashKind: kind,
            });
        }
        const tenant = user.tenant_slug
            ? await tenant_repository_1.tenantRepository.findBySlug(user.tenant_slug)
            : null;
        return reply.send({
            ok: true,
            user: {
                id: user.id,
                username: user.username,
                fullName: user.full_name,
                role: user.role,
                tenantSlug: user.tenant_slug,
                tenantSlugs: parseTenantSlugs(user.tenant_slugs),
                tenantName: tenant?.name,
                tenantId: tenant?.id,
                phone: user.phone,
                email: user.email,
                active: Boolean(user.active),
            },
        });
    });
}
/** Public read — Electron pulls update feed + public gateway URL (from BI) on every sync */
async function registerClientConfigRoutes(app) {
    app.get('/api/client-config/update-feed', async (_req, reply) => {
        const raw = (0, sqliteDb_1.getAppSetting)('update_feed');
        let cfg = {
            protocol: 'http',
            host: '216.250.13.39',
            port: '',
            path: '/updates',
            username: '',
        };
        if (raw) {
            try {
                cfg = { ...cfg, ...JSON.parse(raw) };
            }
            catch {
                /* ignore */
            }
        }
        // Electron auto-update Basic Auth — password must travel so BI changes apply on sync.
        // This is the update-server credential (not user login).
        const gatewayUrl = ((0, sqliteDb_1.getAppSetting)('public_gateway_url') || '').trim();
        return reply.send({
            ok: true,
            updateFeed: {
                protocol: cfg.protocol || 'http',
                host: cfg.host || '',
                port: cfg.port ?? '',
                path: cfg.path || '/updates',
                username: cfg.username || '',
                password: typeof cfg.password === 'string' ? cfg.password : '',
            },
            /** BI Settings-däki GATEWAY_URL — Electron şony ulanmaly */
            gatewayUrl: gatewayUrl || '',
        });
    });
}
//# sourceMappingURL=public.auth.routes.js.map
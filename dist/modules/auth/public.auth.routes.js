"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicAuthRoutes = publicAuthRoutes;
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
    if (hash.startsWith('synced-from-bi') || hash.startsWith('pending-reset') || hash.endsWith(':0000'))
        return 'placeholder';
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$'))
        return 'bcrypt';
    if (hash.includes(':'))
        return 'scrypt';
    return 'plain_or_unknown';
}
async function publicAuthRoutes(app) {
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
                tenantName: tenant === null || tenant === void 0 ? void 0 : tenant.name,
                tenantId: tenant === null || tenant === void 0 ? void 0 : tenant.id,
                phone: user.phone,
                email: user.email,
                active: Boolean(user.active),
            },
        });
    });
}
//# sourceMappingURL=public.auth.routes.js.map

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAvatarRoutes = registerAvatarRoutes;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const env_1 = require("../../config/env");
const zod_1 = require("zod");
function avatarDir() {
    const dir = node_path_1.default.join(node_path_1.default.dirname(env_1.env.DB_FILE), 'avatars');
    if (!node_fs_1.default.existsSync(dir))
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function safeName(username) {
    return username.toLowerCase().replace(/[^a-z0-9_-]/g, '') + '.jpg';
}
async function registerAvatarRoutes(app) {
    /** Upload: { username, imageBase64, maxWidth? } — compress client-side already */
    app.post('/api/admin/avatar', { preHandler: [app.verifyAdminSyncSignature] }, async (req, reply) => {
        const body = zod_1.z
            .object({
            username: zod_1.z.string().min(1),
            imageBase64: zod_1.z.string().min(1),
        })
            .safeParse(req.body);
        if (!body.success)
            return reply.code(400).send({ error: 'bad body' });
        const raw = body.data.imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(raw, 'base64');
        if (buf.length > 2_000_000)
            return reply.code(400).send({ error: 'Max 2MB' });
        const file = node_path_1.default.join(avatarDir(), safeName(body.data.username));
        node_fs_1.default.writeFileSync(file, buf);
        return reply.send({
            ok: true,
            url: `/api/avatars/${encodeURIComponent(body.data.username.toLowerCase())}`,
        });
    });
    app.delete('/api/admin/avatar', { preHandler: [app.verifyAdminSyncSignature] }, async (req, reply) => {
        const body = zod_1.z.object({ username: zod_1.z.string().min(1) }).safeParse(req.body);
        if (!body.success)
            return reply.code(400).send({ error: 'bad body' });
        const file = node_path_1.default.join(avatarDir(), safeName(body.data.username));
        if (node_fs_1.default.existsSync(file))
            node_fs_1.default.unlinkSync(file);
        return reply.send({ ok: true });
    });
    app.get('/api/avatars/:username', async (req, reply) => {
        const { username } = req.params;
        const file = node_path_1.default.join(avatarDir(), safeName(username));
        if (!node_fs_1.default.existsSync(file))
            return reply.code(404).send({ error: 'not found' });
        const buf = node_fs_1.default.readFileSync(file);
        return reply.type('image/jpeg').send(buf);
    });
}
//# sourceMappingURL=avatar.routes.js.map
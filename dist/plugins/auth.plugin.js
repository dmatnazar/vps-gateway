"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authPlugin = void 0;
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../config/env");
/**
 * HMAC-SHA256 of request body (JSON string) with ADMIN_SYNC_SECRET.
 * For GET / body-less requests, clients must sign the empty object "{}".
 */
async function authPluginImpl(app) {
    app.decorate('verifyAdminSyncSignature', async (req, reply) => {
        const signature = req.headers['x-admin-signature'];
        if (!signature || typeof signature !== 'string') {
            return reply.code(401).send({ error: 'Missing X-Admin-Signature header' });
        }
        const payload = req.body !== undefined && req.body !== null
            ? JSON.stringify(req.body)
            : '{}';
        const expected = node_crypto_1.default
            .createHmac('sha256', env_1.env.ADMIN_SYNC_SECRET)
            .update(payload)
            .digest('hex');
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !node_crypto_1.default.timingSafeEqual(sigBuf, expBuf)) {
            return reply.code(403).send({ error: 'Invalid admin signature' });
        }
    });
}
exports.authPlugin = (0, fastify_plugin_1.default)(authPluginImpl);
//# sourceMappingURL=auth.plugin.js.map
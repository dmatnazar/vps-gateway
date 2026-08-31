"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authPlugin = void 0;
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../config/env");
const sqliteDb_1 = require("../store/sqliteDb");
async function verifyAdminSignature(app, req, reply) {
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
}
/** Requires device row + device_sync_secret already in DB. Do NOT use on /devices/register or first /status. */
async function verifyDeviceSignature(app, req, reply) {
    const signature = req.headers['x-device-sync-signature'];
    const deviceId = req.headers['x-device-id'];
    if (!signature || typeof signature !== 'string') {
        return reply.code(401).send({ error: 'Missing X-Device-Sync-Signature header' });
    }
    if (!deviceId || typeof deviceId !== 'string') {
        return reply.code(401).send({ error: 'Missing X-Device-Id header' });
    }
    const db = (0, sqliteDb_1.getDb)();
    const device = db.prepare(`SELECT device_sync_secret FROM devices WHERE id = ?`).get(deviceId);
    if (!device || !device.device_sync_secret) {
        return reply.code(403).send({ error: 'Device not found or no sync secret' });
    }
    const payload = req.body !== undefined && req.body !== null
        ? JSON.stringify(req.body)
        : '{}';
    const signedPayload = JSON.stringify({ deviceId, ...(req.body !== undefined && req.body !== null ? req.body : {}) });
    const expected = node_crypto_1.default
        .createHmac('sha256', device.device_sync_secret)
        .update(signedPayload)
        .digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !node_crypto_1.default.timingSafeEqual(sigBuf, expBuf)) {
        return reply.code(403).send({ error: 'Invalid device sync signature' });
    }
}
async function authPluginImpl(app) {
    app.decorate('verifyAdminSyncSignature', async (req, reply) => {
        return verifyAdminSignature(app, req, reply);
    });
    app.decorate('verifyDeviceSyncSignature', async (req, reply) => {
        return verifyDeviceSignature(app, req, reply);
    });
    app.decorate('verifySyncSignature', async (req, reply) => {
        const adminSig = req.headers['x-admin-signature'];
        const deviceSig = req.headers['x-device-sync-signature'];
        if (adminSig && typeof adminSig === 'string') {
            return verifyAdminSignature(app, req, reply);
        }
        if (deviceSig && typeof deviceSig === 'string') {
            return verifyDeviceSignature(app, req, reply);
        }
        return reply.code(401).send({ error: 'Missing sync signature header' });
    });
}
exports.authPlugin = (0, fastify_plugin_1.default)(authPluginImpl);
//# sourceMappingURL=auth.plugin.js.map
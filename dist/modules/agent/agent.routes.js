"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentRoutes = agentRoutes;
const agentTunnelManager_1 = require("../../core/tunnel/agentTunnelManager");
const deviceEventManager_1 = require("../../core/tunnel/deviceEventManager");
const env_1 = require("../../config/env");
const node_crypto_1 = __importDefault(require("node:crypto"));
const sqliteDb_1 = require("../../store/sqliteDb");
async function agentRoutes(app) {
    // WebSocket endpoint for Electron local agents: /ws/agent?tenantSlug=...&signature=...
    app.get('/ws/agent', { websocket: true }, (connection, req) => {
        const query = (req.query || {});
        const tenantSlug = (query.tenantSlug || query.tenant || '').trim();
        const adminSignature = (query.signature || req.headers['x-admin-signature'] || '').trim();
        const deviceSignature = (query.deviceSignature || req.headers['x-device-sync-signature'] || '').trim();
        const deviceId = (query.deviceId || req.headers['x-device-id'] || '').trim();
        const adminSecret = (query.secret || '').trim();
        const socket = connection.socket || connection;
        if (!tenantSlug) {
            try {
                socket.send(JSON.stringify({ error: 'Missing tenantSlug query param' }));
                socket.close(1008, 'Missing tenantSlug');
            }
            catch {
                /* ignore */
            }
            return;
        }
        let authorized = false;
        // Check admin secret match OR HMAC-SHA256(tenantSlug) match
        if (adminSecret && adminSecret === env_1.env.ADMIN_SYNC_SECRET) {
            authorized = true;
        }
        else if (adminSignature) {
            const expected = node_crypto_1.default
                .createHmac('sha256', env_1.env.ADMIN_SYNC_SECRET)
                .update(tenantSlug)
                .digest('hex');
            if (adminSignature === expected) {
                authorized = true;
            }
        }
        // Device HMAC: JSON.stringify({ deviceId }) ýa-da plain deviceId (compatible)
        if (!authorized && deviceSignature && deviceId) {
            const db = (0, sqliteDb_1.getDb)();
            const device = db
                .prepare(`SELECT id, status, tenant_slug, device_sync_secret FROM devices WHERE id = ?`)
                .get(deviceId);
            if (device && device.device_sync_secret) {
                const secret = String(device.device_sync_secret).trim();
                const expectedJson = node_crypto_1.default
                    .createHmac('sha256', secret)
                    .update(JSON.stringify({ deviceId }))
                    .digest('hex');
                const expectedPlain = node_crypto_1.default.createHmac('sha256', secret).update(deviceId).digest('hex');
                const sigOk = deviceSignature === expectedJson ||
                    deviceSignature === expectedPlain ||
                    deviceSignature.toLowerCase() === expectedJson.toLowerCase();
                if (sigOk) {
                    if (device.status !== 'approved') {
                        console.warn('[AgentWS] device not approved', { deviceId, status: device.status, tenantSlug });
                        try {
                            socket.send(JSON.stringify({
                                error: 'Device not approved',
                                status: device.status,
                                hint: 'BI → Enjamlar → tassyklamak we firma baglamak',
                            }));
                            socket.close(1008, 'Device not approved');
                        }
                        catch {
                            /* ignore */
                        }
                        return;
                    }
                    const assigned = db
                        .prepare(`SELECT 1 as ok FROM device_assignments WHERE device_id = ? AND tenant_slug = ? LIMIT 1`)
                        .get(deviceId, tenantSlug);
                    const primaryOk = device.tenant_slug && String(device.tenant_slug) === tenantSlug;
                    if (!assigned && !primaryOk) {
                        console.warn('[AgentWS] device not assigned to tenant', { deviceId, tenantSlug });
                        try {
                            socket.send(JSON.stringify({
                                error: 'Device not assigned to this company',
                                tenantSlug,
                                hint: 'BI-da enjamy şu firma bilen baglaň',
                            }));
                            socket.close(1008, 'Not assigned');
                        }
                        catch {
                            /* ignore */
                        }
                        return;
                    }
                    authorized = true;
                    console.log('[AgentWS] device auth OK', { deviceId, tenantSlug, status: device.status });
                }
                else {
                    console.warn('[AgentWS] device signature mismatch', {
                        deviceId,
                        tenantSlug,
                        secretLen: secret.length,
                        sigPrefix: deviceSignature.slice(0, 12),
                        expPrefix: expectedJson.slice(0, 12),
                    });
                }
            }
            else {
                console.warn('[AgentWS] device missing or no sync secret', {
                    deviceId,
                    hasRow: Boolean(device),
                });
            }
        }
        if (!authorized) {
            console.warn('[AgentWS] unauthorized', {
                tenantSlug,
                deviceId: deviceId || null,
                hasDeviceSig: Boolean(deviceSignature),
                hasAdminSig: Boolean(adminSignature),
                hasAdminSecretQuery: Boolean(adminSecret),
            });
            try {
                socket.send(JSON.stringify({
                    error: 'Unauthorized agent: device must be approved + assigned; sign with device_sync_secret (deviceId + deviceSignature).',
                }));
                socket.close(1008, 'Unauthorized');
            }
            catch {
                /* ignore */
            }
            return;
        }
        const clientInfo = req.headers['user-agent'] || query.client || 'Electron Local Agent';
        agentTunnelManager_1.agentTunnelManager.registerAgent(tenantSlug, socket, clientInfo);
        try {
            socket.send(JSON.stringify({
                type: 'CONNECTED',
                tenantSlug,
                status: 'online',
                timestamp: new Date().toISOString(),
            }));
        }
        catch {
            /* ignore */
        }
    });
    // WebSocket endpoint for Electron devices to receive real-time events (approve/block/delete)
    app.get('/ws/device-events', { websocket: true }, (connection, req) => {
        const query = (req.query || {});
        const deviceId = (query.deviceId || req.headers['x-device-id'] || '').trim();
        const deviceSignature = (query.deviceSignature || req.headers['x-device-sync-signature'] || '').trim();
        const socket = connection.socket || connection;
        if (!deviceId) {
            try {
                socket.send(JSON.stringify({ error: 'Missing deviceId query param' }));
                socket.close(1008, 'Missing deviceId');
            }
            catch {
                /* ignore */
            }
            return;
        }
        // Verify device signature: HMAC-SHA256(deviceId) signed with device's sync secret
        let authorized = false;
        const db = (0, sqliteDb_1.getDb)();
        const device = db.prepare(`SELECT device_sync_secret FROM devices WHERE id = ?`).get(deviceId);
        if (device && device.device_sync_secret && deviceSignature) {
            const expected = node_crypto_1.default
                .createHmac('sha256', device.device_sync_secret)
                .update(JSON.stringify({ deviceId }))
                .digest('hex');
            if (deviceSignature === expected) {
                authorized = true;
            }
        }
        if (!authorized) {
            try {
                socket.send(JSON.stringify({ error: 'Unauthorized device events: signature invalid' }));
                socket.close(1008, 'Unauthorized');
            }
            catch {
                /* ignore */
            }
            return;
        }
        deviceEventManager_1.deviceEventManager.register(deviceId, socket);
        try {
            socket.send(JSON.stringify({
                event: 'CONNECTED',
                deviceId,
                status: 'online',
                timestamp: new Date().toISOString(),
            }));
        }
        catch {
            /* ignore */
        }
    });
    // Status endpoint for BI or Admin to check if a tenant agent is online
    app.get('/api/admin/agents', async () => {
        return {
            ok: true,
            agents: agentTunnelManager_1.agentTunnelManager.getConnectedTenants(),
        };
    });
    app.get('/api/v1/:tenantSlug/status/agent', async (req) => {
        const { tenantSlug } = req.params;
        const online = agentTunnelManager_1.agentTunnelManager.isAgentOnline(tenantSlug);
        return {
            tenantSlug,
            agentOnline: online,
            status: online ? 'online' : 'offline',
        };
    });
}
//# sourceMappingURL=agent.routes.js.map
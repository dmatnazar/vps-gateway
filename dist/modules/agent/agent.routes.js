"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentRoutes = agentRoutes;
const agentTunnelManager_1 = require("../../core/tunnel/agentTunnelManager");
const env_1 = require("../../config/env");
const node_crypto_1 = __importDefault(require("node:crypto"));
async function agentRoutes(app) {
    // WebSocket endpoint for Electron local agents: /ws/agent?tenantSlug=...&signature=...
    app.get('/ws/agent', { websocket: true }, (connection, req) => {
        const query = (req.query || {});
        const tenantSlug = (query.tenantSlug || query.tenant || '').trim();
        const signature = (query.signature || req.headers['x-admin-signature'] || '').trim();
        const secret = (query.secret || '').trim();
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
        // Check authorization: admin secret match OR HMAC-SHA256(tenantSlug) match
        let authorized = false;
        if (secret && secret === env_1.env.ADMIN_SYNC_SECRET) {
            authorized = true;
        }
        else if (signature) {
            const expected = node_crypto_1.default
                .createHmac('sha256', env_1.env.ADMIN_SYNC_SECRET)
                .update(tenantSlug)
                .digest('hex');
            if (signature === expected) {
                authorized = true;
            }
        }
        if (!authorized) {
            try {
                socket.send(JSON.stringify({ error: 'Unauthorized agent: signature or secret invalid' }));
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
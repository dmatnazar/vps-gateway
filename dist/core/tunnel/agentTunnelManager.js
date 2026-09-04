"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentTunnelManager = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
class AgentTunnelManager {
    /** Map of tenantSlug -> Set of active AgentConnections */
    agents = new Map();
    /** Round-robin index per tenant for load distribution */
    roundRobinIndices = new Map();
    /** Map of requestId -> PendingRequest */
    pendingRequests = new Map();
    pingInterval = null;
    /** No PONG within this window → treat socket as dead (NAT / half-open) */
    static PONG_TIMEOUT_MS = 55_000;
    /** Application PING interval */
    static PING_INTERVAL_MS = 15_000;
    constructor() {
        this.startHeartbeat();
    }
    startHeartbeat() {
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            const now = new Date();
            const nowMs = now.getTime();
            for (const [, connSet] of this.agents.entries()) {
                // Copy to avoid mutation during iteration
                for (const conn of Array.from(connSet)) {
                    if (conn.socket.readyState !== 1 /* OPEN */) {
                        this.removeConnection(conn);
                        continue;
                    }
                    // Stale: no PONG for too long → force drop so Electron can reconnect
                    const silentMs = nowMs - conn.lastPongAt.getTime();
                    if (silentMs > AgentTunnelManager.PONG_TIMEOUT_MS) {
                        console.warn(`[AgentTunnel] ⚠️ No PONG from "${conn.tenantSlug}" for ${Math.round(silentMs / 1000)}s — dropping zombie socket`);
                        this.removeConnection(conn);
                        continue;
                    }
                    try {
                        conn.lastPingAt = now;
                        conn.socket.send(JSON.stringify({ type: 'PING', timestamp: now.toISOString() }));
                        // TCP-level ping when supported (ws library)
                        const sock = conn.socket;
                        if (typeof sock.ping === 'function') {
                            try {
                                sock.ping();
                            }
                            catch {
                                /* ignore */
                            }
                        }
                    }
                    catch {
                        this.removeConnection(conn);
                    }
                }
            }
        }, AgentTunnelManager.PING_INTERVAL_MS);
    }
    /**
     * Register a newly connected agent WebSocket
     */
    registerAgent(tenantSlug, socket, clientInfo) {
        const now = new Date();
        const conn = {
            socket,
            tenantSlug,
            clientInfo,
            connectedAt: now,
            lastPingAt: now,
            lastPongAt: now,
        };
        if (!this.agents.has(tenantSlug)) {
            this.agents.set(tenantSlug, new Set());
        }
        this.agents.get(tenantSlug).add(conn);
        // Setup socket listeners
        socket.on('message', (raw) => {
            this.handleSocketMessage(conn, raw);
        });
        socket.on('close', () => {
            this.removeConnection(conn);
        });
        socket.on('error', (err) => {
            console.warn(`[AgentTunnel] socket error (${tenantSlug}):`, err?.message || err);
            this.removeConnection(conn);
        });
        // TCP pong from ws library also counts as liveness
        socket.on('pong', () => {
            conn.lastPongAt = new Date();
        });
        console.log(`[AgentTunnel] 🟢 Agent connected for tenant "${tenantSlug}" (${clientInfo || 'Electron'})`);
        return conn;
    }
    removeConnection(conn) {
        const connSet = this.agents.get(conn.tenantSlug);
        if (connSet) {
            connSet.delete(conn);
            if (connSet.size === 0) {
                this.agents.delete(conn.tenantSlug);
            }
        }
        try {
            if (conn.socket.readyState === 1)
                conn.socket.close();
        }
        catch {
            /* ignore */
        }
        console.log(`[AgentTunnel] 🔴 Agent disconnected for tenant "${conn.tenantSlug}"`);
    }
    isAgentOnline(tenantSlug) {
        const connSet = this.agents.get(tenantSlug);
        if (!connSet || connSet.size === 0)
            return false;
        for (const conn of connSet) {
            if (conn.socket.readyState === 1)
                return true;
        }
        return false;
    }
    getConnectedTenants() {
        const list = [];
        for (const [tenantSlug, connSet] of this.agents.entries()) {
            const active = Array.from(connSet).filter((c) => c.socket.readyState === 1);
            if (active.length > 0) {
                list.push({
                    tenantSlug,
                    agentsCount: active.length,
                    connectedAt: active[0].connectedAt.toISOString(),
                });
            }
        }
        return list;
    }
    handleSocketMessage(conn, raw) {
        try {
            const msgStr = typeof raw === 'string' ? raw : raw.toString('utf8');
            const msg = JSON.parse(msgStr);
            if (msg.type === 'PONG') {
                conn.lastPongAt = new Date();
                return;
            }
            if (msg.type === 'QUERY_RESULT' && msg.requestId) {
                const pending = this.pendingRequests.get(msg.requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(msg.requestId);
                    if (msg.ok) {
                        pending.resolve({
                            ok: true,
                            rows: msg.rows || [],
                            rowCount: msg.rowCount ?? (msg.rows ? msg.rows.length : 0),
                            elapsedMs: msg.elapsedMs,
                        });
                    }
                    else {
                        pending.resolve({
                            ok: false,
                            error: msg.error || 'Unknown query error from local agent',
                            elapsedMs: msg.elapsedMs,
                        });
                    }
                }
            }
        }
        catch (err) {
            console.warn('[AgentTunnel] failed to parse message:', err);
        }
    }
    /**
     * Dispatches a query to the connected Electron agent and awaits result
     */
    async executeRemoteQuery(tenantSlug, payload) {
        const connSet = this.agents.get(tenantSlug);
        const activeConns = connSet ? Array.from(connSet).filter((c) => c.socket.readyState === 1) : [];
        if (activeConns.length === 0) {
            return {
                ok: false,
                error: `Ýerli Electron Agent birikdirilmedik ("${tenantSlug}"). Electron programmasyny ýerli kompýuterde işlediň.`,
            };
        }
        // Select connection via round-robin for optimal load distribution
        const currentIdx = (this.roundRobinIndices.get(tenantSlug) || 0) % activeConns.length;
        this.roundRobinIndices.set(tenantSlug, currentIdx + 1);
        const conn = activeConns[currentIdx];
        const requestId = 'rq_' + node_crypto_1.default.randomUUID();
        const timeoutMs = payload.timeoutMs || 35_000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                resolve({
                    ok: false,
                    error: `Ýerli MSSQL soragy wagt çäginden geçdi (${timeoutMs / 1000}s timeout).`,
                });
            }, timeoutMs);
            this.pendingRequests.set(requestId, {
                resolve,
                reject,
                timer,
                tenantSlug,
            });
            const message = {
                type: 'EXECUTE_QUERY',
                requestId,
                tenantSlug,
                dbKey: payload.dbKey || 'primary',
                sqlQuery: payload.sqlQuery,
                params: payload.params || {},
            };
            if (payload.connection) {
                message.connection = payload.connection;
            }
            try {
                conn.socket.send(JSON.stringify(message));
            }
            catch (err) {
                clearTimeout(timer);
                this.pendingRequests.delete(requestId);
                resolve({
                    ok: false,
                    error: `Agent-e sorag ugradyp bolmady: ${err.message}`,
                });
            }
        });
    }
}
exports.agentTunnelManager = new AgentTunnelManager();
//# sourceMappingURL=agentTunnelManager.js.map
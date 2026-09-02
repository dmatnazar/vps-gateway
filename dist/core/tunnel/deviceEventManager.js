"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deviceEventManager = void 0;
class DeviceEventManager {
    connections = new Map();
    pingInterval = null;
    static PONG_TIMEOUT_MS = 55_000;
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
            for (const [, connSet] of this.connections.entries()) {
                for (const conn of Array.from(connSet)) {
                    if (conn.socket.readyState !== 1 /* OPEN */) {
                        this.removeConnection(conn);
                        continue;
                    }
                    const silentMs = nowMs - conn.lastPongAt.getTime();
                    if (silentMs > DeviceEventManager.PONG_TIMEOUT_MS) {
                        console.warn(`[DeviceEvents] ⚠️ No PONG from device "${conn.deviceId}" for ${Math.round(silentMs / 1000)}s — dropping`);
                        this.removeConnection(conn);
                        continue;
                    }
                    try {
                        conn.lastPingAt = now;
                        conn.socket.send(JSON.stringify({ type: 'PING', timestamp: now.toISOString() }));
                        const sock = conn.socket;
                        if (typeof sock.ping === 'function') {
                            try {
                                sock.ping();
                            }
                            catch {
                                /* */
                            }
                        }
                    }
                    catch {
                        this.removeConnection(conn);
                    }
                }
            }
        }, DeviceEventManager.PING_INTERVAL_MS);
    }
    register(deviceId, socket) {
        const now = new Date();
        const conn = {
            socket,
            deviceId,
            connectedAt: now,
            lastPingAt: now,
            lastPongAt: now,
        };
        if (!this.connections.has(deviceId)) {
            this.connections.set(deviceId, new Set());
        }
        this.connections.get(deviceId).add(conn);
        socket.on('message', (raw) => {
            try {
                const msgStr = typeof raw === 'string' ? raw : raw.toString('utf8');
                const msg = JSON.parse(msgStr);
                if (msg.type === 'PONG') {
                    conn.lastPongAt = new Date();
                }
            }
            catch {
                /* ignore */
            }
        });
        socket.on('close', () => this.removeConnection(conn));
        socket.on('error', () => this.removeConnection(conn));
        socket.on('pong', () => {
            conn.lastPongAt = new Date();
        });
        console.log(`[DeviceEvents] 🟢 Device "${deviceId}" connected for real-time events`);
        return conn;
    }
    removeConnection(conn) {
        const connSet = this.connections.get(conn.deviceId);
        if (connSet) {
            connSet.delete(conn);
            if (connSet.size === 0) {
                this.connections.delete(conn.deviceId);
            }
        }
        try {
            if (conn.socket.readyState === 1)
                conn.socket.close();
        }
        catch {
            /* ignore */
        }
    }
    isConnected(deviceId) {
        const connSet = this.connections.get(deviceId);
        if (!connSet || connSet.size === 0)
            return false;
        for (const conn of connSet) {
            if (conn.socket.readyState === 1)
                return true;
        }
        return false;
    }
    /** Send a real-time event to all sockets of a device. Returns true if delivered. */
    broadcast(deviceId, payload) {
        const connSet = this.connections.get(deviceId);
        if (!connSet || connSet.size === 0)
            return false;
        const message = JSON.stringify({
            event: 'DEVICE_EVENT',
            ...payload,
            timestamp: new Date().toISOString(),
        });
        let delivered = false;
        for (const conn of connSet) {
            if (conn.socket.readyState === 1) {
                try {
                    conn.socket.send(message);
                    delivered = true;
                }
                catch (err) {
                    console.warn(`[DeviceEvents] Failed to send to device "${deviceId}":`, err);
                }
            }
        }
        return delivered;
    }
}
exports.deviceEventManager = new DeviceEventManager();
//# sourceMappingURL=deviceEventManager.js.map
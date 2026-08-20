import type { WebSocket } from 'ws';

export interface DeviceEventPayload {
  type: 'DEVICE_APPROVED' | 'DEVICE_BLOCKED' | 'DEVICE_DELETED' | 'COMPANY_ASSIGNED' | 'COMPANY_REMOVED' | 'DEVICE_UPDATED';
  deviceId: string;
  status?: string;
  companySlugs?: string[];
  companyNames?: string[];
  tenantSlug?: string;
  timestamp: string;
}

interface DeviceConnection {
  socket: WebSocket;
  deviceId: string;
  connectedAt: Date;
  lastPingAt: Date;
  lastPongAt: Date;
}

class DeviceEventManager {
  private connections = new Map<string, Set<DeviceConnection>>();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      const now = new Date();
      for (const [deviceId, connSet] of this.connections.entries()) {
        for (const conn of connSet) {
          if (conn.socket.readyState === 1 /* OPEN */) {
            try {
              conn.lastPingAt = now;
              conn.socket.send(JSON.stringify({ type: 'PING', timestamp: now.toISOString() }));
            } catch {
              this.removeConnection(conn);
            }
          } else {
            this.removeConnection(conn);
          }
        }
      }
    }, 20_000);
  }

  public register(deviceId: string, socket: WebSocket): DeviceConnection {
    const conn: DeviceConnection = {
      socket,
      deviceId,
      connectedAt: new Date(),
      lastPingAt: new Date(),
      lastPongAt: new Date(),
    };

    if (!this.connections.has(deviceId)) {
      this.connections.set(deviceId, new Set());
    }
    this.connections.get(deviceId)!.add(conn);

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msgStr = typeof raw === 'string' ? raw : raw.toString('utf8');
        const msg = JSON.parse(msgStr);
        if (msg.type === 'PONG') {
          conn.lastPongAt = new Date();
        }
      } catch {
        /* ignore */
      }
    });

    socket.on('close', () => this.removeConnection(conn));
    socket.on('error', () => this.removeConnection(conn));

    console.log(`[DeviceEvents] 🟢 Device "${deviceId}" connected for real-time events`);
    return conn;
  }

  public removeConnection(conn: DeviceConnection) {
    const connSet = this.connections.get(conn.deviceId);
    if (connSet) {
      connSet.delete(conn);
      if (connSet.size === 0) {
        this.connections.delete(conn.deviceId);
      }
    }
    try {
      if (conn.socket.readyState === 1) conn.socket.close();
    } catch {
      /* ignore */
    }
  }

  public isConnected(deviceId: string): boolean {
    const connSet = this.connections.get(deviceId);
    if (!connSet || connSet.size === 0) return false;
    for (const conn of connSet) {
      if (conn.socket.readyState === 1) return true;
    }
    return false;
  }

  /** Send a real-time event to all sockets of a device. Returns true if delivered. */
  public broadcast(deviceId: string, payload: Omit<DeviceEventPayload, 'timestamp'>): boolean {
    const connSet = this.connections.get(deviceId);
    if (!connSet || connSet.size === 0) return false;

    const message = JSON.stringify({
      event: 'DEVICE_EVENT',
      ...payload,
      timestamp: new Date().toISOString(),
    } as DeviceEventPayload & { event: string });

    let delivered = false;
    for (const conn of connSet) {
      if (conn.socket.readyState === 1) {
        try {
          conn.socket.send(message);
          delivered = true;
        } catch (err) {
          console.warn(`[DeviceEvents] Failed to send to device "${deviceId}":`, err);
        }
      }
    }
    return delivered;
  }
}

export const deviceEventManager = new DeviceEventManager();
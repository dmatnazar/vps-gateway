import type { WebSocket } from 'ws';

export interface DeviceEventPayload {
  type:
    | 'DEVICE_APPROVED'
    | 'DEVICE_BLOCKED'
    | 'DEVICE_DELETED'
    | 'COMPANY_ASSIGNED'
    | 'COMPANY_REMOVED'
    | 'DEVICE_UPDATED'
    | 'SETTINGS_UPDATED';
  deviceId: string;
  status?: string;
  companySlugs?: string[];
  companyNames?: string[];
  tenantSlug?: string;
  /** Tenant slug removed from device (company delete) */
  removedSlug?: string;
  /** Per-device settings payload (autostart, autoSync, …) */
  settings?: Record<string, unknown>;
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
  private static readonly PONG_TIMEOUT_MS = 55_000;
  private static readonly PING_INTERVAL_MS = 15_000;

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);
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
            console.warn(
              `[DeviceEvents] ⚠️ No PONG from device "${conn.deviceId}" for ${Math.round(silentMs / 1000)}s — dropping`
            );
            this.removeConnection(conn);
            continue;
          }
          try {
            conn.lastPingAt = now;
            conn.socket.send(JSON.stringify({ type: 'PING', timestamp: now.toISOString() }));
            const sock = conn.socket as WebSocket & { ping?: () => void };
            if (typeof sock.ping === 'function') {
              try {
                sock.ping();
              } catch {
                /* */
              }
            }
          } catch {
            this.removeConnection(conn);
          }
        }
      }
    }, DeviceEventManager.PING_INTERVAL_MS);
  }

  public register(deviceId: string, socket: WebSocket): DeviceConnection {
    const now = new Date();
    const conn: DeviceConnection = {
      socket,
      deviceId,
      connectedAt: now,
      lastPingAt: now,
      lastPongAt: now,
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
    socket.on('pong', () => {
      conn.lastPongAt = new Date();
    });

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
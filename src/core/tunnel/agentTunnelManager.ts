import type { WebSocket } from 'ws';
import crypto from 'node:crypto';

export interface RemoteQueryPayload {
  sqlQuery: string;
  params?: Record<string, unknown>;
  dbKey?: string;
  timeoutMs?: number;
  /** Ad-hoc MSSQL connection (list DBs before connection is saved) */
  connection?: {
    host: string;
    port?: number;
    username: string;
    password: string;
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    database?: string;
  };
}

export interface RemoteQueryResult {
  ok: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  elapsedMs?: number;
  error?: string;
}

interface PendingRequest {
  resolve: (value: RemoteQueryResult) => void;
  reject: (reason?: any) => void;
  timer: NodeJS.Timeout;
  tenantSlug: string;
}

interface AgentConnection {
  socket: WebSocket;
  tenantSlug: string;
  clientInfo?: string;
  connectedAt: Date;
  lastPingAt: Date;
  lastPongAt: Date;
}

class AgentTunnelManager {
  /** Map of tenantSlug -> Set of active AgentConnections */
  private agents = new Map<string, Set<AgentConnection>>();

  /** Round-robin index per tenant for load distribution */
  private roundRobinIndices = new Map<string, number>();

  /** Map of requestId -> PendingRequest */
  private pendingRequests = new Map<string, PendingRequest>();

  private pingInterval: NodeJS.Timeout | null = null;

  /** No PONG within this window → treat socket as dead (NAT / half-open) */
  private static readonly PONG_TIMEOUT_MS = 55_000;
  /** Application PING interval */
  private static readonly PING_INTERVAL_MS = 15_000;

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);
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
            console.warn(
              `[AgentTunnel] ⚠️ No PONG from "${conn.tenantSlug}" for ${Math.round(silentMs / 1000)}s — dropping zombie socket`
            );
            this.removeConnection(conn);
            continue;
          }
          try {
            conn.lastPingAt = now;
            conn.socket.send(JSON.stringify({ type: 'PING', timestamp: now.toISOString() }));
            // TCP-level ping when supported (ws library)
            const sock = conn.socket as WebSocket & { ping?: (data?: Buffer) => void };
            if (typeof sock.ping === 'function') {
              try {
                sock.ping();
              } catch {
                /* ignore */
              }
            }
          } catch {
            this.removeConnection(conn);
          }
        }
      }
    }, AgentTunnelManager.PING_INTERVAL_MS);
  }

  /**
   * Register a newly connected agent WebSocket
   */
  public registerAgent(tenantSlug: string, socket: WebSocket, clientInfo?: string): AgentConnection {
    const now = new Date();
    const conn: AgentConnection = {
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
    this.agents.get(tenantSlug)!.add(conn);

    // Setup socket listeners
    socket.on('message', (raw: Buffer | string) => {
      this.handleSocketMessage(conn, raw);
    });

    socket.on('close', () => {
      this.removeConnection(conn);
    });

    socket.on('error', (err: any) => {
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

  public removeConnection(conn: AgentConnection) {
    const connSet = this.agents.get(conn.tenantSlug);
    if (connSet) {
      connSet.delete(conn);
      if (connSet.size === 0) {
        this.agents.delete(conn.tenantSlug);
      }
    }
    try {
      if (conn.socket.readyState === 1) conn.socket.close();
    } catch {
      /* ignore */
    }
    console.log(`[AgentTunnel] 🔴 Agent disconnected for tenant "${conn.tenantSlug}"`);
  }

  public isAgentOnline(tenantSlug: string): boolean {
    const connSet = this.agents.get(tenantSlug);
    if (!connSet || connSet.size === 0) return false;
    for (const conn of connSet) {
      if (conn.socket.readyState === 1) return true;
    }
    return false;
  }

  public getConnectedTenants(): Array<{ tenantSlug: string; agentsCount: number; connectedAt: string }> {
    const list: Array<{ tenantSlug: string; agentsCount: number; connectedAt: string }> = [];
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

  private handleSocketMessage(conn: AgentConnection, raw: Buffer | string) {
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
          } else {
            pending.resolve({
              ok: false,
              error: msg.error || 'Unknown query error from local agent',
              elapsedMs: msg.elapsedMs,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[AgentTunnel] failed to parse message:', err);
    }
  }

  /**
   * Dispatches a query to the connected Electron agent and awaits result
   */
  public async executeRemoteQuery(
    tenantSlug: string,
    payload: RemoteQueryPayload
  ): Promise<RemoteQueryResult> {
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
    const requestId = 'rq_' + crypto.randomUUID();
    const timeoutMs = payload.timeoutMs || 35_000;

    return new Promise<RemoteQueryResult>((resolve, reject) => {
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

      const message: Record<string, unknown> = {
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
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        resolve({
          ok: false,
          error: `Agent-e sorag ugradyp bolmady: ${(err as Error).message}`,
        });
      }
    });
  }
}

export const agentTunnelManager = new AgentTunnelManager();

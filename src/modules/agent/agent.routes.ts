import type { FastifyInstance, FastifyRequest } from 'fastify';
import { agentTunnelManager } from '../../core/tunnel/agentTunnelManager';
import { deviceEventManager } from '../../core/tunnel/deviceEventManager';
import { env } from '../../config/env';
import crypto from 'node:crypto';
import { getDb } from '../../store/sqliteDb';

export async function agentRoutes(app: FastifyInstance) {
  // WebSocket endpoint for Electron local agents: /ws/agent?tenantSlug=...&signature=...
  app.get(
    '/ws/agent',
    { websocket: true },
    (connection: any, req: FastifyRequest) => {
      const query = (req.query || {}) as Record<string, string>;
      const tenantSlug = (query.tenantSlug || query.tenant || '').trim();
      const adminSignature = (query.signature || (req.headers['x-admin-signature'] as string) || '').trim();
      const deviceSignature = (query.deviceSignature || (req.headers['x-device-sync-signature'] as string) || '').trim();
      const deviceId = (query.deviceId || (req.headers['x-device-id'] as string) || '').trim();
      const adminSecret = (query.secret || '').trim();

      const socket = connection.socket || connection;

      if (!tenantSlug) {
        try {
          socket.send(JSON.stringify({ error: 'Missing tenantSlug query param' }));
          socket.close(1008, 'Missing tenantSlug');
        } catch {
          /* ignore */
        }
        return;
      }

      let authorized = false;

      // Check admin secret match OR HMAC-SHA256(tenantSlug) match
      if (adminSecret && adminSecret === env.ADMIN_SYNC_SECRET) {
        authorized = true;
      } else if (adminSignature) {
        const expected = crypto
          .createHmac('sha256', env.ADMIN_SYNC_SECRET)
          .update(tenantSlug)
          .digest('hex');
        if (adminSignature === expected) {
          authorized = true;
        }
      }

      // Check device signature: HMAC-SHA256(deviceId) signed with device's sync secret
      if (!authorized && deviceSignature && deviceId) {
        const db = getDb();
        const device = db.prepare(`SELECT device_sync_secret FROM devices WHERE id = ?`).get(deviceId) as any;
        if (device && device.device_sync_secret) {
          const expected = crypto
            .createHmac('sha256', device.device_sync_secret)
            .update(JSON.stringify({ deviceId }))
            .digest('hex');
          if (deviceSignature === expected) {
            authorized = true;
          }
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
            error: 'Unauthorized agent: use device_sync_secret (X-Device-Id + deviceSignature). ADMIN_SYNC_SECRET is BI-only.',
          }));
          socket.close(1008, 'Unauthorized');
        } catch {
          /* ignore */
        }
        return;
      }

      const clientInfo = (req.headers['user-agent'] as string) || query.client || 'Electron Local Agent';
      agentTunnelManager.registerAgent(tenantSlug, socket, clientInfo);

      try {
        socket.send(
          JSON.stringify({
            type: 'CONNECTED',
            tenantSlug,
            status: 'online',
            timestamp: new Date().toISOString(),
          })
        );
      } catch {
        /* ignore */
      }
    }
  );

  // WebSocket endpoint for Electron devices to receive real-time events (approve/block/delete)
  app.get(
    '/ws/device-events',
    { websocket: true },
    (connection: any, req: FastifyRequest) => {
      const query = (req.query || {}) as Record<string, string>;
      const deviceId = (query.deviceId || (req.headers['x-device-id'] as string) || '').trim();
      const deviceSignature = (query.deviceSignature || (req.headers['x-device-sync-signature'] as string) || '').trim();

      const socket = connection.socket || connection;

      if (!deviceId) {
        try {
          socket.send(JSON.stringify({ error: 'Missing deviceId query param' }));
          socket.close(1008, 'Missing deviceId');
        } catch {
          /* ignore */
        }
        return;
      }

      // Verify device signature: HMAC-SHA256(deviceId) signed with device's sync secret
      let authorized = false;
      const db = getDb();
      const device = db.prepare(`SELECT device_sync_secret FROM devices WHERE id = ?`).get(deviceId) as any;
      if (device && device.device_sync_secret && deviceSignature) {
        const expected = crypto
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
        } catch {
          /* ignore */
        }
        return;
      }

      deviceEventManager.register(deviceId, socket);

      try {
        socket.send(
          JSON.stringify({
            event: 'CONNECTED',
            deviceId,
            status: 'online',
            timestamp: new Date().toISOString(),
          })
        );
      } catch {
        /* ignore */
      }
    }
  );

  // Status endpoint for BI or Admin to check if a tenant agent is online
  app.get('/api/admin/agents', async () => {
    return {
      ok: true,
      agents: agentTunnelManager.getConnectedTenants(),
    };
  });

  app.get('/api/v1/:tenantSlug/status/agent', async (req: FastifyRequest<{ Params: { tenantSlug: string } }>) => {
    const { tenantSlug } = req.params;
    const online = agentTunnelManager.isAgentOnline(tenantSlug);
    return {
      tenantSlug,
      agentOnline: online,
      status: online ? 'online' : 'offline',
    };
  });
}

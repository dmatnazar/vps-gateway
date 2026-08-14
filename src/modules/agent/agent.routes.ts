import type { FastifyInstance, FastifyRequest } from 'fastify';
import { agentTunnelManager } from '../../core/tunnel/agentTunnelManager';
import { env } from '../../config/env';
import crypto from 'node:crypto';

export async function agentRoutes(app: FastifyInstance) {
  // WebSocket endpoint for Electron local agents: /ws/agent?tenantSlug=...&signature=...
  app.get(
    '/ws/agent',
    { websocket: true },
    (connection: any, req: FastifyRequest) => {
      const query = (req.query || {}) as Record<string, string>;
      const tenantSlug = (query.tenantSlug || query.tenant || '').trim();
      const signature = (query.signature || (req.headers['x-admin-signature'] as string) || '').trim();
      const secret = (query.secret || '').trim();

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

      // Check authorization: admin secret match OR HMAC-SHA256(tenantSlug) match
      let authorized = false;
      if (secret && secret === env.ADMIN_SYNC_SECRET) {
        authorized = true;
      } else if (signature) {
        const expected = crypto
          .createHmac('sha256', env.ADMIN_SYNC_SECRET)
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

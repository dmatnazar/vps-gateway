import type { FastifyInstance } from 'fastify';
import { syncSchemaHandler } from './sync.controller';
import {
  catalogHandler,
  syncStaffHandler,
  staffLookupHandler,
  staffVerifyHandler,
  createRegistrationHandler,
  listRegistrationsHandler,
  resolveRegistrationHandler,
  updateRegistrationHandler,
  getRegistrationHandler,
  listNotificationsHandler,
  markNotificationsReadHandler,
  tenantUpdateHandler,
  endpointUpdateHandler,
  entityLockHandler,
  tenantDeleteHandler,
  staffDeleteHandler,
  deviceRegisterHandler,
  deviceStatusHandler,
  listDevicesHandler,
  approveDeviceHandler,
  updateDeviceStatusHandler,
  deleteDeviceHandler,
  createTenantHandler,
} from './hub.controller';

import { routeRegistry } from '../../core/router/routeRegistry';

export async function adminRoutes(app: FastifyInstance) {
  app.post('/api/admin/sync-schema', { preHandler: [app.verifySyncSignature] }, syncSchemaHandler);
  app.post('/api/admin/sync-staff', { preHandler: [app.verifySyncSignature] }, syncStaffHandler);
  app.get('/api/admin/catalog', { preHandler: [app.verifySyncSignature] }, catalogHandler);
  app.post('/api/admin/staff-lookup', { preHandler: [app.verifySyncSignature] }, staffLookupHandler);
  app.post('/api/admin/auth/verify', { preHandler: [app.verifySyncSignature] }, staffVerifyHandler);

  app.post('/api/admin/registrations', { preHandler: [app.verifySyncSignature] }, createRegistrationHandler);
  app.get('/api/admin/registrations', { preHandler: [app.verifySyncSignature] }, listRegistrationsHandler);
  app.get('/api/admin/registrations/:id', { preHandler: [app.verifySyncSignature] }, getRegistrationHandler);
  app.post('/api/admin/registrations/update', { preHandler: [app.verifySyncSignature] }, updateRegistrationHandler);
  app.post('/api/admin/registrations/resolve', { preHandler: [app.verifySyncSignature] }, resolveRegistrationHandler);

  app.get('/api/admin/notifications', { preHandler: [app.verifySyncSignature] }, listNotificationsHandler);
  app.post('/api/admin/notifications/read', { preHandler: [app.verifySyncSignature] }, markNotificationsReadHandler);

  app.post('/api/admin/endpoint-update', { preHandler: [app.verifySyncSignature] }, endpointUpdateHandler);

  app.post('/api/admin/tenant-update', { preHandler: [app.verifySyncSignature] }, tenantUpdateHandler);
  app.post('/api/admin/tenant-create', { preHandler: [app.verifySyncSignature] }, createTenantHandler);
  app.post('/api/admin/tenant-delete', { preHandler: [app.verifySyncSignature] }, tenantDeleteHandler);
  app.post('/api/admin/staff-delete', { preHandler: [app.verifySyncSignature] }, staffDeleteHandler);
  app.post('/api/admin/entity-lock', { preHandler: [app.verifySyncSignature] }, entityLockHandler);

  // Device Management Routes
  app.post('/api/admin/devices/register', deviceRegisterHandler);
  app.get('/api/admin/devices/status', deviceStatusHandler);
  app.get('/api/admin/devices', { preHandler: [app.verifyAdminSyncSignature] }, listDevicesHandler);
  app.post('/api/admin/devices/:id/approve', { preHandler: [app.verifyAdminSyncSignature] }, approveDeviceHandler);
  app.patch('/api/admin/devices/:id/status', { preHandler: [app.verifyAdminSyncSignature] }, updateDeviceStatusHandler);
  app.delete('/api/admin/devices/:id', { preHandler: [app.verifyAdminSyncSignature] }, deleteDeviceHandler);

  app.get('/api/admin/routes', async (_req, reply) => {
    return reply.send(routeRegistry.debugAll());
  });

  // Electron auto-update feed — BI writes, Electrons read public GET /api/client-config/update-feed
  app.get(
    '/api/admin/client-config/update-feed',
    { preHandler: [app.verifyAdminSyncSignature] },
    async (_req, reply) => {
      const { getAppSetting } = await import('../../store/sqliteDb');
      const raw = getAppSetting('update_feed');
      let cfg: any = {
        protocol: 'https',
        host: '',
        port: '',
        path: '/updates',
        username: '',
        password: '',
      };
      if (raw) {
        try {
          cfg = { ...cfg, ...JSON.parse(raw) };
        } catch {
          /* */
        }
      }
      return reply.send({ ok: true, updateFeed: cfg });
    }
  );

  app.put(
    '/api/admin/client-config/update-feed',
    { preHandler: [app.verifyAdminSyncSignature] },
    async (req, reply) => {
      const { getAppSetting, setAppSetting } = await import('../../store/sqliteDb');
      const body = (req.body || {}) as Record<string, unknown>;
      let prev: any = {};
      try {
        prev = JSON.parse(getAppSetting('update_feed') || '{}');
      } catch {
        prev = {};
      }
      const next = {
        protocol: body.protocol === 'http' ? 'http' : 'https',
        host: String(body.host || prev.host || '').trim(),
        port: body.port !== undefined && body.port !== '' ? String(body.port) : prev.port || '',
        path: String(body.path || prev.path || '/updates'),
        username: String(body.username ?? prev.username ?? ''),
        password:
          body.password !== undefined && String(body.password).length > 0
            ? String(body.password)
            : prev.password || '',
      };
      setAppSetting('update_feed', JSON.stringify(next));
      return reply.send({
        ok: true,
        updateFeed: { ...next, password: next.password ? '••••' : '' },
      });
    }
  );
}

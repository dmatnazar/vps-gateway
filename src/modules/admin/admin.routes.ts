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
  app.post('/api/admin/sync-schema', { preHandler: [app.verifyAdminSyncSignature] }, syncSchemaHandler);
  app.post('/api/admin/sync-staff', { preHandler: [app.verifyAdminSyncSignature] }, syncStaffHandler);
  app.get('/api/admin/catalog', { preHandler: [app.verifyAdminSyncSignature] }, catalogHandler);
  app.post('/api/admin/staff-lookup', { preHandler: [app.verifyAdminSyncSignature] }, staffLookupHandler);
  app.post('/api/admin/auth/verify', { preHandler: [app.verifyAdminSyncSignature] }, staffVerifyHandler);

  app.post('/api/admin/registrations', { preHandler: [app.verifyAdminSyncSignature] }, createRegistrationHandler);
  app.get('/api/admin/registrations', { preHandler: [app.verifyAdminSyncSignature] }, listRegistrationsHandler);
  app.get('/api/admin/registrations/:id', { preHandler: [app.verifyAdminSyncSignature] }, getRegistrationHandler);
  app.post('/api/admin/registrations/update', { preHandler: [app.verifyAdminSyncSignature] }, updateRegistrationHandler);
  app.post('/api/admin/registrations/resolve', { preHandler: [app.verifyAdminSyncSignature] }, resolveRegistrationHandler);

  app.get('/api/admin/notifications', { preHandler: [app.verifyAdminSyncSignature] }, listNotificationsHandler);
  app.post('/api/admin/notifications/read', { preHandler: [app.verifyAdminSyncSignature] }, markNotificationsReadHandler);

  app.post('/api/admin/endpoint-update', { preHandler: [app.verifyAdminSyncSignature] }, endpointUpdateHandler);

  app.post('/api/admin/tenant-update', { preHandler: [app.verifyAdminSyncSignature] }, tenantUpdateHandler);
  app.post('/api/admin/tenant-create', { preHandler: [app.verifyAdminSyncSignature] }, createTenantHandler);
  app.post('/api/admin/tenant-delete', { preHandler: [app.verifyAdminSyncSignature] }, tenantDeleteHandler);
  app.post('/api/admin/staff-delete', { preHandler: [app.verifyAdminSyncSignature] }, staffDeleteHandler);
  app.post('/api/admin/entity-lock', { preHandler: [app.verifyAdminSyncSignature] }, entityLockHandler);

  // Device Management Routes
  app.post('/api/admin/devices/register', { preHandler: [app.verifyAdminSyncSignature] }, deviceRegisterHandler);
  app.get('/api/admin/devices/status', { preHandler: [app.verifyAdminSyncSignature] }, deviceStatusHandler);
  app.get('/api/admin/devices', { preHandler: [app.verifyAdminSyncSignature] }, listDevicesHandler);
  app.post('/api/admin/devices/:id/approve', { preHandler: [app.verifyAdminSyncSignature] }, approveDeviceHandler);
  app.patch('/api/admin/devices/:id/status', { preHandler: [app.verifyAdminSyncSignature] }, updateDeviceStatusHandler);
  app.delete('/api/admin/devices/:id', { preHandler: [app.verifyAdminSyncSignature] }, deleteDeviceHandler);

  app.get('/api/admin/routes', async (_req, reply) => {
    return reply.send(routeRegistry.debugAll());
  });
}

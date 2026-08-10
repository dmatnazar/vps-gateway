import type { FastifyInstance } from 'fastify';
import { syncSchemaHandler } from './sync.controller';
import {
  catalogHandler,
  syncStaffHandler,
  staffLookupHandler,
  createRegistrationHandler,
  listRegistrationsHandler,
  resolveRegistrationHandler,
  updateRegistrationHandler,
  getRegistrationHandler,
  listNotificationsHandler,
  markNotificationsReadHandler,
  tenantUpdateHandler,
  endpointUpdateHandler,
} from './hub.controller';

import { routeRegistry } from '../../core/router/routeRegistry';

export async function adminRoutes(app: FastifyInstance) {
  app.post('/api/admin/sync-schema', { preHandler: [app.verifyAdminSyncSignature] }, syncSchemaHandler);
  app.post('/api/admin/sync-staff', { preHandler: [app.verifyAdminSyncSignature] }, syncStaffHandler);
  app.get('/api/admin/catalog', { preHandler: [app.verifyAdminSyncSignature] }, catalogHandler);
  app.post('/api/admin/staff-lookup', { preHandler: [app.verifyAdminSyncSignature] }, staffLookupHandler);

  app.post('/api/admin/registrations', { preHandler: [app.verifyAdminSyncSignature] }, createRegistrationHandler);
  app.get('/api/admin/registrations', { preHandler: [app.verifyAdminSyncSignature] }, listRegistrationsHandler);
  app.get('/api/admin/registrations/:id', { preHandler: [app.verifyAdminSyncSignature] }, getRegistrationHandler);
  app.post('/api/admin/registrations/update', { preHandler: [app.verifyAdminSyncSignature] }, updateRegistrationHandler);
  app.post('/api/admin/registrations/resolve', { preHandler: [app.verifyAdminSyncSignature] }, resolveRegistrationHandler);

  app.get('/api/admin/notifications', { preHandler: [app.verifyAdminSyncSignature] }, listNotificationsHandler);
  app.post('/api/admin/notifications/read', { preHandler: [app.verifyAdminSyncSignature] }, markNotificationsReadHandler);

  app.post('/api/admin/endpoint-update', { preHandler: [app.verifyAdminSyncSignature] }, endpointUpdateHandler);

  app.post('/api/admin/tenant-update', { preHandler: [app.verifyAdminSyncSignature] }, tenantUpdateHandler);

  app.get('/api/admin/routes', async (_req, reply) => {
    return reply.send(routeRegistry.debugAll());
  });
}

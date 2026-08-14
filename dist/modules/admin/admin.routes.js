"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRoutes = adminRoutes;
const sync_controller_1 = require("./sync.controller");
const hub_controller_1 = require("./hub.controller");
const routeRegistry_1 = require("../../core/router/routeRegistry");
async function adminRoutes(app) {
    app.post('/api/admin/sync-schema', { preHandler: [app.verifyAdminSyncSignature] }, sync_controller_1.syncSchemaHandler);
    app.post('/api/admin/sync-staff', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.syncStaffHandler);
    app.get('/api/admin/catalog', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.catalogHandler);
    app.post('/api/admin/staff-lookup', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.staffLookupHandler);
    app.post('/api/admin/registrations', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.createRegistrationHandler);
    app.get('/api/admin/registrations', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.listRegistrationsHandler);
    app.get('/api/admin/registrations/:id', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.getRegistrationHandler);
    app.post('/api/admin/registrations/update', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.updateRegistrationHandler);
    app.post('/api/admin/registrations/resolve', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.resolveRegistrationHandler);
    app.get('/api/admin/notifications', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.listNotificationsHandler);
    app.post('/api/admin/notifications/read', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.markNotificationsReadHandler);
    app.post('/api/admin/endpoint-update', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.endpointUpdateHandler);
    app.post('/api/admin/tenant-update', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.tenantUpdateHandler);
    app.post('/api/admin/tenant-delete', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.tenantDeleteHandler);
    app.post('/api/admin/staff-delete', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.staffDeleteHandler);
    app.post('/api/admin/entity-lock', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.entityLockHandler);
    app.get('/api/admin/routes', async (_req, reply) => {
        return reply.send(routeRegistry_1.routeRegistry.debugAll());
    });
}
//# sourceMappingURL=admin.routes.js.map
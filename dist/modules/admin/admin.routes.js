"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRoutes = adminRoutes;
const sync_controller_1 = require("./sync.controller");
const hub_controller_1 = require("./hub.controller");
const billing_controller_1 = require("./billing.controller");
const routeRegistry_1 = require("../../core/router/routeRegistry");
async function adminRoutes(app) {
    app.post('/api/admin/sync-schema', { preHandler: [app.verifySyncSignature] }, sync_controller_1.syncSchemaHandler);
    app.post('/api/admin/sync-staff', { preHandler: [app.verifySyncSignature] }, hub_controller_1.syncStaffHandler);
    app.get('/api/admin/catalog', { preHandler: [app.verifySyncSignature] }, hub_controller_1.catalogHandler);
    app.post('/api/admin/staff-lookup', { preHandler: [app.verifySyncSignature] }, hub_controller_1.staffLookupHandler);
    app.post('/api/admin/auth/verify', { preHandler: [app.verifySyncSignature] }, hub_controller_1.staffVerifyHandler);
    app.post('/api/admin/registrations', { preHandler: [app.verifySyncSignature] }, hub_controller_1.createRegistrationHandler);
    app.get('/api/admin/registrations', { preHandler: [app.verifySyncSignature] }, hub_controller_1.listRegistrationsHandler);
    app.get('/api/admin/registrations/:id', { preHandler: [app.verifySyncSignature] }, hub_controller_1.getRegistrationHandler);
    app.post('/api/admin/registrations/update', { preHandler: [app.verifySyncSignature] }, hub_controller_1.updateRegistrationHandler);
    app.post('/api/admin/registrations/resolve', { preHandler: [app.verifySyncSignature] }, hub_controller_1.resolveRegistrationHandler);
    app.get('/api/admin/notifications', { preHandler: [app.verifySyncSignature] }, hub_controller_1.listNotificationsHandler);
    app.post('/api/admin/notifications/read', { preHandler: [app.verifySyncSignature] }, hub_controller_1.markNotificationsReadHandler);
    app.post('/api/admin/endpoint-update', { preHandler: [app.verifySyncSignature] }, hub_controller_1.endpointUpdateHandler);
    app.post('/api/admin/endpoint-create', { preHandler: [app.verifySyncSignature] }, hub_controller_1.endpointCreateHandler);
    app.post('/api/admin/endpoint-delete', { preHandler: [app.verifySyncSignature] }, hub_controller_1.endpointDeleteHandler);
    // BI admin signature variants
    app.post('/api/admin/endpoint-create/admin', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.endpointCreateHandler);
    app.post('/api/admin/endpoint-update/admin', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.endpointUpdateHandler);
    app.post('/api/admin/endpoint-delete/admin', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.endpointDeleteHandler);
    app.post('/api/admin/tenant-update', { preHandler: [app.verifySyncSignature] }, hub_controller_1.tenantUpdateHandler);
    app.post('/api/admin/tenant-create', { preHandler: [app.verifySyncSignature] }, hub_controller_1.createTenantHandler);
    app.post('/api/admin/tenant-delete', { preHandler: [app.verifySyncSignature] }, hub_controller_1.tenantDeleteHandler);
    app.post('/api/admin/staff-delete', { preHandler: [app.verifySyncSignature] }, hub_controller_1.staffDeleteHandler);
    app.post('/api/admin/staff-upsert', { preHandler: [app.verifySyncSignature] }, hub_controller_1.staffUpsertHandler);
    app.post('/api/admin/staff-upsert/admin', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.staffUpsertHandler);
    app.post('/api/admin/entity-lock', { preHandler: [app.verifySyncSignature] }, hub_controller_1.entityLockHandler);
    // Device settings (Firma Sazlamalary) — BI (admin) & Electron (device signature)
    app.get('/api/admin/device-settings', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.deviceSettingsGetHandler);
    app.put('/api/admin/device-settings', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.deviceSettingsUpsertHandler);
    app.post('/api/admin/device-settings', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.deviceSettingsUpsertHandler);
    // Remote commands: restart Electron / check update
    app.post('/api/admin/device-command', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.deviceCommandHandler);
    // Electron device can also push/pull own settings
    app.get('/api/admin/device-settings/self', { preHandler: [app.verifySyncSignature] }, hub_controller_1.deviceSettingsGetHandler);
    app.put('/api/admin/device-settings/self', { preHandler: [app.verifySyncSignature] }, hub_controller_1.deviceSettingsUpsertHandler);
    app.post('/api/admin/device-settings/self', { preHandler: [app.verifySyncSignature] }, hub_controller_1.deviceSettingsUpsertHandler);
    // Admin ad-hoc SQL test (Electron agent tunnel)
    app.post('/api/admin/test-query', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.testQueryHandler);
    // DB connections CRUD (BI)
    app.post('/api/admin/connection-upsert', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.connectionUpsertHandler);
    app.post('/api/admin/connection-delete', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.connectionDeleteHandler);
    // Electron device signature variants
    app.post('/api/admin/connection-upsert/self', { preHandler: [app.verifySyncSignature] }, hub_controller_1.connectionUpsertHandler);
    app.post('/api/admin/connection-delete/self', { preHandler: [app.verifySyncSignature] }, hub_controller_1.connectionDeleteHandler);
    app.post('/api/admin/staff-password-reset', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.staffPasswordResetHandler);
    // Billing / tariffs / wallets (BI admin)
    app.get('/api/admin/billing/overview', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.billingOverviewHandler);
    app.get('/api/admin/billing/tariffs', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.listTariffsHandler);
    app.post('/api/admin/billing/tariff-upsert', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.tariffUpsertHandler);
    app.post('/api/admin/billing/assign-tariff', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.assignTariffHandler);
    app.post('/api/admin/billing/topup', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.topUpHandler);
    app.post('/api/admin/billing/adjust', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.adjustBalanceHandler);
    app.get('/api/admin/billing/ledger', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.ledgerHandler);
    app.post('/api/admin/billing/consume', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.consumeApiHttpHandler);
    app.get('/api/admin/billing/wallet', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.walletGetHandler);
    // Device/Electron can read own wallet (optional)
    app.get('/api/admin/billing/wallet/self', { preHandler: [app.verifySyncSignature] }, billing_controller_1.walletGetHandler);
    app.post('/api/admin/billing/request-tariff-change', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.requestTariffChangeHandler);
    app.post('/api/admin/billing/request-tariff-change/self', { preHandler: [app.verifySyncSignature] }, billing_controller_1.requestTariffChangeHandler);
    app.get('/api/admin/billing/tariff-requests', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.listTariffRequestsHandler);
    app.post('/api/admin/billing/resolve-tariff-request', { preHandler: [app.verifyAdminSyncSignature] }, billing_controller_1.resolveTariffRequestHandler);
    // Device Management Routes
    app.post('/api/admin/devices/register', hub_controller_1.deviceRegisterHandler);
    app.get('/api/admin/devices/status', hub_controller_1.deviceStatusHandler);
    app.get('/api/admin/devices', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.listDevicesHandler);
    app.post('/api/admin/devices/:id/approve', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.approveDeviceHandler);
    app.patch('/api/admin/devices/:id/status', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.updateDeviceStatusHandler);
    app.delete('/api/admin/devices/:id', { preHandler: [app.verifyAdminSyncSignature] }, hub_controller_1.deleteDeviceHandler);
    app.get('/api/admin/routes', async (_req, reply) => {
        return reply.send(routeRegistry_1.routeRegistry.debugAll());
    });
    // Electron auto-update feed — BI writes, Electrons read public GET /api/client-config/update-feed
    app.get('/api/admin/client-config/update-feed', { preHandler: [app.verifyAdminSyncSignature] }, async (_req, reply) => {
        const { getAppSetting } = await Promise.resolve().then(() => __importStar(require('../../store/sqliteDb')));
        const raw = getAppSetting('update_feed');
        let cfg = {
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
            }
            catch {
                /* */
            }
        }
        return reply.send({ ok: true, updateFeed: cfg });
    });
    app.put('/api/admin/client-config/update-feed', { preHandler: [app.verifyAdminSyncSignature] }, async (req, reply) => {
        const { getAppSetting, setAppSetting } = await Promise.resolve().then(() => __importStar(require('../../store/sqliteDb')));
        const body = (req.body || {});
        let prev = {};
        try {
            prev = JSON.parse(getAppSetting('update_feed') || '{}');
        }
        catch {
            prev = {};
        }
        // port: explicit empty string means "default (omit from URL)" — do not fall back to prev 443
        const portRaw = body.port;
        const portNext = portRaw === undefined
            ? prev.port || ''
            : String(portRaw).trim() === ''
                ? ''
                : String(portRaw).trim();
        const next = {
            protocol: body.protocol === 'http' ? 'http' : 'https',
            host: String(body.host || prev.host || '').trim(),
            port: portNext,
            path: String(body.path || prev.path || '/updates'),
            username: String(body.username ?? prev.username ?? ''),
            password: body.password !== undefined && String(body.password).length > 0
                ? String(body.password)
                : prev.password || '',
        };
        setAppSetting('update_feed', JSON.stringify(next));
        return reply.send({
            ok: true,
            updateFeed: { ...next, password: next.password ? '••••' : '' },
        });
    });
    // BI publishes its GATEWAY_URL so Electrons can adopt it on sync
    app.put('/api/admin/client-config/gateway-url', { preHandler: [app.verifyAdminSyncSignature] }, async (req, reply) => {
        const { setAppSetting, getAppSetting } = await Promise.resolve().then(() => __importStar(require('../../store/sqliteDb')));
        const body = (req.body || {});
        const url = String(body.gatewayUrl || '')
            .trim()
            .replace(/\/$/, '');
        if (!url) {
            return reply.code(400).send({ error: 'gatewayUrl required' });
        }
        setAppSetting('public_gateway_url', url);
        return reply.send({
            ok: true,
            gatewayUrl: getAppSetting('public_gateway_url') || url,
        });
    });
}
//# sourceMappingURL=admin.routes.js.map
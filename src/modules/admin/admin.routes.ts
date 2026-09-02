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
  endpointCreateHandler,
  endpointDeleteHandler,
  entityLockHandler,
  tenantDeleteHandler,
  staffDeleteHandler,
  staffUpsertHandler,
  deviceRegisterHandler,
  deviceStatusHandler,
  listDevicesHandler,
  approveDeviceHandler,
  updateDeviceStatusHandler,
  deleteDeviceHandler,
  createTenantHandler,
  deviceSettingsGetHandler,
  deviceSettingsUpsertHandler,
  deviceCommandHandler,
  testQueryHandler,
  connectionUpsertHandler,
  connectionDeleteHandler,
  staffPasswordResetHandler,
} from './hub.controller';
import {
  billingOverviewHandler,
  listTariffsHandler,
  tariffUpsertHandler,
  assignTariffHandler,
  topUpHandler,
  adjustBalanceHandler,
  ledgerHandler,
  walletGetHandler,
  consumeApiHttpHandler,
  requestTariffChangeHandler,
  listTariffRequestsHandler,
  resolveTariffRequestHandler,
} from './billing.controller';

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
  app.post('/api/admin/endpoint-create', { preHandler: [app.verifySyncSignature] }, endpointCreateHandler);
  app.post('/api/admin/endpoint-delete', { preHandler: [app.verifySyncSignature] }, endpointDeleteHandler);
  // BI admin signature variants
  app.post('/api/admin/endpoint-create/admin', { preHandler: [app.verifyAdminSyncSignature] }, endpointCreateHandler);
  app.post('/api/admin/endpoint-update/admin', { preHandler: [app.verifyAdminSyncSignature] }, endpointUpdateHandler);
  app.post('/api/admin/endpoint-delete/admin', { preHandler: [app.verifyAdminSyncSignature] }, endpointDeleteHandler);

  app.post('/api/admin/tenant-update', { preHandler: [app.verifySyncSignature] }, tenantUpdateHandler);
  app.post('/api/admin/tenant-create', { preHandler: [app.verifySyncSignature] }, createTenantHandler);
  app.post('/api/admin/tenant-delete', { preHandler: [app.verifySyncSignature] }, tenantDeleteHandler);
  app.post('/api/admin/staff-delete', { preHandler: [app.verifySyncSignature] }, staffDeleteHandler);
  app.post('/api/admin/staff-upsert', { preHandler: [app.verifySyncSignature] }, staffUpsertHandler);
  app.post('/api/admin/staff-upsert/admin', { preHandler: [app.verifyAdminSyncSignature] }, staffUpsertHandler);
  app.post('/api/admin/entity-lock', { preHandler: [app.verifySyncSignature] }, entityLockHandler);

  // Device settings (Firma Sazlamalary) — BI (admin) & Electron (device signature)
  app.get('/api/admin/device-settings', { preHandler: [app.verifyAdminSyncSignature] }, deviceSettingsGetHandler);
  app.put('/api/admin/device-settings', { preHandler: [app.verifyAdminSyncSignature] }, deviceSettingsUpsertHandler);
  app.post('/api/admin/device-settings', { preHandler: [app.verifyAdminSyncSignature] }, deviceSettingsUpsertHandler);
  // Remote commands: restart Electron / check update
  app.post('/api/admin/device-command', { preHandler: [app.verifyAdminSyncSignature] }, deviceCommandHandler);
  // Electron device can also push/pull own settings
  app.get('/api/admin/device-settings/self', { preHandler: [app.verifySyncSignature] }, deviceSettingsGetHandler);
  app.put('/api/admin/device-settings/self', { preHandler: [app.verifySyncSignature] }, deviceSettingsUpsertHandler);
  app.post('/api/admin/device-settings/self', { preHandler: [app.verifySyncSignature] }, deviceSettingsUpsertHandler);

  // Admin ad-hoc SQL test (Electron agent tunnel)
  app.post('/api/admin/test-query', { preHandler: [app.verifyAdminSyncSignature] }, testQueryHandler);

  // DB connections CRUD (BI)
  app.post('/api/admin/connection-upsert', { preHandler: [app.verifyAdminSyncSignature] }, connectionUpsertHandler);
  app.post('/api/admin/connection-delete', { preHandler: [app.verifyAdminSyncSignature] }, connectionDeleteHandler);
  // Electron device signature variants
  app.post('/api/admin/connection-upsert/self', { preHandler: [app.verifySyncSignature] }, connectionUpsertHandler);
  app.post('/api/admin/connection-delete/self', { preHandler: [app.verifySyncSignature] }, connectionDeleteHandler);
  app.post('/api/admin/staff-password-reset', { preHandler: [app.verifyAdminSyncSignature] }, staffPasswordResetHandler);


  // Billing / tariffs / wallets (BI admin)
  app.get('/api/admin/billing/overview', { preHandler: [app.verifyAdminSyncSignature] }, billingOverviewHandler);
  app.get('/api/admin/billing/tariffs', { preHandler: [app.verifyAdminSyncSignature] }, listTariffsHandler);
  app.post('/api/admin/billing/tariff-upsert', { preHandler: [app.verifyAdminSyncSignature] }, tariffUpsertHandler);
  app.post('/api/admin/billing/assign-tariff', { preHandler: [app.verifyAdminSyncSignature] }, assignTariffHandler);
  app.post('/api/admin/billing/topup', { preHandler: [app.verifyAdminSyncSignature] }, topUpHandler);
  app.post('/api/admin/billing/adjust', { preHandler: [app.verifyAdminSyncSignature] }, adjustBalanceHandler);
  app.get('/api/admin/billing/ledger', { preHandler: [app.verifyAdminSyncSignature] }, ledgerHandler);
  app.post('/api/admin/billing/consume', { preHandler: [app.verifyAdminSyncSignature] }, consumeApiHttpHandler);
  app.get('/api/admin/billing/wallet', { preHandler: [app.verifyAdminSyncSignature] }, walletGetHandler);
  // Device/Electron can read own wallet (optional)
  app.get('/api/admin/billing/wallet/self', { preHandler: [app.verifySyncSignature] }, walletGetHandler);
  app.post('/api/admin/billing/request-tariff-change', { preHandler: [app.verifyAdminSyncSignature] }, requestTariffChangeHandler);
  app.post('/api/admin/billing/request-tariff-change/self', { preHandler: [app.verifySyncSignature] }, requestTariffChangeHandler);
  app.get('/api/admin/billing/tariff-requests', { preHandler: [app.verifyAdminSyncSignature] }, listTariffRequestsHandler);
  app.post('/api/admin/billing/resolve-tariff-request', { preHandler: [app.verifyAdminSyncSignature] }, resolveTariffRequestHandler);

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
      // port: explicit empty string means "default (omit from URL)" — do not fall back to prev 443
      const portRaw = body.port;
      const portNext =
        portRaw === undefined
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

  // BI publishes its GATEWAY_URL so Electrons can adopt it on sync
  app.put(
    '/api/admin/client-config/gateway-url',
    { preHandler: [app.verifyAdminSyncSignature] },
    async (req, reply) => {
      const { setAppSetting, getAppSetting } = await import('../../store/sqliteDb');
      const body = (req.body || {}) as { gatewayUrl?: string };
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
    }
  );
}

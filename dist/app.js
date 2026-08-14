"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
const fastify_1 = __importDefault(require("fastify"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const websocket_1 = __importDefault(require("@fastify/websocket"));
const auth_plugin_1 = require("./plugins/auth.plugin");
const admin_routes_1 = require("./modules/admin/admin.routes");
const health_routes_1 = require("./modules/health/health.routes");
const agent_routes_1 = require("./modules/agent/agent.routes");
const dynamicRouter_1 = require("./core/router/dynamicRouter");
const avatar_routes_1 = require("./modules/avatar/avatar.routes");
const routeRegistry_1 = require("./core/router/routeRegistry");
const tenant_repository_1 = require("./modules/tenant/tenant.repository");
/**
 * Restart-dan soň route-lary diskden (lowdb) gaýtadan ýükle.
 * Sync diňe RAM-a ýazýardy — bootstrap bolmasa ähli API "Endpoint not found" berýär.
 */
async function bootstrapRoutes(app) {
    try {
        const endpoints = await tenant_repository_1.tenantRepository.listAllEndpoints();
        const byTenant = new Map();
        for (const ep of endpoints) {
            const slug = ep.tenantSlug;
            if (!slug)
                continue;
            if (!byTenant.has(slug))
                byTenant.set(slug, []);
            byTenant.get(slug).push(ep);
        }
        let total = 0;
        for (const [slug, eps] of byTenant) {
            routeRegistry_1.routeRegistry.replaceTenantRoutes(slug, eps.map((e) => ({
                ...e,
                tenantSlug: slug,
                dbKey: e.dbKey || 'primary',
            })));
            total += eps.length;
        }
        app.log.info(`📦 Bootstrapped ${total} endpoint(s) across ${byTenant.size} tenant(s) from disk`);
    }
    catch (err) {
        app.log.error({ err }, 'Failed to bootstrap routes from disk');
    }
}
async function buildApp() {
    const app = (0, fastify_1.default)({ logger: true });
    app.addHook('onRequest', async (req, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Signature,Authorization,X-Api-Key');
        if (req.method === 'OPTIONS') {
            await reply.code(204).send();
        }
    });
    await app.register(rate_limit_1.default, { max: 200, timeWindow: '1 minute' });
    await app.register(websocket_1.default);
    await app.register(auth_plugin_1.authPlugin);
    await app.register(health_routes_1.healthRoutes);
    await app.register(admin_routes_1.adminRoutes);
    await app.register(agent_routes_1.agentRoutes);
    await (0, avatar_routes_1.registerAvatarRoutes)(app);
    await (0, dynamicRouter_1.registerDynamicRouter)(app);
    // Diskden route-lary ýükle (restart-dan soň hem işleýär)
    await bootstrapRoutes(app);
    return app;
}
//# sourceMappingURL=app.js.map
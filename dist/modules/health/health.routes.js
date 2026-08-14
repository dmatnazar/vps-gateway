"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRoutes = healthRoutes;
async function healthRoutes(app) {
    app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
}
//# sourceMappingURL=health.routes.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("./config/env");
const app_1 = require("./app");
async function main() {
    const app = await (0, app_1.buildApp)();
    try {
        await app.listen({ port: env_1.env.PORT, host: env_1.env.HOST });
        app.log.info(`🚀 Gateway running at http://${env_1.env.HOST}:${env_1.env.PORT}`);
        app.log.info(`   Health check:   http://localhost:${env_1.env.PORT}/health`);
        app.log.info(`   Sync endpoint:  POST http://localhost:${env_1.env.PORT}/api/admin/sync-schema`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=server.js.map
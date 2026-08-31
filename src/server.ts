import { env } from './config/env';
import { buildApp } from './app';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`🚀 Gateway running at http://${env.HOST}:${env.PORT}`);
    app.log.info(`   Health check:   http://localhost:${env.PORT}/health`);
    app.log.info(`   Sync endpoint:  POST http://localhost:${env.PORT}/api/admin/sync-schema`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

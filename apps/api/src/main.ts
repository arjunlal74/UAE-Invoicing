import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './logger.js';
import { closeQueues } from './queue/queues.js';

/**
 * HTTP API entrypoint. The worker runs the same codebase from worker.ts.
 */
async function main() {
  const cfg = config();

  // Migrating on boot is right for a single-writer deployment and for local
  // development. Multi-replica production should run this as a separate
  // pre-deploy step so that N replicas do not race; the runner is idempotent
  // and transactional, so a race is safe rather than merely unlikely.
  if (process.env.RUN_MIGRATIONS !== 'false') {
    await runMigrations();
  }

  const app = await buildApp();

  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
  logger.info({ port: cfg.API_PORT, env: cfg.NODE_ENV }, 'api listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeQueues();
      await closeDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start api');
  process.exit(1);
});

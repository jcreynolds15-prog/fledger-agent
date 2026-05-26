import { loadConfig } from './config';
import { logger, setLogLevel } from './logger';
import { FledgerAgent } from './agent';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  logger.info('═══════════════════════════════════════════');
  logger.info('  Fledger Connector Agent  v1.0.0');
  logger.info('═══════════════════════════════════════════');
  logger.info(`  Server  : ${cfg.serverUrl}`);
  logger.info(`  DB host : ${cfg.sql.server}:${cfg.sql.port}`);
  logger.info(`  Database: ${cfg.sql.database}`);
  logger.info(`  Site    : ${cfg.sql.site || '(all)'}`);
  logger.info('─────────────────────────────────────────────');

  const agent = new FledgerAgent(cfg);
  agent.start();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal} — shutting down`);
    agent.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('Failed to start agent:', err);
  process.exit(1);
});

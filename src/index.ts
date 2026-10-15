import * as path from 'path';
import { AgentConfig, ConfigError, loadConfig, sqlLogin, sqlTarget } from './config';
import { logger, logToFiles, setLogLevel } from './logger';
import { ApAutomationAgent } from './agent';
import { selfTest } from './self-test';
import { EXIT_BAD_SETTINGS, supervise } from './supervisor';
import { AGENT_NAME, AGENT_VERSION, homeDir } from './paths';

const USAGE = `${AGENT_NAME} ${AGENT_VERSION}

  ap-automation-agent.exe            run in this window (Ctrl+C to stop)
  ap-automation-agent.exe --test     check the settings in agent.env, then exit
  ap-automation-agent.exe --service  run in the background, restarting if it stops
                                     (what the scheduled task created by install.cmd runs)
  --config <file>                    read settings from <file> instead of agent.env
`;

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes('--version')) {
    console.log(`${AGENT_NAME} ${AGENT_VERSION}`);
    return;
  }
  if (argv.includes('--help') || argv.includes('/?')) {
    console.log(USAGE);
    return;
  }

  if (!argv.includes('--test')) logToFiles(path.join(homeDir(), 'logs'));

  if (argv.includes('--service')) {
    logger.info(`${AGENT_NAME} ${AGENT_VERSION} starting in the background`);
    supervise(argv);
    return;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig(argv);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error(`Settings problem: ${err.message}`);
    process.exit(EXIT_BAD_SETTINGS);
  }
  setLogLevel(cfg.logLevel);

  if (argv.includes('--test')) {
    const ok = await selfTest(cfg);
    process.exit(ok ? 0 : 1);
  }

  logger.info('═══════════════════════════════════════════');
  logger.info(`  ${AGENT_NAME}  v${AGENT_VERSION}`);
  logger.info('═══════════════════════════════════════════');
  logger.info(`  Server  : ${cfg.serverUrl}${cfg.proxyUrl ? ' (through the proxy)' : ''}`);
  if (cfg.ido) logger.info(`  IDO     : ${cfg.ido.url} as ${cfg.ido.user} (configuration ${cfg.ido.config})`);
  if (cfg.sql) logger.info(`  SQL     : ${sqlTarget(cfg.sql)} / ${cfg.sql.database} as ${sqlLogin(cfg.sql)}, site ${cfg.sql.site || '(the only one)'}`);
  logger.info(`  Vouchers: ${cfg.allowVouchers ? 'posting allowed' : 'posting off'}`);
  logger.info(`  Settings: ${cfg.file ?? '(environment)'}`);
  logger.info('─────────────────────────────────────────────');

  const agent = new ApAutomationAgent(cfg);
  agent.start();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal} — shutting down`);
    agent.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  // Started by --service: stop when it does.
  if (process.send) process.on('disconnect', () => shutdown('service stop'));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  logger.error('Failed to start agent:', err);
  process.exit(1);
});

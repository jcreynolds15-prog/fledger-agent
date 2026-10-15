/**
 * `--service`: what the Windows scheduled task runs. Keeps one agent process
 * running and starts it again if it stops, so a crash at 2am does not leave
 * invoices waiting until someone notices.
 */
import { spawn, ChildProcess } from 'child_process';
import { logger } from './logger';
import { isPackaged } from './paths';

/** Exit code the agent uses when agent.env is wrong: no point retrying quickly */
export const EXIT_BAD_SETTINGS = 2;

export function supervise(argv: string[]): void {
  const passOn = argv.slice(2).filter((a) => a !== '--service');
  // The packaged .exe is the script; under plain Node the script is argv[1].
  const args = [...(isPackaged() ? [] : [argv[1]]), '--worker', ...passOn];

  let child: ChildProcess | null = null;
  let stopping = false;
  let quickExits = 0;

  const start = () => {
    const startedAt = Date.now();
    child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      quickExits = Date.now() - startedAt > 10 * 60_000 ? 0 : quickExits + 1;
      const wait =
        code === EXIT_BAD_SETTINGS ? 5 * 60_000 : Math.min(60_000, 2_000 * 2 ** Math.min(quickExits, 5));
      logger.warn(`The agent stopped (${signal ?? `exit code ${code}`}) — starting it again in ${Math.round(wait / 1000)}s`);
      setTimeout(start, wait);
    });
  };

  const shutdown = () => {
    stopping = true;
    child?.kill();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  start();
}

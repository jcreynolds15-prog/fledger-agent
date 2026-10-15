import * as fs from 'fs';
import * as path from 'path';
import { format } from 'util';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

/** Log files older than this are removed */
const KEEP_DAYS = 14;

let currentLevel: Level = 'info';
let logDir: string | null = null;

export function setLogLevel(level: string): void {
  if (level in LEVELS) currentLevel = level as Level;
}

/** Also write the log to <dir>/agent-YYYY-MM-DD.log, one file per day. */
export function logToFiles(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logDir = dir;
    pruneOldLogs(dir);
  } catch (err) {
    console.error(`Cannot write logs to ${dir}:`, err);
  }
}

function pruneOldLogs(dir: string): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of fs.readdirSync(dir)) {
    if (!/^agent-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const file = path.join(dir, name);
    if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}

function ts(): string {
  return new Date().toISOString();
}

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const prefix = `[${ts()}] [${level.toUpperCase().padEnd(5)}]`;
  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
  if (logDir) {
    try {
      const file = path.join(logDir, `agent-${ts().slice(0, 10)}.log`);
      fs.appendFileSync(file, `${prefix} ${format(...args)}\r\n`);
    } catch {
      /* a full disk must not stop the agent */
    }
  }
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info:  (...args: unknown[]) => log('info',  ...args),
  warn:  (...args: unknown[]) => log('warn',  ...args),
  error: (...args: unknown[]) => log('error', ...args),
};

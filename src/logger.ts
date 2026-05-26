const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = 'info';

export function setLogLevel(level: string): void {
  if (level in LEVELS) currentLevel = level as Level;
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
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info:  (...args: unknown[]) => log('info',  ...args),
  warn:  (...args: unknown[]) => log('warn',  ...args),
  error: (...args: unknown[]) => log('error', ...args),
};

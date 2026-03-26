/**
 * Простой логгер для медиа-моста
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const LOG_LEVEL: Level = (process.env['LOG_LEVEL'] as Level) || 'info';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function write(level: Level, msg: string): void {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;

  const prefix = `[${ts()}] [${level.toUpperCase().padEnd(5)}]`;
  if (level === 'error') {
    console.error(`${prefix} ${msg}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${msg}`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export const log = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
};

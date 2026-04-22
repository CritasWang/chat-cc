import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pino, type Logger } from 'pino';

let root: Logger | undefined;

export interface LoggerOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  filePath?: string;
}

export function initLogger(opts: LoggerOptions | LoggerOptions['level']): Logger {
  const { level, filePath } = typeof opts === 'string' ? { level: opts, filePath: undefined } : opts;

  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    const dest = createWriteStream(filePath, { flags: 'a' });
    root = pino({ level }, dest);
  } else {
    root = pino({
      level,
      transport: process.stdout.isTTY
        ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', singleLine: true } }
        : undefined,
    });
  }
  return root;
}

export function log(): Logger {
  if (!root) throw new Error('logger not initialized; call initLogger first');
  return root;
}

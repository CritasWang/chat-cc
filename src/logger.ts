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

  const timestamp = (): string => {
    const d = new Date();
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    return `,"time":"${ts}"`;
  };

  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    const dest = createWriteStream(filePath, { flags: 'a' });
    root = pino({ level, timestamp }, dest);
  } else {
    root = pino({
      level,
      timestamp,
      transport: process.stdout.isTTY
        ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', singleLine: true } }
        : undefined,
    });
  }
  return root;
}

function p(n: number): string {
  return String(n).padStart(2, '0');
}

export function log(): Logger {
  if (!root) throw new Error('logger not initialized; call initLogger first');
  return root;
}

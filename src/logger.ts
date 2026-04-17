import { pino, type Logger } from 'pino';

let root: Logger | undefined;

export function initLogger(level: 'debug' | 'info' | 'warn' | 'error'): Logger {
  root = pino({
    level,
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', singleLine: true } }
      : undefined,
  });
  return root;
}

export function log(): Logger {
  if (!root) throw new Error('logger not initialized; call initLogger first');
  return root;
}

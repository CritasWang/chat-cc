import { chmodSync, closeSync, createWriteStream, mkdirSync, openSync } from 'node:fs';
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
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    // createWriteStream 对已存在文件不会收紧权限，先显式创建/修正为 0600。
    const fd = openSync(filePath, 'a', 0o600);
    closeSync(fd);
    try { chmodSync(filePath, 0o600); } catch { /* Windows/只读 FS 尽力而为 */ }
    const dest = createWriteStream(filePath, { flags: 'a', mode: 0o600 });
    root = pino({ level, timestamp, redact: REDACT_OPTIONS }, dest);
  } else {
    root = pino({
      level,
      timestamp,
      redact: REDACT_OPTIONS,
      transport: process.stdout.isTTY
        ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', singleLine: true } }
        : undefined,
    });
  }
  return root;
}

const REDACT_OPTIONS = {
  censor: '[REDACTED]',
  paths: [
    'app_secret',
    'appSecret',
    'token',
    'access_token',
    'tenant_access_token',
    'authorization',
    '*.app_secret',
    '*.appSecret',
    '*.token',
    '*.access_token',
    '*.tenant_access_token',
    '*.authorization',
    'err.config.headers.authorization',
    'err.config.headers.Authorization',
    'err.response.config.headers.authorization',
    'err.response.config.headers.Authorization',
  ],
};

function p(n: number): string {
  return String(n).padStart(2, '0');
}

export function log(): Logger {
  if (!root) throw new Error('logger not initialized; call initLogger first');
  return root;
}

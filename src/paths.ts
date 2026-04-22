import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIR_NAME = '.chat-cc';

export function chatccHome(): string {
  return process.env['CHAT_CC_HOME'] || join(homedir(), DEFAULT_DIR_NAME);
}

export function configPath(): string {
  return process.env['CHAT_CC_CONFIG'] || join(chatccHome(), 'config.yaml');
}

export function pidPath(): string {
  return join(chatccHome(), 'chat-cc.pid');
}

export function logPath(): string {
  return join(chatccHome(), 'chat-cc.log');
}

export function sessionsDir(): string {
  return join(chatccHome(), 'sessions');
}

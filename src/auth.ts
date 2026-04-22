import type { Config } from './config.js';

/** 检查用户/群聊是否被允许使用机器人（白名单均为空时允许所有人） */
export function isAllowed(cfg: Pick<Config, 'allowed_users' | 'allowed_chats'>, senderId: string, chatId: string): boolean {
  if (cfg.allowed_users.length === 0 && cfg.allowed_chats.length === 0) return true;
  if (cfg.allowed_users.includes(senderId)) return true;
  if (cfg.allowed_chats.includes(chatId)) return true;
  return false;
}

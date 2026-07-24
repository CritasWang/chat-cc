import type { Config } from './config.js';

/** 检查用户/群聊是否被允许使用机器人；默认 fail-closed。 */
export function isAllowed(
  cfg: Pick<Config, 'allow_all_users' | 'allowed_users' | 'allowed_chats'>,
  senderId: string,
  chatId: string,
): boolean {
  if (cfg.allow_all_users) return true;
  if (cfg.allowed_users.includes(senderId)) return true;
  if (cfg.allowed_chats.includes(chatId)) return true;
  return false;
}

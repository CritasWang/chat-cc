import type { CommandFn } from './types.js';

export const statusCommand: CommandFn = async (_args, _meta, { cfg, pool }) => {
  const sessions = pool.list();
  const lines = [
    '📊 chatcc v3 状态',
    `cwd (默认): ${cfg.default_cwd}`,
    `许可用户: ${cfg.allowed_users.length || '不限'}`,
    `许可群聊: ${cfg.allowed_chats.length || '不限'}`,
    `活跃会话: ${sessions.length}`,
    `持久化目录: ${cfg.persistence_dir}`,
  ];
  return lines.join('\n');
};

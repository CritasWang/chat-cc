import { threadKey } from '../engine/pool.js';
import { senderKey, type CommandFn } from './types.js';

/**
 * /stop [threadKey]  — 中断当前活跃会话（或指定 threadKey）的当前轮
 */
export const stopCommand: CommandFn = async (args, meta, { pool }) => {
  const target = args.trim() || pool.getActive(senderKey(meta))?.threadKey ||
                 threadKey({ chatId: meta.chatId, senderId: meta.senderId });
  const sess = pool.get(target);
  if (!sess) return `会话不存在 · ${target}`;
  await sess.interrupt();
  return `🛑 已发送中断信号 · ${target}`;
};

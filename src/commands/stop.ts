import { threadKey } from '../engine/pool.js';
import { senderKey, type CommandFn } from './types.js';

/**
 * /stop [threadKey]  — 中断当前活跃会话（或指定 threadKey）的当前轮
 * interrupt 后立即 PATCH 当前直播卡片为「🛑 已中断」
 */
export const stopCommand: CommandFn = async (args, meta, { pool, streamer }) => {
  const target =
    args.trim() ||
    pool.getActive(senderKey(meta))?.threadKey ||
    threadKey({ chatId: meta.chatId, senderId: meta.senderId });
  const sess = pool.get(target);
  if (!sess) return `会话不存在 · ${target}`;
  await sess.interrupt();
  await streamer.markInterrupted(target);
  return `🛑 已中断 · ${target}`;
};

import { parseThreadKey, topicThreadKey } from '../engine/pool.js';
import { senderKey, type CommandFn } from './types.js';

/**
 * /clear（别名 /reset）— 清空当前会话的对话上下文，原地重开。
 *
 * 作用对象：话题群里 = 当前话题的会话；普通群/单聊 = 当前活跃会话。
 * 效果：丢弃 SDK sessionId（旧对话历史不再带入），同一 threadKey 重新
 * 开一个全新会话；cwd、引擎、API profile、danger 等会话设置全部保留。
 *
 * 与其他命令的区别：
 * - /session stop + start：彻底销毁再建（设置也清掉）
 * - /cd <路径>：换目录 + 重开
 * - /clear：目录不变、设置不变，只清上下文
 */
export const clearCommand: CommandFn = async (_args, meta, { pool }) => {
  const tk = meta.threadId
    ? topicThreadKey(meta.chatId, meta.threadId)
    : pool.activeThreadKeyOf(senderKey(meta));
  if (!tk || (!pool.get(tk) && !pool.getMeta(tk))) {
    return '当前没有会话可清理（/session start 可开新会话）';
  }

  const m = pool.getMeta(tk);
  const cwd = m?.cwd ?? '.';

  await pool.stop(tk, { keepMeta: true });
  pool.clearSessionId(tk); // 丢弃 resumeId —— 下次启动即全新上下文
  pool.start(parseThreadKey(tk), cwd);

  return `🧹 上下文已清空，会话已重开\n**cwd**: \`${cwd}\`（引擎/profile/权限等设置保留）\n直接发消息开始新对话`;
};

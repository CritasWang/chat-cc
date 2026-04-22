import { senderKey, type CommandFn } from './types.js';

/**
 * /s <text>  — 向当前活跃会话发送一条消息（非命令消息也会走这里）
 */
export const sendCommand: CommandFn = async (args, meta, { pool }) => {
  const text = args.trim();
  if (!text) return '用法: /s <消息内容>';

  const sess = pool.getOrResumeActive(senderKey(meta));
  if (!sess) return '当前没有活跃的会话，使用 /session start 开启';

  sess.send(text);
  return;
};

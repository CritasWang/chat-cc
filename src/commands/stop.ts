import { type CommandFn } from './types.js';
import { askScopeKey, interruptAsk } from './ask.js';
import { canAccessSession, currentSessionKey } from './session-context.js';

/**
 * /stop [threadKey]  — 中断当前活跃会话（或指定 threadKey）的当前轮
 * interrupt 后立即 PATCH 当前直播卡片为「🛑 已中断」
 * 同时支持中断 /ask 模式的无状态查询
 */
export const stopCommand: CommandFn = async (args, meta, { pool, streamer }) => {
  const requested = args.trim();
  const ownAskScope = askScopeKey(meta.chatId, meta.senderId);

  // /ask 直播卡的“中断”按钮携带 ask:<chat>:<sender>:<messageId>，它不是 Session threadKey。
  // 先按 ask key 鉴权/处理中断，否则会被 canAccessSession 误判为越权会话。
  if (requested.startsWith('ask:')) {
    const belongsToRequester = requested === ownAskScope || requested.startsWith(`${ownAskScope}:`);
    if (!belongsToRequester) return '⛔ 无权操作该一次性提问';
    return (await interruptAsk(requested))
      ? `🛑 已中断 · ${requested}`
      : '该一次性提问已结束或不存在';
  }

  if (requested && !canAccessSession(meta, requested)) {
    return '⛔ 无权操作该会话';
  }
  const target = requested || currentSessionKey(meta, pool);
  if (!target) {
    const askKey = requested || ownAskScope;
    if (await interruptAsk(askKey)) return `🛑 已中断 · ${askKey}`;
    return '当前没有可中断的会话';
  }
  const sess = pool.get(target);
  if (!sess) {
    // 尝试中断 /ask 模式的无状态查询
    const askKey = requested || ownAskScope;
    if (await interruptAsk(askKey)) return `🛑 已中断 · ${askKey}`;
    return `会话不存在 · ${target}`;
  }
  await streamer.markInterrupted(target);
  try {
    await sess.interrupt();
  } catch (err) {
    streamer.cancelInterrupted(target);
    throw err;
  }
  return `🛑 已中断 · ${target}`;
};

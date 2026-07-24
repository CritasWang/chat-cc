import { senderKey, type CommandFn } from './types.js';
import { parseThreadKey, SessionPoolCapacityError, topicThreadKey } from '../engine/pool.js';
import { PendingQueueCapacityError } from '../engine/pending-queue.js';

/**
 * /s <text>  — 向会话发送一条消息（非命令消息也会走这里）
 *
 * 路由规则：
 * - 话题群消息（meta.threadId 存在）：一个话题 = 一个会话，按 threadId 确定会话，
 *   不存在则自动创建（cwd 继承发送者当前活跃会话，否则用 default_cwd）；
 *   回复锚定到触发消息所在话题（reply in thread）
 * - 其他：投递到发送者当前活跃会话
 *
 * 投递统一走 PendingQueue：静默窗口内的连续消息合并为一条 prompt；
 * agent 运行期间到达的消息累积，运行结束后合并带入下一轮。
 */
export const sendCommand: CommandFn = async (args, meta, { cfg, pool, streamer, pending }) => {
  const text = args.trim();
  if (!text) return '用法: /s <消息内容>';

  // —— 话题群：thread = session ——
  if (meta.threadId) {
    const tk = topicThreadKey(meta.chatId, meta.threadId);
    if (!pool.get(tk) && !pool.getMeta(tk)) {
      // 新话题：从本群锚点会话（/new chat 预建的 default）继承 cwd 与会话设置
      const anchorTk = pool.activeThreadKeyOf(senderKey(meta));
      const anchor = anchorTk ? pool.getMeta(anchorTk) : undefined;
      try {
        pool.start(parseThreadKey(tk), anchor?.cwd ?? cfg.default_cwd, {
          ...(anchor?.agent ? { agent: anchor.agent } : {}),
          ...(anchor?.apiProfile ? { apiProfile: anchor.apiProfile } : {}),
          ...(anchor?.danger !== undefined ? { danger: anchor.danger } : {}),
        });
      } catch (err) {
        if (err instanceof SessionPoolCapacityError) {
          return `⏳ 活跃会话已达上限（${err.limit}），请先关闭不用的会话或等待空闲回收`;
        }
        throw err;
      }
    }
    try {
      pending.push(tk, text, meta.senderId);
    } catch (err) {
      if (err instanceof PendingQueueCapacityError) return '⏳ 当前会话积压已满，请等待本轮结束或用 /stop 中断';
      throw err;
    }
    // 仅在消息成功入队后更新回复锚点；容量拒绝的消息不能劫持下一批输出位置。
    streamer.setReplyTarget(tk, { rootMessageId: meta.messageId, inThread: true });
    return;
  }

  // —— 普通/单聊：投递到活跃会话 ——
  const tk = pool.activeThreadKeyOf(senderKey(meta));
  if (!tk || (!pool.get(tk) && !pool.getMeta(tk))) {
    return '当前没有活跃的会话，使用 /session start 开启';
  }

  try {
    pending.push(tk, text, meta.senderId);
  } catch (err) {
    if (err instanceof PendingQueueCapacityError) return '⏳ 当前会话积压已满，请等待本轮结束或用 /stop 中断';
    throw err;
  }
  return;
};

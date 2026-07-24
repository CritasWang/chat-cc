import { senderKey, type CommandFn } from './types.js';
import { parseThreadKey, topicThreadKey } from '../engine/pool.js';

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
      pool.start(parseThreadKey(tk), anchor?.cwd ?? cfg.default_cwd, {
        ...(anchor?.agent ? { agent: anchor.agent } : {}),
        ...(anchor?.apiProfile ? { apiProfile: anchor.apiProfile } : {}),
        ...(anchor?.danger !== undefined ? { danger: anchor.danger } : {}),
      });
    }
    streamer.setReplyTarget(tk, { rootMessageId: meta.messageId, inThread: true });
    pending.push(tk, text);
    return;
  }

  // —— 普通/单聊：投递到活跃会话 ——
  const sess = pool.getOrResumeActive(senderKey(meta));
  if (!sess) return '当前没有活跃的会话，使用 /session start 开启';

  pending.push(sess.threadKey, text);
  return;
};

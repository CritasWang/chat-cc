import {
  isTopicThreadKey,
  parseThreadKey,
  topicThreadKey,
  type SessionPool,
} from '../engine/pool.js';
import type { MessageMeta } from '../feishu/router.js';
import { senderKey } from './types.js';

/** 当前消息有权操作的会话：个人会话必须同 chat+sender，话题会话必须是当前话题。 */
export function canAccessSession(meta: MessageMeta, threadKey: string): boolean {
  const parsed = parseThreadKey(threadKey);
  if (isTopicThreadKey(threadKey)) {
    return Boolean(
      meta.threadId &&
      parsed.chatId === meta.chatId &&
      threadKey === topicThreadKey(meta.chatId, meta.threadId),
    );
  }
  return parsed.chatId === meta.chatId && parsed.senderId === meta.senderId;
}

/** 话题群优先当前话题；普通群/单聊使用发送者在本 chat 的 active 指针。 */
export function currentSessionKey(meta: MessageMeta, pool: SessionPool): string | undefined {
  const key = meta.threadId
    ? topicThreadKey(meta.chatId, meta.threadId)
    : pool.activeThreadKeyOf(senderKey(meta));
  return key && (pool.get(key) || pool.getMeta(key)) ? key : undefined;
}

/** 返回当前消息可见的会话列表；话题内仅显示当前话题，其他场景显示当前 chat+sender 的槽位。 */
export function listAccessibleSessions(meta: MessageMeta, pool: SessionPool): ReturnType<SessionPool['list']> {
  if (meta.threadId) {
    const key = topicThreadKey(meta.chatId, meta.threadId);
    return pool.list().filter((s) => s.threadKey === key);
  }
  return pool.listByScope(meta.chatId, meta.senderId);
}

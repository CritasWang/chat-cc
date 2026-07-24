import type * as Lark from '@larksuiteoapi/node-sdk';
import { log } from '../logger.js';

/**
 * 话题群 thread_id 解析（借鉴 lark-bridge bot/thread-id.ts 的踩坑经验）。
 *
 * 飞书事件有时不携带 thread_id（尤其是「启动话题的第一条消息」），
 * 导致回复逃逸到群主 feed。对策：
 * 1. 缓存 chat_mode（im.v1.chat.get），仅话题群才做补查，普通群零开销
 * 2. 补查走 im.v1.message.get 拿**原始**消息项 — 规范化消息会丢 thread_id
 */

const CHAT_MODE_TTL_MS = 10 * 60_000;
const MAX_CACHE_SIZE = 1000;

export interface ThreadResolver {
  /** 事件缺 thread_id 时补查：仅话题群返回值，其余返回 undefined */
  resolve(chatId: string, messageId: string): Promise<string | undefined>;
  /** 群聊模式变化（普通群↔话题群转换）后手动失效 */
  invalidate(chatId: string): void;
}

export function buildThreadResolver(client: Lark.Client): ThreadResolver {
  const modeCache = new Map<string, { mode: string; at: number }>();

  async function chatMode(chatId: string): Promise<string> {
    const hit = modeCache.get(chatId);
    if (hit && Date.now() - hit.at < CHAT_MODE_TTL_MS) return hit.mode;
    try {
      const resp = await client.im.v1.chat.get({ path: { chat_id: chatId } });
      const mode = (resp.data as { chat_mode?: string } | undefined)?.chat_mode ?? 'group';
      modeCache.set(chatId, { mode, at: Date.now() });
      // 容量保护：超过上限淘汰迭代头（Map 按插入序，头=最旧条目）
      if (modeCache.size > MAX_CACHE_SIZE) {
        const first = modeCache.keys().next();
        if (first.value) modeCache.delete(first.value);
      }
      return mode;
    } catch (err) {
      log().warn({ err, chatId }, 'chat_mode 查询失败，按普通群处理');
      return 'group';
    }
  }

  return {
    async resolve(chatId, messageId) {
      const mode = await chatMode(chatId);
      if (mode !== 'topic') return undefined;
      try {
        const resp = await client.im.v1.message.get({ path: { message_id: messageId } });
        const items = (resp.data as { items?: Array<{ thread_id?: string }> } | undefined)?.items;
        return items?.[0]?.thread_id || undefined;
      } catch (err) {
        log().warn({ err, chatId, messageId }, 'thread_id 补查失败');
        return undefined;
      }
    },
    invalidate(chatId) {
      modeCache.delete(chatId);
    },
  };
}

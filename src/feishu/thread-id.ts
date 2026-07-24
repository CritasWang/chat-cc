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
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await client.im.v1.chat.get({ path: { chat_id: chatId } });
        const mode = (resp.data as { chat_mode?: string } | undefined)?.chat_mode;
        if (!mode) throw new Error('chat.get 未返回 chat_mode');
        if (mode !== 'group' && mode !== 'topic') {
          throw new Error(`chat.get 返回未知 chat_mode: ${mode}`);
        }
        modeCache.set(chatId, { mode, at: Date.now() });
        // 容量保护：超过上限淘汰迭代头（Map 按插入序，头=最旧条目）
        if (modeCache.size > MAX_CACHE_SIZE) {
          const first = modeCache.keys().next();
          if (first.value) modeCache.delete(first.value);
        }
        return mode;
      } catch (err) {
        lastErr = err;
      }
      if (attempt < 2) await delay(100 * (attempt + 1));
    }
    // 未知群模式时绝不能按普通群降级，否则话题首消息会串入个人 active 会话。
    log().warn({ err: lastErr, chatId }, 'chat_mode 查询失败，拒绝降级到普通群');
    throw lastErr instanceof Error ? lastErr : new Error('chat_mode 查询失败');
  }

  return {
    async resolve(chatId, messageId) {
      const mode = await chatMode(chatId);
      if (mode !== 'topic') return undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await client.im.v1.message.get({ path: { message_id: messageId } });
          const items = (resp.data as { items?: Array<{ thread_id?: string }> } | undefined)?.items;
          const threadId = items?.[0]?.thread_id;
          if (threadId) return threadId;
          lastErr = new Error('message.get 未返回 thread_id');
        } catch (err) {
          lastErr = err;
        }
        if (attempt < 2) await delay(100 * (attempt + 1));
      }
      log().warn({ err: lastErr, chatId, messageId }, '话题群 thread_id 补查失败，拒绝降级到个人会话');
      throw lastErr instanceof Error ? lastErr : new Error('话题群 thread_id 补查失败');
    },
    invalidate(chatId) {
      modeCache.delete(chatId);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

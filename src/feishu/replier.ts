import type * as Lark from '@larksuiteoapi/node-sdk';
import { log } from '../logger.js';

export interface InteractiveCard {
  schema?: string;
  config?: Record<string, unknown>;
  header?: Record<string, unknown>;
  body?: Record<string, unknown>;
  elements?: unknown[];
  [k: string]: unknown;
}

/**
 * 瞬时网络错误判定（重试用）。
 * 覆盖代理/抖动场景下观测到的失败形态：
 * - ECONN、RESET、EOF、timeout（TCP 层）
 * - "socket disconnected before secure TLS"（TLS 握手被代理掐断）
 * - SDK TokenManager 在 token 请求失败时抛出的
 *   "Cannot destructure property 'tenant_access_token'"（本质也是一次网络失败）
 */
function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // 也检查错误对象的 HTTP status（如有）
  const status = (err as Record<string, unknown> | undefined)?.status;
  return (
    msg.includes('ECONN') ||
    msg.includes('EOF') ||
    msg.includes('timeout') ||
    msg.includes('RESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EPIPE') ||
    msg.includes('socket disconnected') ||
    msg.includes('TLS connection') ||
    msg.includes('tenant_access_token') ||
    Number(status) === 429 ||
    msg.includes('rate limit') ||
    msg.includes('Too Many Requests')
  );
}

export class Replier {
  constructor(private readonly client: Lark.Client) {}

  async replyText(
    rootMessageId: string,
    text: string,
    opts: { inThread?: boolean } = {},
  ): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.reply({
        path: { message_id: rootMessageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(opts.inThread ? { reply_in_thread: true } : {}),
        },
      });
      return resp.data?.message_id;
    } catch (err) {
      log().error({ err, rootMessageId }, '回复文本失败');
      return undefined;
    }
  }

  async sendText(chatId: string, text: string, retries = 2): Promise<string | undefined> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        });
        return resp.data?.message_id;
      } catch (err) {
        if (attempt < retries && isTransientNetworkError(err)) {
          await delay(300 * 2 ** attempt);
          continue;
        }
        log().error({ err, chatId }, '发送文本失败');
        return undefined;
      }
    }
    return undefined;
  }

  async sendCard(chatId: string, card: InteractiveCard, retries = 2): Promise<string | undefined> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        });
        return resp.data?.message_id;
      } catch (err) {
        if (attempt < retries && isTransientNetworkError(err)) {
          await delay(300 * 2 ** attempt);
          continue;
        }
        log().error({ err, chatId }, '发送卡片失败');
        return undefined;
      }
    }
    return undefined;
  }

  async replyCard(
    rootMessageId: string,
    card: InteractiveCard,
    opts: { inThread?: boolean } = {},
    retries = 2,
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await this.client.im.v1.message.reply({
          path: { message_id: rootMessageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(card),
            ...(opts.inThread ? { reply_in_thread: true } : {}),
          },
        });
        return resp.data?.message_id;
      } catch (err) {
        if (attempt < retries && isTransientNetworkError(err)) {
          await delay(300 * 2 ** attempt);
          continue;
        }
        log().error({ err, rootMessageId }, '回复卡片失败');
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * 创建群聊并拉指定用户进群（bot 作为创建者自动入群）。
   * 用于 /new chat：为新话题自动开一个专属群。
   */
  async createChat(opts: {
    name: string;
    inviteOpenIds: string[];
    description?: string;
    /** 群模式：group=普通群（默认），topic=话题群（一个话题 = 一个独立会话） */
    chatMode?: 'group' | 'topic';
  }): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.chat.create({
        params: { user_id_type: 'open_id' },
        data: {
          name: opts.name,
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.chatMode ? { chat_mode: opts.chatMode } : {}),
          user_id_list: opts.inviteOpenIds,
        },
      });
      return resp.data?.chat_id;
    } catch (err) {
      log().error({ err, name: opts.name }, '创建群聊失败');
      return undefined;
    }
  }

  /** 读取群信息（name/description，用于判断是否 chat-cc 所建） */
  async getChatInfo(chatId: string): Promise<{ name?: string; description?: string } | undefined> {
    try {
      const resp = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      const d = resp.data as { name?: string; description?: string } | undefined;
      return d ? { ...(d.name ? { name: d.name } : {}), ...(d.description ? { description: d.description } : {}) } : undefined;
    } catch (err) {
      log().warn({ err, chatId }, '读取群信息失败');
      return undefined;
    }
  }

  /** 更新群名/描述（bot 需为群主/管理员，chat-cc 建的群天然满足） */
  async updateChat(chatId: string, data: { name?: string; description?: string }): Promise<boolean> {
    try {
      await this.client.im.v1.chat.update({ path: { chat_id: chatId }, data });
      return true;
    } catch (err) {
      log().warn({ err, chatId }, '更新群信息失败');
      return false;
    }
  }

  /** Pin 一条消息到群置顶（best-effort） */
  async pinMessage(messageId: string): Promise<boolean> {
    try {
      await this.client.im.v1.pin.create({ data: { message_id: messageId } });
      return true;
    } catch (err) {
      log().warn({ err, messageId }, 'Pin 消息失败');
      return false;
    }
  }

  async patchCard(messageId: string, card: InteractiveCard, retries = 2): Promise<boolean> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.client.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) },
        });
        return true;
      } catch (err) {
        const isLast = attempt === retries;
        if (isLast) {
          log().error({ err, messageId }, '更新卡片失败（重试耗尽）');
          return false;
        }
        if (isTransientNetworkError(err)) {
          await delay(200 * 2 ** attempt);
          continue;
        }
        log().error({ err, messageId }, '更新卡片失败（非瞬时错误）');
        return false;
      }
    }
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

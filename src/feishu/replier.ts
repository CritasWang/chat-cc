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

export class Replier {
  constructor(private readonly client: Lark.Client) {}

  async replyText(rootMessageId: string, text: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.reply({
        path: { message_id: rootMessageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
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
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < retries && (msg.includes('ECONN') || msg.includes('EOF') || msg.includes('timeout') || msg.includes('RESET'))) {
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
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < retries && (msg.includes('ECONN') || msg.includes('EOF') || msg.includes('timeout') || msg.includes('RESET'))) {
          await delay(300 * 2 ** attempt);
          continue;
        }
        log().error({ err, chatId }, '发送卡片失败');
        return undefined;
      }
    }
    return undefined;
  }

  async replyCard(rootMessageId: string, card: InteractiveCard, retries = 2): Promise<string | undefined> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await this.client.im.v1.message.reply({
          path: { message_id: rootMessageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        });
        return resp.data?.message_id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < retries && (msg.includes('ECONN') || msg.includes('EOF') || msg.includes('timeout') || msg.includes('RESET'))) {
          await delay(300 * 2 ** attempt);
          continue;
        }
        log().error({ err, rootMessageId }, '回复卡片失败');
        return undefined;
      }
    }
    return undefined;
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
        const msg = err instanceof Error ? err.message : String(err);
        if (isLast) {
          log().error({ err, messageId }, '更新卡片失败（重试耗尽）');
          return false;
        }
        if (msg.includes('EOF') || msg.includes('ECONN') || msg.includes('timeout')) {
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

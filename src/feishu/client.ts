import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import { log } from '../logger.js';
import type { Router, MessageMeta } from './router.js';

interface TextContent {
  text: string;
}

interface ReceiveMessageEvent {
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; name?: string }>;
  };
  sender?: {
    sender_id?: { open_id?: string };
  };
}

export function buildClient(cfg: Config): Lark.Client {
  return new Lark.Client({
    appId: cfg.app_id,
    appSecret: cfg.app_secret,
    disableTokenCache: false,
  });
}

export function buildWsClient(cfg: Config): Lark.WSClient {
  return new Lark.WSClient({
    appId: cfg.app_id,
    appSecret: cfg.app_secret,
    loggerLevel: mapLogLevel(cfg.log_level),
  });
}

export interface DispatcherExtensions {
  cardAction?: (raw: unknown) => Promise<unknown>;
}

export function startDispatcher(
  ws: Lark.WSClient,
  cfg: Config,
  router: Router,
  ext: DispatcherExtensions = {},
): void {
  const handlers: Record<string, (raw: unknown) => Promise<unknown>> = {
    'im.message.receive_v1': async (raw: unknown) => {
      const data = raw as ReceiveMessageEvent;
      const meta = extractMeta(data);
      if (!meta) return;

      if (!isAllowed(cfg, meta.senderId, meta.chatId)) {
        log().warn({ sender: meta.senderId, chat: meta.chatId }, '拒绝未授权消息');
        return;
      }

      const text = extractText(data, meta);
      if (!text) return;

      log().info({ sender: meta.senderId, chat: meta.chatId, text }, '收到消息');

      void router.dispatch(text, meta).catch((err) => {
        log().error({ err }, 'dispatch 失败');
      });
    },
  };

  if (ext.cardAction) {
    handlers['card.action.trigger'] = ext.cardAction;
  }

  const dispatcher = new Lark.EventDispatcher({}).register(handlers);
  ws.start({ eventDispatcher: dispatcher });
  log().info({ events: Object.keys(handlers) }, '飞书 WSClient 已启动');
}

function extractMeta(data: ReceiveMessageEvent): MessageMeta | undefined {
  const msg = data.message;
  if (!msg?.message_id || !msg.chat_id || msg.message_type !== 'text') return undefined;
  const senderId = data.sender?.sender_id?.open_id ?? '';
  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    chatType: msg.chat_type ?? '',
    senderId,
    mentionBot: Array.isArray(msg.mentions) && msg.mentions.length > 0,
  };
}

function extractText(data: ReceiveMessageEvent, meta: MessageMeta): string {
  const raw = data.message?.content ?? '';
  let parsed: TextContent;
  try {
    parsed = JSON.parse(raw) as TextContent;
  } catch {
    return '';
  }
  let text = parsed.text?.trim() ?? '';
  if (meta.mentionBot && Array.isArray(data.message?.mentions)) {
    for (const m of data.message.mentions) {
      if (m.key) text = text.split(m.key).join('');
    }
    text = text.trim();
  }
  return text;
}

function isAllowed(cfg: Config, senderId: string, chatId: string): boolean {
  if (cfg.allowed_users.length === 0 && cfg.allowed_chats.length === 0) return true;
  if (cfg.allowed_users.includes(senderId)) return true;
  if (cfg.allowed_chats.includes(chatId)) return true;
  return false;
}

function mapLogLevel(level: Config['log_level']): Lark.LoggerLevel {
  switch (level) {
    case 'debug':
      return Lark.LoggerLevel.debug;
    case 'warn':
      return Lark.LoggerLevel.warn;
    case 'error':
      return Lark.LoggerLevel.error;
    default:
      return Lark.LoggerLevel.info;
  }
}

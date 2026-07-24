import * as Lark from '@larksuiteoapi/node-sdk';
import https from 'node:https';
import http from 'node:http';
import type { Config } from '../config.js';
import { log } from '../logger.js';
import { isAllowed } from '../auth.js';
import type { Router, MessageMeta } from './router.js';

// 全局 Keep-Alive agent —— 通过修改 Node 全局 agent 的方式生效，避开覆盖 SDK httpInstance 导致丢失 token 拦截器的问题
https.globalAgent = new https.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 30_000 });
http.globalAgent = new http.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 30_000 });

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
    thread_id?: string;
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
    // 快速失败 + 快速重试：不稳定网络下 8s 握手上限优于默认无限等待
    handshakeTimeoutMs: 8_000,
    // 3s 存活看门狗：ping 后 3s 内无任何入站帧则判死重连
    wsConfig: { pingTimeout: 3 },
  });
}

/**
 * 可重建的 WS 控制器 — 供 keepalive 强制重连使用。
 * SDK 的 WSClient 没有公开「重启」接口，重连 = force close 旧实例 + 新建实例重新 start。
 */
export interface WsController {
  getState(): 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  /** 销毁当前连接并重建（keepalive 判定 WS 卡死时调用） */
  forceReconnect(): Promise<void>;
  /** 停止接收新事件（daemon shutdown）。 */
  close(): void;
}

export function startWsController(
  cfg: Config,
  router: Router,
  ext: DispatcherExtensions = {},
): WsController {
  let ws = buildWsClient(cfg);
  let closed = false;
  startDispatcher(ws, cfg, router, ext);

  return {
    getState() {
      return ws.getConnectionStatus().state;
    },
    async forceReconnect() {
      if (closed) return;
      try {
        ws.close({ force: true });
      } catch (err) {
        log().warn({ err }, '关闭旧 WSClient 失败（忽略，继续重建）');
      }
      ws = buildWsClient(cfg);
      startDispatcher(ws, cfg, router, ext);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        ws.close({ force: true });
      } catch (err) {
        log().warn({ err }, '关闭 WSClient 失败');
      }
    },
  };
}

export interface DispatcherExtensions {
  cardAction?: (raw: unknown) => Promise<unknown>;
  /** 话题群 thread_id 补查（事件缺失时），见 thread-id.ts */
  threadResolver?: import('./thread-id.js').ThreadResolver;
  /** 合并转发消息 → 聊天记录文本，见 forward.ts */
  forwardResolver?: (messageId: string) => Promise<string | undefined>;
  /** 云文档评论事件处理（drive.notice.comment_add_v1），见 comments.ts */
  commentHandler?: (raw: unknown) => Promise<void>;
  /** 每条用户消息的旁路回调（用于活跃度追踪等），在 dispatch 前同步调用 */
  onUserMessage?: (meta: MessageMeta) => void;
  /** 图片/文件消息 → 下载落盘 → 返回投递给会话的 prompt 文本，见 media.ts */
  mediaResolver?: (messageId: string, msgType: string, rawContent: string) => Promise<string | undefined>;
  /** 持久化 message_id 去重，防 WS 重投重复执行副作用。 */
  messageReceipts?: { accept(messageId: string): boolean; revoke(messageId: string): void };
  /** 异步业务处理失败后的用户可见兜底。 */
  onMessageError?: (meta: MessageMeta, err: unknown) => Promise<void>;
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
      const msg = data.message;

      // 合并转发消息：解析为聊天记录文本，交给会话处理
      if (msg?.message_id && msg.message_type === 'merge_forward' && ext.forwardResolver) {
        const senderId = data.sender?.sender_id?.open_id ?? '';
        if (!isAllowed(cfg, senderId, msg.chat_id ?? '')) return;
        if (!acceptMessage(msg.message_id, ext)) return;
        const meta: MessageMeta = {
          messageId: msg.message_id,
          chatId: msg.chat_id ?? '',
          chatType: msg.chat_type ?? '',
          senderId,
          mentionBot: false,
          ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
        };
        ext.onUserMessage?.(meta);
        void runMessageJob(meta, ext, 'merge_forward dispatch', async (markDispatched) => {
          await resolveThreadId(meta, ext);
          const transcript = await ext.forwardResolver!(msg.message_id!);
          if (!transcript) throw new Error('合并转发消息无可用内容');
          const text = `以下是我转发的聊天记录，请阅读并处理：\n\n${transcript}`;
          log().info({ sender: senderId, chat: meta.chatId, items: transcript.split('\n').length }, '收到合并转发消息');
          markDispatched();
          await router.dispatch(text, meta);
        });
        return;
      }

      // 图片/文件消息：下载落盘，把本地路径作为 prompt 交给会话
      // （Claude Read 原生读图；文件路径交给 agent 自行读取）
      if (
        msg?.message_id &&
        (msg.message_type === 'image' || msg.message_type === 'file') &&
        ext.mediaResolver
      ) {
        const senderId = data.sender?.sender_id?.open_id ?? '';
        const chatId = msg.chat_id ?? '';
        if (!isAllowed(cfg, senderId, chatId)) return;
        if (!acceptMessage(msg.message_id, ext)) return;
        const meta: MessageMeta = {
          messageId: msg.message_id,
          chatId,
          chatType: msg.chat_type ?? '',
          senderId,
          mentionBot: false,
          ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
        };
        log().info({ sender: senderId, chat: chatId, messageType: msg.message_type }, '收到资源消息，开始下载');
        ext.onUserMessage?.(meta);
        // 下载可达 100MB，不能阻塞 WS 事件 ack（否则飞书判超时重推）——异步处理
        const mediaMsg = msg;
        void runMessageJob(meta, ext, 'media dispatch', async (markDispatched) => {
          await resolveThreadId(meta, ext);
          const prompt = await ext.mediaResolver!(mediaMsg.message_id!, mediaMsg.message_type!, mediaMsg.content ?? '');
          if (!prompt) throw new Error('消息资源下载失败或内容无效');
          markDispatched();
          await router.dispatch(prompt, meta);
        });
        return;
      }

      // 非文本消息提示（text/post/image/file 之外：语音、视频、表情包等）
      // info 级别留痕：静默吞消息曾导致「发了没反应」误判会话挂死，必须可见
      if (msg?.message_id && msg.message_type && msg.message_type !== 'text' && msg.message_type !== 'post') {
        log().info({ messageType: msg.message_type, chat: msg.chat_id }, '收到不支持的消息类型，已忽略');
        return;
      }

      const meta = extractMeta(data);
      if (!meta) return;

      if (!isAllowed(cfg, meta.senderId, meta.chatId)) {
        log().warn({ sender: meta.senderId, chat: meta.chatId }, '拒绝未授权消息');
        return;
      }

      const text = extractText(data, meta);
      if (!text) return;
      if (!acceptMessage(meta.messageId, ext)) return;

      log().info(
        { sender: meta.senderId, chat: meta.chatId, textPreview: text.slice(0, 200), textLength: text.length },
        '收到消息',
      );
      ext.onUserMessage?.(meta);

      void runMessageJob(meta, ext, 'dispatch', async (markDispatched) => {
        await resolveThreadId(meta, ext);
        markDispatched();
        await router.dispatch(text, meta);
      });
    },
  };

  if (ext.cardAction) {
    handlers['card.action.trigger'] = ext.cardAction;
  }
  if (ext.commentHandler) {
    handlers['drive.notice.comment_add_v1'] = async (raw: unknown) => {
      // 评论 Agent 可运行数十分钟，不能占住 WS 事件回执；处理器内部已有
      // per-thread inFlight 去重与 try/finally 清理，这里只负责后台启动和最后一层异常收敛。
      void ext.commentHandler!(raw).catch((err) =>
        log().error({ err }, '评论事件后台处理失败'),
      );
    };
  }

  const dispatcher = new Lark.EventDispatcher({}).register(handlers);
  ws.start({ eventDispatcher: dispatcher });
  log().info({ events: Object.keys(handlers) }, '飞书 WSClient 已启动');
}

async function resolveThreadId(meta: MessageMeta, ext: DispatcherExtensions): Promise<void> {
  // 文本、媒体、合并转发统一补查；否则话题首条图片/文件会逃逸到个人 active 会话。
  if (meta.threadId || meta.chatType !== 'group' || !ext.threadResolver) return;
  const tid = await ext.threadResolver.resolve(meta.chatId, meta.messageId);
  if (tid) meta.threadId = tid;
}

function acceptMessage(messageId: string, ext: DispatcherExtensions): boolean {
  if (!ext.messageReceipts || ext.messageReceipts.accept(messageId)) return true;
  log().info({ messageId }, '收到重复消息，已按 message_id 去重');
  return false;
}

/** @internal 导出用于验证 receipt 的副作用边界。 */
export async function runMessageJob(
  meta: MessageMeta,
  ext: DispatcherExtensions,
  label: string,
  job: (markDispatched: () => void) => Promise<void>,
): Promise<void> {
  let dispatched = false;
  try {
    await job(() => {
      // 从这一刻起 Router/命令可能已经产生外部副作用；后续失败仍保持 at-most-once，
      // 不能撤销 receipt 后让 WS 重投重复执行 /new chat、/reload 等命令。
      dispatched = true;
    });
  } catch (err) {
    if (!dispatched) ext.messageReceipts?.revoke(meta.messageId);
    log().error({ err, messageId: meta.messageId }, `${label} 失败`);
    if (ext.onMessageError) {
      await ext.onMessageError(meta, err).catch((notifyErr) =>
        log().error({ err: notifyErr, messageId: meta.messageId }, '处理失败通知发送失败'),
      );
    }
  }
}

function extractMeta(data: ReceiveMessageEvent): MessageMeta | undefined {
  const msg = data.message;
  if (!msg?.message_id || !msg.chat_id) return undefined;
  if (msg.message_type !== 'text' && msg.message_type !== 'post') return undefined;
  const senderId = data.sender?.sender_id?.open_id ?? '';
  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    chatType: msg.chat_type ?? '',
    senderId,
    mentionBot: Array.isArray(msg.mentions) && msg.mentions.length > 0,
    ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
  };
}

function extractText(data: ReceiveMessageEvent, meta: MessageMeta): string {
  const raw = data.message?.content ?? '';
  // post（富文本）：用户用了列表/加粗/链接等格式时，飞书自动把 text 升级为 post，
  // 内容结构完全不同，需按段落节点提取纯文本
  if (data.message?.message_type === 'post') {
    return extractPostText(raw);
  }
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

interface PostNode {
  tag?: string;
  text?: string;
  href?: string;
}

/**
 * post（富文本）消息 → 纯文本。
 * content 为二维数组：外层段落、内层行内节点（text/a/at/img/emotion/code_block…）。
 * 提取 text 与链接；at（@提及，含 @bot）与 text 消息剥离 mention key 的行为保持一致，
 * 直接跳过；img/media 等非文本节点忽略。
 */
export function extractPostText(raw: string): string {
  let parsed: { title?: string; content?: PostNode[][] };
  try {
    parsed = JSON.parse(raw) as { title?: string; content?: PostNode[][] };
  } catch {
    return '';
  }
  const lines: string[] = [];
  const title = parsed.title?.trim();
  if (title) lines.push(title);
  for (const para of parsed.content ?? []) {
    if (!Array.isArray(para)) continue;
    const parts: string[] = [];
    for (const node of para) {
      if (!node || typeof node !== 'object') continue;
      switch (node.tag) {
        case 'text':
        case 'code_block':
          if (node.text) parts.push(node.text);
          break;
        case 'a':
          parts.push(node.text && node.href && node.text !== node.href ? `${node.text} (${node.href})` : (node.href ?? node.text ?? ''));
          break;
        case 'at':
        case 'img':
        case 'media':
        case 'emotion':
          break;
        default:
          if (node.text) parts.push(node.text);
      }
    }
    lines.push(parts.join(''));
  }
  return lines.join('\n').trim();
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

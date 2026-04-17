import * as Lark from '@larksuiteoapi/node-sdk';
import http from 'node:http';
import { log } from '../logger.js';
import type { Router } from './router.js';
import type { CommandDeps } from '../commands/types.js';

/**
 * 卡片按钮回调分发。
 *
 * 飞书 Node SDK 的 CardActionHandler 走 **HTTP webhook**（同步 Toast/卡片响应在 response body 里）。
 * 我们同时把同一 dispatch 逻辑注册到 WSClient 的 `card.action.trigger`，
 * 这样可以无论飞书端怎么推都吃得到（例如审批的 side effect 解 resolver）；
 * 但显式的 Toast/card 响应只在 HTTP 路径上可靠。
 *
 * 按钮 `value` 约定：
 *   { cmd: string, args?: string, echo?: string, decision?: 'allow'|'deny' }
 *
 * `cmd === '__approve'` 是审批专用保留命令，由 engine/hooks.ts 的 ApprovalGate 接管。
 */
export interface CardActionDeps {
  router: Router;
  deps: CommandDeps;
  approvalResolver: (requestId: string, decision: 'allow' | 'deny') => boolean;
  verificationToken?: string;
  encryptKey?: string;
}

interface CardActionPayload {
  operator?: { open_id?: string; union_id?: string };
  token?: string;
  open_chat_id?: string;
  open_message_id?: string;
  context?: { open_chat_id?: string; open_message_id?: string };
  action?: { value?: unknown; tag?: string };
}

interface ToastResponse {
  toast?: { type: string; content: string };
  card?: unknown;
}

type HttpHandlerOptions = ConstructorParameters<typeof Lark.CardActionHandler>[0];

export function buildCardActionHttpHandler(d: CardActionDeps): Lark.CardActionHandler {
  const opts: HttpHandlerOptions = {} as HttpHandlerOptions;
  if (d.verificationToken) (opts as { verificationToken?: string }).verificationToken = d.verificationToken;
  if (d.encryptKey) (opts as { encryptKey?: string }).encryptKey = d.encryptKey;

  return new Lark.CardActionHandler(opts, async (raw: unknown) => {
    try {
      return await dispatch(extractPayload(raw), d);
    } catch (err) {
      log().error({ err }, 'HTTP 卡片回调处理失败');
      return toast('error', '处理失败');
    }
  });
}

export function buildCardActionWsHandler(
  d: CardActionDeps,
): (data: unknown) => Promise<ToastResponse> {
  return async (raw) => {
    try {
      return await dispatch(extractPayload(raw), d);
    } catch (err) {
      log().error({ err }, 'WS 卡片回调处理失败');
      return toast('error', '处理失败');
    }
  };
}

export function startCardHttpServer(
  handler: Lark.CardActionHandler,
  port: number,
  path: string,
): http.Server {
  const server = http.createServer();
  server.on('request', Lark.adaptDefault(path, handler));
  server.listen(port, () => log().info({ port, path }, '卡片回调 HTTP server 已启动'));
  return server;
}

/** WS 和 HTTP 两个入口共用的分发逻辑 */
async function dispatch(ev: CardActionPayload, d: CardActionDeps): Promise<ToastResponse> {
  if (!ev.action) return toast('info', '✓');

  const value = normalizeValue(ev.action.value);
  const cmd = String(value['cmd'] ?? '');
  const args = String(value['args'] ?? '');
  const echo = typeof value['echo'] === 'string' ? value['echo'] : undefined;
  const senderId = ev.operator?.open_id ?? '';
  const chatId = ev.open_chat_id ?? ev.context?.open_chat_id ?? '';
  const messageId = ev.open_message_id ?? ev.context?.open_message_id ?? '';

  if (cmd === '__approve') {
    const decision = value['decision'] === 'deny' ? 'deny' : 'allow';
    const ok = d.approvalResolver(args, decision);
    return toast(
      ok ? (decision === 'allow' ? 'success' : 'warning') : 'error',
      ok ? (decision === 'allow' ? '✅ 已允许' : '❌ 已拒绝') : '审批已过期',
    );
  }

  if (!cmd) return toast('info', echo ?? '✓');

  const cmdLine = args ? `/${cmd} ${args}` : `/${cmd}`;
  await d.router.dispatch(cmdLine, {
    messageId,
    chatId,
    chatType: chatId.startsWith('oc_') ? 'group' : 'p2p',
    senderId,
    mentionBot: true,
  });
  return toast('success', echo ?? '✓');
}

function extractPayload(raw: unknown): CardActionPayload {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  // HTTP 模式下事件包一层 { schema, header, event, action, ... }，也可能直接平铺；
  // WS 模式下大多平铺。都兼容。
  const ev = (r['event'] as CardActionPayload | undefined) ?? (r as CardActionPayload);
  return ev;
}

function normalizeValue(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toast(
  type: 'info' | 'success' | 'warning' | 'error',
  content: string,
): ToastResponse {
  return { toast: { type, content } };
}

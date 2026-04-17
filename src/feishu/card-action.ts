import * as Lark from '@larksuiteoapi/node-sdk';
import http from 'node:http';
import { log } from '../logger.js';
import type { Router } from './router.js';
import type { CommandDeps } from '../commands/types.js';

/**
 * 卡片按钮回调分发器。
 *
 * 飞书 Node SDK 的卡片按钮回调走 HTTP webhook（不在 WSClient 事件流里），
 * 因此 v3 额外起一个 HTTP listener。按钮 `value` 约定：
 *   { cmd: string, args?: string, echo?: string, decision?: 'allow'|'deny' }
 *
 * `cmd === '__approve'` 是审批专用保留命令，由 engine/hooks.ts 挂钩 resolver。
 */
export interface CardActionDeps {
  router: Router;
  deps: CommandDeps;
  approvalResolver: (requestId: string, decision: 'allow' | 'deny') => boolean;
  verificationToken?: string;
  encryptKey?: string;
}

export function buildCardActionHandler(d: CardActionDeps): Lark.CardActionHandler {
  const opts: { verificationToken?: string; encryptKey?: string } = {};
  if (d.verificationToken) opts.verificationToken = d.verificationToken;
  if (d.encryptKey) opts.encryptKey = d.encryptKey;

  return new Lark.CardActionHandler(opts as never, async (raw: unknown) => {
    try {
      return await dispatch(raw as CardActionEvent, d);
    } catch (err) {
      log().error({ err }, '卡片回调处理失败');
      return toast('error', '处理失败');
    }
  });
}

interface CardActionEvent {
  event?: {
    operator?: { open_id?: string };
    context?: { open_chat_id?: string; open_message_id?: string };
    action?: { value?: Record<string, unknown>; tag?: string };
  };
}

interface ToastResp {
  toast?: { type: string; content: string };
  card?: unknown;
}

function toast(type: 'info' | 'success' | 'warning' | 'error', content: string): ToastResp {
  return { toast: { type, content } };
}

async function dispatch(event: CardActionEvent, d: CardActionDeps): Promise<ToastResp> {
  const ev = event.event;
  if (!ev?.action) return toast('info', '✓');

  const value = ev.action.value ?? {};
  const cmd = String(value['cmd'] ?? '');
  const args = String(value['args'] ?? '');
  const echo = typeof value['echo'] === 'string' ? value['echo'] : undefined;
  const senderId = ev.operator?.open_id ?? '';
  const chatId = ev.context?.open_chat_id ?? '';
  const messageId = ev.context?.open_message_id ?? '';

  if (cmd === '__approve') {
    const decision = value['decision'] === 'deny' ? 'deny' : 'allow';
    const ok = d.approvalResolver(args, decision);
    return toast(ok ? (decision === 'allow' ? 'success' : 'warning') : 'error',
                 ok ? (decision === 'allow' ? '✅ 已允许' : '❌ 已拒绝') : '审批已过期');
  }

  if (!cmd) return toast('info', echo ?? '✓');

  const cmdLine = args ? `/${cmd} ${args}` : `/${cmd}`;
  const meta = {
    messageId,
    chatId,
    chatType: chatId.startsWith('oc_') ? 'group' : 'p2p',
    senderId,
    mentionBot: true,
  };
  await d.router.dispatch(cmdLine, meta);
  return toast('success', echo ?? '✓');
}

export function startCardHttpServer(handler: Lark.CardActionHandler, port: number, path = '/webhook/card'): http.Server {
  const server = http.createServer();
  server.on('request', Lark.adaptDefault(path, handler));
  server.listen(port, () => log().info({ port, path }, '卡片回调 HTTP server 已启动'));
  return server;
}

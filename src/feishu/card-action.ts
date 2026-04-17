import { log } from '../logger.js';
import type { Router } from './router.js';
import type { CommandDeps } from '../commands/types.js';

/**
 * 卡片按钮回调分发。
 *
 * 飞书 WSClient 长连接推送 `card.action.trigger` 事件，
 * EventDispatcher.invoke 调用 handler 后将返回值（Toast/Card JSON）
 * base64 编码回写到 WS 帧 respPayload.data（sdk lib/index.js:85575-85578），
 * 和 Go SDK `OnP2CardActionTrigger` 完全等效，无需 HTTP webhook。
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

export function buildCardActionHandler(
  d: CardActionDeps,
): (data: unknown) => Promise<ToastResponse> {
  return async (raw) => {
    try {
      return await dispatch(extractPayload(raw), d);
    } catch (err) {
      log().error({ err }, '卡片回调处理失败');
      return toast('error', '处理失败');
    }
  };
}

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

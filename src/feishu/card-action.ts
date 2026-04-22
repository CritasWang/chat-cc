import { log } from '../logger.js';
import type { Router } from './router.js';
import type { CommandDeps } from '../commands/types.js';
import { parseThreadKey, normalizeSlot } from '../engine/pool.js';

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
  isAllowed: (senderId: string, chatId: string) => boolean;
  renderRefreshCard?: (refresh: string, chatId: string, senderId: string) => unknown | undefined;
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

  const senderId = ev.operator?.open_id ?? '';
  const chatId = ev.open_chat_id ?? ev.context?.open_chat_id ?? '';

  if (!d.isAllowed(senderId, chatId)) {
    log().warn({ senderId, chatId }, '卡片回调权限拒绝');
    return toast('error', '未授权');
  }

  const value = normalizeValue(ev.action.value);
  const cmd = String(value['cmd'] ?? '');
  const args = String(value['args'] ?? '');
  const echo = typeof value['echo'] === 'string' ? value['echo'] : undefined;
  const refresh = typeof value['refresh'] === 'string' ? value['refresh'] : undefined;
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

  // refresh 场景：先执行命令（静默，不走 router 的回复），再原地刷新卡片
  if (refresh && d.renderRefreshCard && messageId) {
    // 会话操作需要把 slot 名解析为完整 threadKey
    if (cmd === 'session' && (args.startsWith('stop') || args.startsWith('switch'))) {
      const isStop = args.startsWith('stop');
      const target = args.replace(/^(stop|switch)\s*/, '').trim();
      if (target) {
        const scoped = d.deps.pool.listByScope(chatId, senderId);
        const slot = normalizeSlot(target);
        const hit = scoped.find((s) => parseThreadKey(s.threadKey).slot === slot);
        if (hit) {
          if (isStop) {
            await d.deps.pool.stop(hit.threadKey, { keepMeta: false });
          } else {
            // switch: 若只有 meta（恢复态）则 lazy start，否则仅切换 active
            const parsed = parseThreadKey(hit.threadKey);
            const meta = d.deps.pool.getMeta(hit.threadKey);
            if (meta && !d.deps.pool.get(hit.threadKey)) {
              d.deps.pool.start(
                { chatId: parsed.chatId, senderId: parsed.senderId, slot: parsed.slot },
                meta.cwd,
              );
            } else {
              const userKey = senderId || chatId;
              d.deps.pool.setActive(userKey, hit.threadKey);
            }
          }
        }
      }
    }
    const refreshedCard = d.renderRefreshCard(refresh, chatId, senderId);
    if (refreshedCard) {
      return { toast: { type: 'success', content: echo ?? '✓' }, card: { type: 'raw', data: refreshedCard } };
    }
  }

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

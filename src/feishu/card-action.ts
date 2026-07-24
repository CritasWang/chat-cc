import { log } from '../logger.js';
import type { Router } from './router.js';
import type { CommandDeps } from '../commands/types.js';
import { parseThreadKey, normalizeSlot, SessionPoolCapacityError } from '../engine/pool.js';
import type { CallbackStore } from './callback-store.js';
import { getAskCard, removeAskCard } from './ask-store.js';
import { renderAskUserCard, composeAnswer } from './cards/ask-user.js';
import { canAccessSession, listAccessibleSessions } from '../commands/session-context.js';
import type { ApprovalActor } from '../engine/hooks.js';
import type { MessageMeta } from './router.js';
import { PendingQueueCapacityError } from '../engine/pending-queue.js';

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
  approvalResolver: (
    requestId: string,
    decision: 'allow' | 'deny',
    actor: ApprovalActor,
  ) => 'resolved' | 'forbidden' | 'missing';
  isAllowed: (senderId: string, chatId: string) => boolean;
  isPrivileged?: (senderId: string) => boolean;
  resolveThreadId?: (chatId: string, messageId: string) => Promise<string | undefined>;
  renderRefreshCard?: (refresh: string, meta: MessageMeta) => unknown | Promise<unknown>;
  /** 回调防重放（可选注入，缺省不启用） */
  callbackStore?: CallbackStore;
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
  const messageId = ev.open_message_id ?? ev.context?.open_message_id ?? '';

  if (!d.isAllowed(senderId, chatId)) {
    log().warn({ senderId, chatId }, '卡片回调权限拒绝');
    return toast('error', '未授权');
  }

  const value = normalizeValue(ev.action.value);
  const cmd = String(value['cmd'] ?? '');
  const args = String(value['args'] ?? '');
  const echo = typeof value['echo'] === 'string' ? value['echo'] : undefined;
  const refresh = typeof value['refresh'] === 'string' ? value['refresh'] : undefined;
  const actionMeta: MessageMeta = {
    messageId,
    chatId,
    chatType: chatId.startsWith('oc_') ? 'group' : 'p2p',
    senderId,
    mentionBot: true,
  };

  // 所有按钮点击（中断/审批/切换等）统一留痕，排障时可对照消息日志还原操作序列
  log().info({ cmd, args, senderId, chatId, messageId }, '收到卡片回调');

  if (cmd === '__approve') {
    const decision = value['decision'] === 'deny' ? 'deny' : 'allow';
    const result = d.approvalResolver(args, decision, {
      senderId,
      chatId,
      privileged: d.isPrivileged?.(senderId) ?? false,
    });
    if (result === 'forbidden') return toast('error', '仅请求发起人或管理员可审批');
    return toast(
      result === 'resolved' ? (decision === 'allow' ? 'success' : 'warning') : 'error',
      result === 'resolved' ? (decision === 'allow' ? '✅ 已允许' : '❌ 已拒绝') : '审批已过期',
    );
  }

  // AskUserQuestion 提问卡：点选原地反馈，答完自动/手动提交
  if (cmd === '__ask') {
    return await handleAskAction(messageId, args, d, { senderId, chatId });
  }

  if (!cmd) return toast('info', echo ?? '✓');

  // 只有需要路由/刷新的命令才补查 thread_id。审批、Ask 和纯 Toast 均是本地状态
  // 操作，不应被额外 REST 查询的网络故障阻断。
  if (chatId && messageId && d.resolveThreadId) {
    try {
      const threadId = await d.resolveThreadId(chatId, messageId);
      if (threadId) actionMeta.threadId = threadId;
    } catch (err) {
      log().warn({ err, chatId, messageId }, '卡片所在话题解析失败');
      return toast('error', '无法确认卡片所属话题，请稍后重试');
    }
  }

  // 防重放放在必要的话题解析之后：解析失败时用户仍可重试。
  // 1. 一次性 nonce（按钮 value 显式携带时）— 永久防重复
  const nonce = typeof value['nonce'] === 'string' ? value['nonce'] : undefined;
  if (nonce && d.callbackStore && !d.callbackStore.consume(nonce)) {
    log().info({ nonce, cmd }, '卡片回调 nonce 已消费，拒绝重放');
    return toast('warning', '该操作已执行过');
  }
  // 2. 短窗口去重 — 防双击。审批由 gate 自身 one-shot，Ask 由 submitted 状态防重。
  if (!nonce && d.callbackStore) {
    // 纳入操作人，避免群内其他用户先点一次就占用卡片级去重窗口，
    // 导致真正有权的会话所有者短时间内无法操作。
    const dedupeKey = `${messageId}:${senderId}:${cmd}:${args}`;
    if (!d.callbackStore.dedupe(dedupeKey)) {
      log().info({ cmd, args, messageId }, '卡片回调短窗口重复，忽略');
      return toast('info', '处理中…');
    }
  }

  // refresh 场景：先执行命令（静默，不走 router 的回复），再原地刷新卡片
  if (refresh && d.renderRefreshCard && messageId) {
    // 会话操作需要把 slot 名解析为完整 threadKey
    if (cmd === 'session' && (args.startsWith('stop') || args.startsWith('switch'))) {
      const isStop = args.startsWith('stop');
      const target = args.replace(/^(stop|switch)\s*/, '').trim();
      if (target) {
        // 优先按完整 threadKey 匹配（status 卡的关闭按钮可指向任意群的会话），
        // 否则按本群 slot 名解析
        let hit: { threadKey: string } | undefined =
          target.includes(':') &&
          d.deps.pool.getMeta(target) &&
          canAccessSession(actionMeta, target)
            ? { threadKey: target }
            : undefined;
        if (!hit) {
          const scoped = listAccessibleSessions(actionMeta, d.deps.pool);
          const slot = normalizeSlot(target);
          hit = scoped.find((s) => parseThreadKey(s.threadKey).slot === slot);
        }
        if (hit) {
          if (isStop) {
            await d.deps.pool.stop(hit.threadKey, { keepMeta: false, reason: 'destroy' });
          } else {
            // switch: 若只有 meta（恢复态）则 lazy start，否则仅切换 active
            const parsed = parseThreadKey(hit.threadKey);
            const meta = d.deps.pool.getMeta(hit.threadKey);
            if (meta && !d.deps.pool.get(hit.threadKey)) {
              try {
                d.deps.pool.start(
                  { chatId: parsed.chatId, senderId: parsed.senderId, slot: parsed.slot },
                  meta.cwd,
                );
              } catch (err) {
                if (err instanceof SessionPoolCapacityError) {
                  return toast('warning', `活跃会话已达上限（${err.limit}），请先关闭不用的会话`);
                }
                throw err;
              }
            } else {
              const userKey = `${chatId}|${senderId || chatId}`;
              d.deps.pool.setActive(userKey, hit.threadKey);
            }
          }
        }
      }
    }
    const refreshedCard = await d.renderRefreshCard(refresh, actionMeta);
    if (refreshedCard) {
      return { toast: { type: 'success', content: echo ?? '✓' }, card: { type: 'raw', data: refreshedCard } };
    }
  }

  const cmdLine = args ? `/${cmd} ${args}` : `/${cmd}`;
  await d.router.dispatch(cmdLine, actionMeta);

  return toast('success', echo ?? '✓');
}

/**
 * 提问卡片点选处理：
 * - `qIdx:optIdx`：单选题选中即答（同题再点换选）；多选题点选切换
 * - `submit`：手动提交（有多选题时出现提交按钮）
 * 全部题目答完（且无多选题）自动提交 —— 提交 = 汇总答案发给会话 +
 * 卡片 PATCH 为终态（绿头「已回答」），用户明确知道操作已完成。
 */
async function handleAskAction(
  messageId: string,
  args: string,
  d: CardActionDeps,
  actor: { senderId: string; chatId: string },
): Promise<ToastResponse> {
  const state = messageId ? getAskCard(messageId) : undefined;
  if (!state) {
    return toast('warning', '该提问已失效（服务重启过），请直接发消息回答');
  }
  if (Date.now() > state.expiresAt) {
    removeAskCard(messageId);
    return toast('warning', '该提问已过期，请直接发消息回答');
  }
  if (state.chatId && state.chatId !== actor.chatId) {
    return toast('error', '该提问不属于当前会话');
  }
  if (
    state.requesterId &&
    state.requesterId !== actor.senderId &&
    !(d.isPrivileged?.(actor.senderId) ?? false)
  ) {
    return toast('error', '仅提问发起人或管理员可回答');
  }
  if (state.generation && d.deps.pool.generationOf(state.threadKey) !== state.generation) {
    removeAskCard(messageId);
    return toast('warning', '会话已重置，该提问已失效');
  }
  if (state.submitted) return toast('info', '已提交过，无需重复操作');

  if (args !== 'submit') {
    const [qiRaw, oiRaw] = args.split(':');
    const qi = Number(qiRaw);
    const oi = Number(oiRaw);
    const q = state.questions[qi];
    if (!q || !q.options[oi]) return toast('error', '选项无效');

    const sel = state.selections[qi]!;
    if (q.multiSelect) {
      // 多选：切换
      const at = sel.indexOf(oi);
      if (at >= 0) sel.splice(at, 1);
      else sel.push(oi);
    } else {
      // 单选：替换
      state.selections[qi] = [oi];
    }

    // 中间态：PATCH 卡片反馈已选；提交始终由用户点「提交回答」显式触发
    await d.deps.replier.patchCard(messageId, renderAskUserCard(state));
    const remaining = state.questions.length - state.selections.filter((x) => x.length > 0).length;
    return toast(
      'success',
      remaining > 0 ? `已选 · 还剩 ${remaining} 题` : '已选好，点「提交回答」发送',
    );
  }

  // 手动提交
  if (state.selections.every((x) => x.length === 0)) {
    return toast('warning', '还没有选择任何选项');
  }
  return await submitAsk(messageId, state, d);
}

async function submitAsk(
  messageId: string,
  state: NonNullable<ReturnType<typeof getAskCard>>,
  d: CardActionDeps,
): Promise<ToastResponse> {
  state.submitted = true;
  const answer = composeAnswer(state);

  // 答案投递给会话（走 pending 队列与普通消息一致）
  let sess = d.deps.pool.get(state.threadKey);
  if (!sess) {
    const m = d.deps.pool.getMeta(state.threadKey);
    if (m) {
      try {
        sess = d.deps.pool.start(parseThreadKey(state.threadKey), m.cwd);
      } catch (err) {
        state.submitted = false;
        if (err instanceof SessionPoolCapacityError) {
          return toast('warning', `活跃会话已达上限（${err.limit}），请先关闭不用的会话`);
        }
        throw err;
      }
    }
  }
  if (!sess) {
    state.submitted = false;
    return toast('error', '会话已不存在，无法提交（可直接发消息回答）');
  }
  try {
    d.deps.pending.push(state.threadKey, answer, state.requesterId);
  } catch (err) {
    state.submitted = false;
    if (err instanceof PendingQueueCapacityError) {
      return toast('warning', '会话积压已满，请等待当前任务结束后再提交');
    }
    throw err;
  }

  // 卡片 PATCH 为终态
  await d.deps.replier.patchCard(messageId, renderAskUserCard(state));
  removeAskCard(messageId);
  log().info({ messageId, threadKey: state.threadKey }, '提问卡已提交');
  return toast('success', '✅ 已提交给 Claude');
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

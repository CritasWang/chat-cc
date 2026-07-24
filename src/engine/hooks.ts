import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { previewJson } from '../utils.js';
import { log } from '../logger.js';
import { renderApprovalCard, renderApprovalResolved, type ApprovalCardSpec } from '../feishu/cards/approval.js';
import type { Replier } from '../feishu/replier.js';
import { randomUUID } from 'node:crypto';

/** Pending 审批表：requestId → { resolve, spec, messageId, timer } */
interface PendingApproval {
  resolve: (decision: 'allow' | 'deny') => void;
  spec: ApprovalCardSpec;
  messageId?: string;
  timer?: NodeJS.Timeout;
  decision?: 'allow' | 'deny';
}

export interface ApprovalActor {
  senderId: string;
  chatId: string;
  privileged?: boolean;
}

export interface ApprovalGate {
  /** 供 canUseTool 调用：打开审批卡片，等用户点按钮 */
  request: (
    spec: ApprovalCardSpec,
    chatId: string,
    timeoutMs: number,
    replyTarget?: { rootMessageId: string; inThread: boolean },
  ) => Promise<'allow' | 'deny'>;
  /** 供 CardActionHandler 调用：用户按下按钮时 resolve */
  resolve: (
    requestId: string,
    decision: 'allow' | 'deny',
    actor?: ApprovalActor,
  ) => 'resolved' | 'forbidden' | 'missing';
  /** 清空（退出/测试） */
  clear: () => void;
}

export function createApprovalGate(replier: Replier): ApprovalGate {
  const pending = new Map<string, PendingApproval>();

  return {
    async request(spec, chatId, timeoutMs, replyTarget) {
      let settle!: (decision: 'allow' | 'deny') => void;
      let settled = false;
      const decisionPromise = new Promise<'allow' | 'deny'>((resolve) => {
        settle = resolve;
      });
      const rec: PendingApproval = {
        spec,
        resolve: (decision) => {
          if (settled) return;
          settled = true;
          rec.decision = decision;
          settle(decision);
        },
      };

      // 先注册再发送：卡片刚创建即被点击时，也不会因 pending 尚未写入而误报过期。
      pending.set(spec.requestId, rec);
      let mid: string | undefined;
      try {
        mid = replyTarget
          ? await replier.replyCard(
              replyTarget.rootMessageId,
              renderApprovalCard(spec),
              { inThread: replyTarget.inThread },
            )
          : await replier.sendCard(chatId, renderApprovalCard(spec));
      } catch (err) {
        log().error({ err, requestId: spec.requestId, tool: spec.toolName }, '审批卡片发送异常');
      }
      if (!mid) {
        if (pending.get(spec.requestId) === rec) pending.delete(spec.requestId);
        log().error({ requestId: spec.requestId, tool: spec.toolName }, '审批卡片发送失败，立即 deny');
        rec.resolve('deny');
        return decisionPromise;
      }

      rec.messageId = mid;
      // 极端情况下用户可能在 sendCard 返回前已完成点击；拿到 messageId 后补 PATCH 终态。
      if (rec.decision) {
        void replier.patchCard(mid, renderApprovalResolved(spec, rec.decision));
        return decisionPromise;
      }

      if (timeoutMs > 0 && pending.get(spec.requestId) === rec) {
        const timer = setTimeout(() => {
          const r = pending.get(spec.requestId);
          if (r !== rec) return;
          pending.delete(spec.requestId);
          log().warn({ requestId: spec.requestId, tool: spec.toolName }, '审批超时，默认 deny');
          r.resolve('deny');
          if (r.messageId) void replier.patchCard(r.messageId, renderApprovalResolved(r.spec, 'deny'));
        }, timeoutMs);
        timer.unref?.();
        rec.timer = timer;
      }
      return decisionPromise;
    },

    resolve(requestId, decision, actor) {
      const rec = pending.get(requestId);
      if (!rec) return 'missing';
      if (
        actor &&
        !actor.privileged &&
        (actor.chatId !== rec.spec.chatId || actor.senderId !== rec.spec.requesterId)
      ) {
        return 'forbidden';
      }
      pending.delete(requestId);
      if (rec.timer) clearTimeout(rec.timer);
      rec.resolve(decision);
      if (rec.messageId) {
        void replier.patchCard(rec.messageId, renderApprovalResolved(rec.spec, decision));
      }
      return 'resolved';
    },

    clear() {
      for (const rec of pending.values()) {
        if (rec.timer) clearTimeout(rec.timer);
        rec.resolve('deny');
      }
      pending.clear();
    },
  };
}

export interface HookBuildOptions {
  threadKey: string;
  chatId: string;
  gate: ApprovalGate;
  autoApprovePatterns: RegExp[];
  timeoutMs: number;
  requesterId?: string;
  getRequesterId?: () => string | undefined;
  /** 话题会话的卡片回复锚点；缺省则直接发群。 */
  getReplyTarget?: () => { rootMessageId: string; inThread: boolean } | undefined;
}

/** 构建 canUseTool 回调：对接审批卡片，并在 SDK AbortSignal 触发时立即放行为 deny */
export function buildCanUseTool(opts: HookBuildOptions): CanUseTool {
  return async (toolName, input, { signal }): Promise<PermissionResult> => {
    if (signal.aborted) return { behavior: 'deny', message: '已中断' };

    if (opts.autoApprovePatterns.some((r) => r.test(toolName))) {
      return { behavior: 'allow', updatedInput: input };
    }
    const requestId = `${opts.threadKey}:${toolName}:${randomUUID()}`;
    const requesterId = opts.requesterId ?? opts.getRequesterId?.() ?? '';
    const preview = previewJson(input, 1500);

    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<'abort'>((resolve) => {
      if (signal.aborted) return resolve('abort');
      onAbort = () => resolve('abort');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const approvalPromise = opts.gate.request(
      {
        requestId,
        toolName,
        toolInputPreview: preview,
        threadKey: opts.threadKey,
        requesterId,
        chatId: opts.chatId,
      },
      opts.chatId,
      opts.timeoutMs,
      opts.getReplyTarget?.(),
    );

    const winner = await Promise.race([approvalPromise, abortPromise]);
    if (onAbort) signal.removeEventListener('abort', onAbort);

    if (winner === 'abort') {
      // 清理仍挂起的审批卡片
      opts.gate.resolve(requestId, 'deny');
      return { behavior: 'deny', message: '会话已中断' };
    }
    if (winner === 'allow') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: '用户在飞书端拒绝' };
  };
}

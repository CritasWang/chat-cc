import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { previewJson } from '../utils.js';
import { log } from '../logger.js';
import { renderApprovalCard, renderApprovalResolved, type ApprovalCardSpec } from '../feishu/cards/approval.js';
import type { Replier } from '../feishu/replier.js';

/** Pending 审批表：requestId → { resolve, spec, messageId, timer } */
interface PendingApproval {
  resolve: (decision: 'allow' | 'deny') => void;
  spec: ApprovalCardSpec;
  messageId?: string;
  timer?: NodeJS.Timeout;
}

export interface ApprovalGate {
  /** 供 canUseTool 调用：打开审批卡片，等用户点按钮 */
  request: (spec: ApprovalCardSpec, chatId: string, timeoutMs: number) => Promise<'allow' | 'deny'>;
  /** 供 CardActionHandler 调用：用户按下按钮时 resolve */
  resolve: (requestId: string, decision: 'allow' | 'deny') => boolean;
  /** 清空（退出/测试） */
  clear: () => void;
}

export function createApprovalGate(replier: Replier): ApprovalGate {
  const pending = new Map<string, PendingApproval>();

  return {
    async request(spec, chatId, timeoutMs) {
      const mid = await replier.sendCard(chatId, renderApprovalCard(spec));
      return new Promise<'allow' | 'deny'>((resolve) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          const r = pending.get(spec.requestId);
          if (!r) return;
          pending.delete(spec.requestId);
          log().warn({ requestId: spec.requestId, tool: spec.toolName }, '审批超时，默认 deny');
          r.resolve('deny');
        }, timeoutMs) : undefined;

        const rec: PendingApproval = { resolve, spec };
        if (mid) rec.messageId = mid;
        if (timer) rec.timer = timer;
        pending.set(spec.requestId, rec);
      });
    },

    resolve(requestId, decision) {
      const rec = pending.get(requestId);
      if (!rec) return false;
      pending.delete(requestId);
      if (rec.timer) clearTimeout(rec.timer);
      rec.resolve(decision);
      if (rec.messageId) {
        void replier.patchCard(rec.messageId, renderApprovalResolved(rec.spec, decision));
      }
      return true;
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
}

/** 构建 canUseTool 回调：对接审批卡片，并在 SDK AbortSignal 触发时立即放行为 deny */
export function buildCanUseTool(opts: HookBuildOptions): CanUseTool {
  return async (toolName, input, { signal }): Promise<PermissionResult> => {
    if (signal.aborted) return { behavior: 'deny', message: '已中断' };

    if (opts.autoApprovePatterns.some((r) => r.test(toolName))) {
      return { behavior: 'allow', updatedInput: input };
    }
    const requestId = `${opts.threadKey}:${toolName}:${Date.now()}`;
    const preview = previewJson(input, 1500);

    const abortPromise = new Promise<'abort'>((resolve) => {
      if (signal.aborted) return resolve('abort');
      signal.addEventListener('abort', () => resolve('abort'), { once: true });
    });
    const approvalPromise = opts.gate.request(
      { requestId, toolName, toolInputPreview: preview, threadKey: opts.threadKey },
      opts.chatId,
      opts.timeoutMs,
    );

    const winner = await Promise.race([approvalPromise, abortPromise]);

    if (winner === 'abort') {
      // 清理仍挂起的审批卡片
      opts.gate.resolve(requestId, 'deny');
      return { behavior: 'deny', message: '会话已中断' };
    }
    if (winner === 'allow') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: '用户在飞书端拒绝' };
  };
}

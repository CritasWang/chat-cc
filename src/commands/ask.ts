import { existsSync } from 'node:fs';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../logger.js';
import { resolveCwd } from '../config.js';
import { buildCanUseTool } from '../engine/hooks.js';
import { translateSdkMessage } from '../engine/events.js';
import {
  applyEvent,
  closeStreamingText,
  fullText,
  initialLiveState,
  renderLiveCard,
} from '../feishu/cards/live.js';
import type { CommandFn } from './types.js';

/** 活跃的 /ask 查询，支持外部中断 */
const activeAskQueries = new Map<string, { interrupt(): Promise<void> }>();

/** 从外部中断一个 /ask 查询，成功返回 true */
export function interruptAsk(key: string): boolean {
  const q = activeAskQueries.get(key);
  if (!q) return false;
  void q.interrupt();
  return true;
}

/**
 * /ask [@alias] <question>
 * 无状态单次提问 — 每次起一个独立 query，不保留上下文。
 * 用流式卡片即时反馈（立刻发占位卡片，SDK 事件到来时节流 patch）。
 */
export const askCommand: CommandFn = async (args, meta, { cfg, replier, gate, apiProfiles }, extra) => {
  const trimmed = args.trim();
  if (!trimmed) return '用法: /ask [@项目别名] <问题>';

  let prompt = trimmed;
  let cwd = cfg.default_cwd;
  if (trimmed.startsWith('@')) {
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx > 0) {
      cwd = resolveCwd(cfg, trimmed.slice(0, spaceIdx));
      prompt = trimmed.slice(spaceIdx + 1).trim();
    }
  }
  if (!prompt) return '用法: /ask [@项目别名] <问题>';

  // 校验工作目录是否存在
  if (!existsSync(cwd)) {
    return `❌ 路径不存在: \`${cwd}\`\n请检查路径或项目别名是否正确。`;
  }

  const state = initialLiveState(`ask:${meta.senderId || meta.chatId}`, {
    stateless: true,
    cwd,
    ...(extra?.fallbackFromNoSession ? { fallbackFromNoSession: true } : {}),
  });

  const placeholderMid = await replier.replyCard(meta.messageId, renderLiveCard(state));
  if (!placeholderMid) {
    log().warn({ rootMessageId: meta.messageId }, '/ask 占位卡片发送失败，降级走文本返回');
  }

  const throttleMs = cfg.stream_throttle_ms;
  let lastPatchAt = 0;
  let patchTimer: NodeJS.Timeout | undefined;
  let patchChain: Promise<void> = Promise.resolve();

  const flush = (): void => {
    if (patchTimer) {
      clearTimeout(patchTimer);
      patchTimer = undefined;
    }
    if (!placeholderMid) return;
    patchChain = patchChain.then(async () => {
      const ok = await replier.patchCard(placeholderMid, renderLiveCard(state));
      if (ok) lastPatchAt = Date.now();
    });
  };
  const schedule = (): void => {
    if (patchTimer || !placeholderMid) return;
    const since = Date.now() - lastPatchAt;
    const delay = Math.max(0, throttleMs - since);
    patchTimer = setTimeout(() => {
      patchTimer = undefined;
      flush();
    }, delay);
  };

  const envOverrides = apiProfiles?.envOverrides() ?? {};
  const options: Options = {
    cwd,
    allowedTools: cfg.claude_allowed_tools,
    persistSession: false,
    thinking: { type: 'adaptive' },
    // SDK env 为整体替换，必须 spread process.env
    ...(Object.keys(envOverrides).length > 0
      ? { env: { ...(process.env as Record<string, string>), ...envOverrides } }
      : {}),
    ...(cfg.claude_danger_mode
      ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }
      : {
          canUseTool: buildCanUseTool({
            threadKey: state.threadKey,
            chatId: meta.chatId,
            gate,
            autoApprovePatterns: cfg.auto_approve_tools.map((s) => new RegExp(s)),
            timeoutMs: cfg.approval_timeout_ms,
          }),
        }),
  };

  const askKey = state.threadKey;
  try {
    const q = query({ prompt, options });
    activeAskQueries.set(askKey, q);
    const deadline = Date.now() + cfg.claude_ask_timeout_min * 60_000;
    for await (const msg of q) {
      if (Date.now() > deadline) {
        await q.interrupt();
        state.phase = 'error';
        state.error = `超时（>${cfg.claude_ask_timeout_min} 分钟），已中断`;
        flush();
        await patchChain;
        return placeholderMid ? undefined : `⏱ /ask 超时，已中断`;
      }
      for (const ev of translateSdkMessage(msg)) {
        if (ev.kind === 'assistant-text' || ev.kind === 'tool-use' || ev.kind === 'tool-result') {
          applyEvent(state, ev);
          schedule();
        } else if (ev.kind === 'result') {
          state.phase = ev.ok ? 'done' : 'error';
          if (!ev.ok) state.error = ev.text || '执行失败';
          state.usage = ev.usage;
          state.durationMs = ev.durationMs;
          closeStreamingText(state);
          flush();
          await patchChain;
          if (placeholderMid) return;
          return ev.ok
            ? fullText(state).trim() || ev.text || '(空结果)'
            : `/ask 失败: ${ev.text || '未知错误'}`;
        }
      }
    }

    if (state.phase === 'streaming') {
      state.phase = 'done';
      closeStreamingText(state);
      flush();
      await patchChain;
    }
    return placeholderMid ? undefined : fullText(state).trim() || '(空结果)';
  } catch (err) {
    log().error({ err }, '/ask 失败');
    state.phase = 'error';
    state.error = err instanceof Error ? err.message : String(err);
    flush();
    await patchChain;
    return placeholderMid ? undefined : `/ask 失败: ${state.error}`;
  } finally {
    activeAskQueries.delete(askKey);
  }
};

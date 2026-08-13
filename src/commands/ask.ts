import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import { resolveCwd, validateCwd } from "../config.js";
import { buildClaudeEnv } from "../agent/env.js";
import { buildCanUseTool } from "../engine/hooks.js";
import { translateSdkMessage } from "../engine/events.js";
import {
  applyEvent,
  closeStreamingText,
  fullText,
  initialLiveState,
  renderLiveCard,
} from "../feishu/cards/live.js";
import type { CommandFn } from "./types.js";
import { replyOptions } from "../feishu/router.js";

/** 活跃的 /ask 查询，支持外部中断 */
const activeAskQueries = new Map<string, { interrupt(): Promise<void> }>();
const activeAskScopes = new Map<string, Set<string>>();

/** 从外部中断一个或一组 /ask 查询，成功返回 true */
export async function interruptAsk(key: string): Promise<boolean> {
  const q = activeAskQueries.get(key);
  if (q) {
    await q
      .interrupt()
      .catch((err) => log().warn({ err, key }, "/ask 中断失败"));
    return true;
  }
  const scoped = activeAskScopes.get(key);
  if (!scoped || scoped.size === 0) return false;
  const tasks: Promise<void>[] = [];
  for (const askKey of scoped) {
    const active = activeAskQueries.get(askKey);
    if (active)
      tasks.push(
        active
          .interrupt()
          .catch((err) => log().warn({ err, askKey }, "/ask 中断失败")),
      );
  }
  await Promise.all(tasks);
  return true;
}

export function askScopeKey(chatId: string, senderId: string): string {
  return `ask:${chatId}:${senderId || chatId}`;
}

/**
 * /ask [@alias] <question>
 * 无状态单次提问 — 每次起一个独立 query，不保留上下文。
 * 用流式卡片即时反馈（立刻发占位卡片，SDK 事件到来时节流 patch）。
 */
export const askCommand: CommandFn = async (
  args,
  meta,
  { cfg, replier, gate, apiProfiles },
  extra,
) => {
  const trimmed = args.trim();
  if (!trimmed) return "用法: /ask [@项目别名] <问题>";

  let prompt = trimmed;
  let cwd = cfg.default_cwd;
  if (trimmed.startsWith("@")) {
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx > 0) {
      cwd = resolveCwd(cfg, trimmed.slice(0, spaceIdx));
      prompt = trimmed.slice(spaceIdx + 1).trim();
    }
  }
  if (!prompt) return "用法: /ask [@项目别名] <问题>";

  const checkedCwd = validateCwd(cfg, cwd);
  if (!checkedCwd.ok) return `❌ 工作目录不可用: \`${checkedCwd.cwd}\``;
  cwd = checkedCwd.cwd;

  const askKey = `${askScopeKey(meta.chatId, meta.senderId)}:${meta.messageId}`;
  const scopeKey = askScopeKey(meta.chatId, meta.senderId);
  const scoped = activeAskScopes.get(scopeKey) ?? new Set<string>();
  let activeTotal = 0;
  for (const items of activeAskScopes.values()) activeTotal += items.size;
  if (activeTotal >= cfg.max_concurrent_asks) {
    return `⏳ 当前 /ask 并发已满（${cfg.max_concurrent_asks}），请稍后再试`;
  }
  if (scoped.size >= cfg.max_concurrent_asks_per_user) {
    return `⏳ 你已有 ${scoped.size} 个 /ask 在运行，请先等待或用 /stop 中断`;
  }
  // 在首次 await（占位卡发送）前同步占位，避免并发请求同时穿透上限检查。
  scoped.add(askKey);
  activeAskScopes.set(scopeKey, scoped);
  let interruptedBeforeStart = false;
  const reservationHandle = {
    interrupt: async () => {
      interruptedBeforeStart = true;
    },
  };
  activeAskQueries.set(askKey, reservationHandle);
  let activeHandle: { interrupt(): Promise<void> } | undefined;

  try {
    const state = initialLiveState(askKey, {
      stateless: true,
      cwd,
      ...(extra?.fallbackFromNoSession ? { fallbackFromNoSession: true } : {}),
    });

    const placeholderMid = await replier.replyCard(
      meta.messageId,
      renderLiveCard(state),
      replyOptions(meta),
    );
    if (!placeholderMid) {
      log().warn(
        { rootMessageId: meta.messageId },
        "/ask 占位卡片发送失败，降级走文本返回",
      );
    }
    if (interruptedBeforeStart) {
      state.phase = "interrupted";
      if (placeholderMid)
        await replier.patchCard(placeholderMid, renderLiveCard(state));
      return placeholderMid ? undefined : "🛑 /ask 已中断";
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
        const ok = await replier.patchCard(
          placeholderMid,
          renderLiveCard(state),
        );
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

    // /ask 是一次性查询，不走会话池 → 只跟随全局 profile 与全局模型
    const { env } = buildClaudeEnv({
      profileOverrides: apiProfiles?.envOverrides() ?? {},
      globalModel: cfg.claude_model,
    });
    const options: Options = {
      cwd,
      allowedTools: cfg.claude_allowed_tools,
      persistSession: false,
      thinking: { type: "adaptive" },
      env,
      ...(cfg.claude_danger_mode
        ? {
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
          }
        : {
            canUseTool: buildCanUseTool({
              threadKey: state.threadKey,
              chatId: meta.chatId,
              gate,
              requesterId: meta.senderId,
              getReplyTarget: () => meta.threadId
                ? { rootMessageId: meta.messageId, inThread: true }
                : undefined,
              autoApprovePatterns: cfg.auto_approve_tools.map(
                (s) => new RegExp(s),
              ),
              timeoutMs: cfg.approval_timeout_ms,
            }),
          }),
    };

    const abortController = new AbortController();
    options.abortController = abortController;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let externallyInterrupted = false;
    let q: ReturnType<typeof query> | undefined;
    try {
      const currentQ = query({ prompt, options });
      q = currentQ;
      activeHandle = {
        interrupt: async () => {
          if (externallyInterrupted) return;
          externallyInterrupted = true;
          state.phase = "interrupted";
          closeStreamingText(state);
          flush();
          await patchChain;
          abortController.abort();
          await currentQ.interrupt();
        },
      };
      activeAskQueries.set(askKey, activeHandle);

      const timeoutMs = cfg.claude_ask_timeout_min * 60_000;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          abortController.abort();
          void currentQ.interrupt().catch(() => {});
          reject(new Error(`ASK_TIMEOUT:${timeoutMs}`));
        }, timeoutMs);
        timer.unref?.();
      });
      const iterator = currentQ[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), timeoutPromise]);
        if (next.done) break;
        const msg = next.value;
        for (const ev of translateSdkMessage(msg)) {
          if (
            ev.kind === "assistant-text" ||
            ev.kind === "tool-use" ||
            ev.kind === "tool-result"
          ) {
            applyEvent(state, ev);
            schedule();
          } else if (ev.kind === "result") {
            if (externallyInterrupted) {
              state.phase = "interrupted";
              closeStreamingText(state);
              flush();
              await patchChain;
              return placeholderMid ? undefined : "🛑 /ask 已中断";
            }
            state.phase = ev.ok ? "done" : "error";
            if (!ev.ok) state.error = ev.text || "执行失败";
            state.usage = ev.usage;
            state.durationMs = ev.durationMs;
            closeStreamingText(state);
            flush();
            await patchChain;
            if (placeholderMid) return;
            return ev.ok
              ? fullText(state).trim() || ev.text || "(空结果)"
              : `/ask 失败: ${ev.text || "未知错误"}`;
          }
        }
      }

      if (state.phase === "streaming" || externallyInterrupted) {
        state.phase = externallyInterrupted ? "interrupted" : "done";
        closeStreamingText(state);
        flush();
        await patchChain;
      }
      return placeholderMid ? undefined : fullText(state).trim() || "(空结果)";
    } catch (err) {
      if (!externallyInterrupted) log().error({ err }, "/ask 失败");
      state.phase = externallyInterrupted ? "interrupted" : "error";
      state.error = externallyInterrupted
        ? undefined
        : timedOut
          ? `超时（>${cfg.claude_ask_timeout_min} 分钟），已中断`
          : err instanceof Error
            ? err.message
            : String(err);
      flush();
      await patchChain;
      return placeholderMid
        ? undefined
        : externallyInterrupted
          ? "🛑 /ask 已中断"
          : timedOut
            ? "⏱ /ask 超时，已中断"
            : `/ask 失败: ${state.error}`;
    } finally {
      if (timer) clearTimeout(timer);
      q?.close();
      if (activeHandle && activeAskQueries.get(askKey) === activeHandle) {
        activeAskQueries.delete(askKey);
      }
    }
  } finally {
    if (
      activeAskQueries.get(askKey) === reservationHandle ||
      activeAskQueries.get(askKey) === activeHandle
    ) {
      activeAskQueries.delete(askKey);
    }
    const currentScope = activeAskScopes.get(scopeKey);
    currentScope?.delete(askKey);
    if (currentScope?.size === 0) activeAskScopes.delete(scopeKey);
  }
};

import { log } from "../logger.js";
import {
  applyEvent,
  closeStreamingText,
  fullText,
  initialLiveState,
  renderLiveCard,
  type LiveCardState,
} from "../feishu/cards/live.js";
import { card, cardHeader, md } from "../feishu/cards/base.js";
import {
  renderAskUserCard,
  parseAskUserInput,
  initialAskState,
} from "../feishu/cards/ask-user.js";
import { registerAskCard } from "../feishu/ask-store.js";
import type { Replier } from "../feishu/replier.js";
import type { EngineEvent, UsageSnapshot } from "./events.js";

interface ReplyTarget {
  rootMessageId: string;
  inThread: boolean;
}

interface Turn {
  chatId: string;
  threadKey: string;
  messageId?: string;
  state: LiveCardState;
  pendingPatch: boolean;
  patchTimer?: NodeJS.Timeout;
  lastPatchAt: number;
  chain: Promise<void>;
  /** 话题会话：本轮所有出站消息锚定到该消息（reply in thread） */
  replyTarget?: ReplyTarget;
}

export interface ResultCtx {
  ok: boolean;
  /** 用户主动中断；调用方仍可记账，但不应发送“失败/完成”提醒。 */
  interrupted?: boolean;
  /** 完成后在源会话补发一条新消息（话题会话自动回到 thread）——卡片 PATCH 不产生未读红点，需要提醒时用这个 */
  sendFollowUp: (text: string) => Promise<void>;
}

export interface StreamerDeps {
  replier: Replier;
  throttleMs: number;
  maxChunkSize?: number;
  onResult?: (
    threadKey: string,
    usage?: UsageSnapshot,
    durationMs?: number,
    ctx?: ResultCtx,
  ) => void | Promise<void>;
  getInteractionContext?: (
    threadKey: string,
  ) => { requesterId: string; chatId: string; generation: number } | undefined;
}

export class LiveStreamer {
  private readonly turns = new Map<string, Turn>();
  private readonly replyTargets = new Map<string, ReplyTarget>();
  private readonly interrupted = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: StreamerDeps) {}

  /**
   * 设置下一轮输出的回复锚点（话题会话用）：
   * 首帧卡片将 reply 到该消息（in thread），而非直接发到群。
   */
  setReplyTarget(threadKey: string, target: ReplyTarget): void {
    this.replyTargets.set(threadKey, target);
  }

  /** 读取当前/下一轮的回复锚点，供审批等带外卡片复用；不消费状态。 */
  replyTargetOf(threadKey: string): ReplyTarget | undefined {
    return this.turns.get(threadKey)?.replyTarget ?? this.replyTargets.get(threadKey);
  }

  /**
   * Session 真正接收一条新 prompt 前清除旧的中断抑制。
   * idle 状态执行 /stop 时 SDK 可能不会补发 result/error；若不在发送边界清理，
   * 下一轮事件会被最长 5 分钟的旧标记整体吞掉。
   */
  beginTurn(threadKey: string): void {
    this.clearInterrupted(threadKey);
  }

  /** PendingQueue 重试耗尽后的用户可见通知；话题会话沿用尚未消费的回复锚点。 */
  async notifyQueueFailure(threadKey: string, chatId: string, text: string): Promise<void> {
    const target = this.replyTargets.get(threadKey);
    this.replyTargets.delete(threadKey);
    const mid = target
      ? await this.deps.replier.replyText(target.rootMessageId, text, { inThread: target.inThread })
      : await this.deps.replier.sendText(chatId, text);
    if (!mid) log().error({ threadKey, chatId }, "积压消息失败通知发送失败");
  }

  /** 会话级带外通知：话题会话回到原 thread，且不消费下一轮直播卡的回复锚点。 */
  async sendNoticeCard(
    threadKey: string,
    chatId: string,
    cardJson: Parameters<Replier["sendCard"]>[1],
  ): Promise<string | undefined> {
    const target = this.replyTargetOf(threadKey);
    return target
      ? this.deps.replier.replyCard(target.rootMessageId, cardJson, { inThread: target.inThread })
      : this.deps.replier.sendCard(chatId, cardJson);
  }

  async onEvent(
    chatId: string,
    threadKey: string,
    ev: EngineEvent,
    cwd?: string,
    engine?: string,
  ): Promise<void> {
    if (this.interrupted.has(threadKey)) {
      // /stop 先把 key 放入抑制表，再中断底层 query。底层随后到达的迟发文本/终态
      // 不能重新 ensureTurn 创建一张“失败”卡；终态仅用于清理与记账。
      if (ev.kind === "result" || ev.kind === "error") {
        this.clearInterrupted(threadKey);
        await this.deps.onResult?.(
          threadKey,
          ev.kind === "result" ? ev.usage : undefined,
          ev.kind === "result" ? ev.durationMs : undefined,
          { ok: false, interrupted: true, sendFollowUp: async () => {} },
        );
      }
      return;
    }
    const turn = this.ensureTurn(chatId, threadKey, ev, cwd, engine);
    if (!turn) return;

    switch (ev.kind) {
      case "init":
        break;
      case "assistant-text":
      case "tool-result":
        applyEvent(turn.state, ev);
        this.schedulePatch(turn);
        break;
      case "tool-use":
        if (ev.name === "AskUserQuestion") {
          const questions = parseAskUserInput(ev.input);
          if (questions.length > 0) {
            // 有状态提问卡：注册 messageId → 状态，点选后原地 PATCH 反馈
            const context = this.deps.getInteractionContext?.(turn.threadKey);
            const askState = initialAskState(
              turn.threadKey,
              questions,
              {
                ...context,
                askToolUseId: ev.id,
              },
            );
            const mid = await this.sendToTurn(
              turn,
              renderAskUserCard(askState),
            );
            if (mid) registerAskCard(mid, askState);
          }
        }
        applyEvent(turn.state, ev);
        this.schedulePatch(turn);
        break;
      case "result":
        turn.state.phase = ev.ok ? "done" : "error";
        if (!ev.ok) turn.state.error = ev.text || "执行失败";
        turn.state.usage = ev.usage;
        turn.state.durationMs = ev.durationMs;
        closeStreamingText(turn.state);
        // 先等首次卡片发送链就绪，再判断是否需要 fallback：
        // cold-start 场景下 result 到达时 ensureTurn 的异步发送链可能还未结束，
        // turn.messageId 暂时为空 ≠ 真正失败
        await turn.chain;
        if (!turn.messageId) {
          await this.sendTerminalFallback(turn, ev);
        }
        await this.flushNow(turn);
        this.turns.delete(threadKey);
        await this.deps.onResult?.(threadKey, ev.usage, ev.durationMs, {
          ok: ev.ok,
          sendFollowUp: this.makeFollowUp(turn),
        });
        break;
      case "error":
        turn.state.phase = "error";
        turn.state.error = ev.message;
        closeStreamingText(turn.state);
        await turn.chain;
        if (!turn.messageId) {
          await this.sendTerminalFallback(turn, ev.message);
        }
        await this.flushNow(turn);
        this.turns.delete(threadKey);
        await this.deps.onResult?.(threadKey, undefined, undefined, {
          ok: false,
          sendFollowUp: this.makeFollowUp(turn),
        });
        break;
    }
  }

  /** 外部主动通知"用户已中断" — 同步摘除 turn 防复用，异步 PATCH 旧卡片 */
  async markInterrupted(threadKey: string): Promise<void> {
    this.clearInterrupted(threadKey);
    const expiry = setTimeout(
      () => this.interrupted.delete(threadKey),
      5 * 60_000,
    );
    expiry.unref?.();
    this.interrupted.set(threadKey, expiry);
    this.replyTargets.delete(threadKey);
    await this.detachTurn(threadKey);
  }

  /** 会话关闭/重启时只摘除旧 turn，不抑制新 generation 的事件。 */
  async discardTurn(threadKey: string): Promise<void> {
    this.clearInterrupted(threadKey);
    this.replyTargets.delete(threadKey);
    await this.detachTurn(threadKey);
  }

  private async detachTurn(threadKey: string): Promise<void> {
    const turn = this.turns.get(threadKey);
    if (!turn) return;
    // 先同步删除：同 threadKey 立即重启时不会找到旧 turn
    this.turns.delete(threadKey);
    turn.state.phase = "interrupted";
    closeStreamingText(turn.state);
    // 异步 PATCH 旧卡片（fire-and-forget，已从 map 摘除，不影响新 turn）
    void this.flushNow(turn).catch((err) =>
      log().warn({ err, threadKey }, "中断卡片 PATCH 失败"),
    );
  }

  /** 底层 interrupt 失败时撤销终态抑制，避免误吞后续正常事件。 */
  cancelInterrupted(threadKey: string): void {
    this.clearInterrupted(threadKey);
  }

  private ensureTurn(
    chatId: string,
    threadKey: string,
    ev: EngineEvent,
    cwd?: string,
    engine?: string,
  ): Turn | undefined {
    let turn = this.turns.get(threadKey);
    if (turn) return turn;

    // 任意事件都必须有可见终点：启动前失败可能直接以 result/error 作为首事件。

    const replyTarget = this.replyTargets.get(threadKey);
    if (replyTarget) this.replyTargets.delete(threadKey);

    turn = {
      chatId,
      threadKey,
      state: initialLiveState(threadKey, {
        ...(cwd ? { cwd } : {}),
        ...(engine ? { engine } : {}),
      }),
      pendingPatch: false,
      lastPatchAt: 0,
      chain: Promise.resolve(),
      ...(replyTarget ? { replyTarget } : {}),
    };
    this.turns.set(threadKey, turn);

    // 立即发卡片首帧（异步），拿到 messageId；后续 PATCH 等 id 就绪
    turn.chain = (async () => {
      const firstCard = renderLiveCard(turn!.state);
      const mid = turn!.replyTarget
        ? await this.deps.replier.replyCard(
            turn!.replyTarget.rootMessageId,
            firstCard,
            {
              inThread: turn!.replyTarget.inThread,
            },
          )
        : await this.deps.replier.sendCard(chatId, firstCard);
      if (mid) turn!.messageId = mid;
      else log().error({ threadKey }, "首次发卡片失败，后续 PATCH 将不可用");
    })().catch((err) => {
      log().error({ err, threadKey }, "首次发卡片异常，终态将走降级消息");
    });
    return turn;
  }

  private schedulePatch(turn: Turn): void {
    if (turn.patchTimer) return;
    const since = Date.now() - turn.lastPatchAt;
    const delay = Math.max(0, this.deps.throttleMs - since);
    turn.patchTimer = setTimeout(() => {
      turn.patchTimer = undefined;
      void this.flushNow(turn).catch((err) =>
        log().warn({ err, threadKey: turn.threadKey }, "直播卡片 PATCH 失败"),
      );
    }, delay);
  }

  private async flushNow(turn: Turn): Promise<void> {
    if (turn.patchTimer) {
      clearTimeout(turn.patchTimer);
      turn.patchTimer = undefined;
    }
    // 串行化：等待 first-send chain 以及上一次 patch
    turn.chain = turn.chain
      .catch((err) => {
        log().warn(
          { err, threadKey: turn.threadKey },
          "直播卡片前序发送链异常，继续收尾",
        );
      })
      .then(async () => {
        if (!turn.messageId) return;
        const result = await this.deps.replier.patchCard(
          turn.messageId,
          renderLiveCard(turn.state),
        );
        if (result.ok) {
          turn.lastPatchAt = Date.now();
          return;
        }

        // 卡片更新失败 — 按原因分别降级
        const isTerminal =
          turn.state.phase === "done" || turn.state.phase === "error";
        const reason = (result as { ok: false; reason: string }).reason;
        const stale = reason === 'stale' || reason === 'size-limit' || reason === 'transient';
        if (stale) {
          // messageId 失效 / 内容超限 / 重试耗尽 → 发新卡片替代
          const newState = reason === 'size-limit'
            ? trimLiveCardState(turn.state)
            : turn.state;
          const newMid = await this.sendToTurn(
            turn,
            renderLiveCard(newState),
          );
          if (newMid) {
            turn.messageId = newMid;
            turn.lastPatchAt = Date.now();
          }
          // size-limit：后续内容还是可能超，但 trim 版本已缩小；继续 PATCH 新卡
          if (reason === 'size-limit') {
            turn.state = newState;
          }
          if (!isTerminal) return;
        }

        // 终态：再发精简卡片 + 内容文本降级
        const text = fullText(turn.state);
        const minState: LiveCardState = {
          ...turn.state,
          blocks: [
            {
              kind: "text",
              content: "（内容过长，已作为消息发送 ↓）",
              streaming: false,
            },
          ],
        };
        await this.deps.replier.patchCard(
          turn.messageId,
          renderLiveCard(minState),
        );
        if (text.trim()) {
          await this.sendBatchedMarkdown(turn, text);
        }
      })
      .catch((err) => {
        log().error(
          { err, threadKey: turn.threadKey },
          "直播卡片更新/降级发送异常",
        );
      });
    await turn.chain;
  }

  /** 生成"本轮结束后补发消息"的发送函数：话题会话回到 thread，否则直接发群 */
  private makeFollowUp(turn: Turn): (text: string) => Promise<void> {
    return async (text: string) => {
      if (turn.replyTarget) {
        await this.deps.replier.replyText(
          turn.replyTarget.rootMessageId,
          text,
          {
            inThread: turn.replyTarget.inThread,
          },
        );
      } else {
        await this.deps.replier.sendText(turn.chatId, text);
      }
    };
  }

  /** 出站卡片：话题会话回复到 thread，否则直接发群 */
  private async sendToTurn(
    turn: Turn,
    cardJson: Parameters<Replier["sendCard"]>[1],
  ): Promise<string | undefined> {
    if (turn.replyTarget) {
      return this.deps.replier.replyCard(
        turn.replyTarget.rootMessageId,
        cardJson,
        {
          inThread: turn.replyTarget.inThread,
        },
      );
    }
    return this.deps.replier.sendCard(turn.chatId, cardJson);
  }

  /** 首次卡片发送失败后，将终态内容作为独立文本消息降级发送 */
  private async sendTerminalFallback(
    turn: Turn,
    resultOrError: EngineEvent | string,
  ): Promise<void> {
    const text =
      typeof resultOrError === "string"
        ? resultOrError
        : resultOrError.kind === "result" && resultOrError.text
          ? resultOrError.text
          : fullText(turn.state);
    const fallback =
      text.trim() ||
      (turn.state.phase === "error"
        ? "执行失败（无详细错误信息）"
        : "执行完成（无文本输出）");
    await this.sendBatchedMarkdown(turn, fallback);
  }

  /** 将长文本分段发送为飞书 Markdown 卡片 */
  private async sendBatchedMarkdown(
    turn: Turn,
    text: string,
    chunkSize = this.deps.maxChunkSize ?? 3500,
  ): Promise<void> {
    const chunks = splitByParagraph(text, chunkSize);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      const title = total === 1 ? "📄 完整内容" : `📄 内容 (${i + 1}/${total})`;
      await this.sendToTurn(
        turn,
        card(cardHeader(title, "grey"), [md(chunks[i]!)]),
      );
    }
  }

  private clearInterrupted(threadKey: string): void {
    const timer = this.interrupted.get(threadKey);
    if (timer) clearTimeout(timer);
    this.interrupted.delete(threadKey);
  }
}

/** 当卡片内容超过飞书尺寸限制时，裁剪 state 中的块内容。 */
function trimLiveCardState(state: LiveCardState): LiveCardState {
  return {
    ...state,
    blocks: state.blocks.map((b) => {
      if (b.kind === 'text' && b.content.length > 2000) {
        return { ...b, content: b.content.slice(0, 2000) + '\n\n…（内容过长，已截断）', streaming: false };
      }
      if (b.kind === 'tool' && b.tool.input.length > 500) {
        return {
          ...b,
          tool: { ...b.tool, input: b.tool.input.slice(0, 500) + '\n…（截断）' },
        };
      }
      return b;
    }),
  };
}

/** 按段落边界拆分长文本，每段不超过 maxLen 字符 */
export function splitByParagraph(text: string, maxLen: number): string[] {
  if (maxLen <= 0) throw new Error("maxLen must be positive");
  if (!text.trim()) return [];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const remaining = text.length - offset;
    if (remaining <= maxLen) {
      chunks.push(text.slice(offset));
      break;
    }

    const window = text.slice(offset, offset + maxLen + 1);
    let cut = window.lastIndexOf("\n\n", maxLen);
    if (cut < Math.floor(maxLen / 3)) cut = window.lastIndexOf("\n", maxLen);
    if (cut < Math.floor(maxLen / 3)) cut = maxLen;
    else if (window.startsWith("\n\n", cut)) cut += 2;
    else if (window[cut] === "\n") cut += 1;

    chunks.push(text.slice(offset, offset + cut));
    offset += cut;
  }
  return chunks;
}

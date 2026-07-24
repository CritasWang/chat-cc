import { log } from '../logger.js';
import {
  applyEvent,
  closeStreamingText,
  fullText,
  initialLiveState,
  renderLiveCard,
  type LiveCardState,
} from '../feishu/cards/live.js';
import { card, cardHeader, md } from '../feishu/cards/base.js';
import { renderAskUserCard, parseAskUserInput, initialAskState } from '../feishu/cards/ask-user.js';
import { registerAskCard } from '../feishu/ask-store.js';
import type { Replier } from '../feishu/replier.js';
import type { EngineEvent, UsageSnapshot } from './events.js';

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
  /** 完成后在源会话补发一条新消息（话题会话自动回到 thread）——卡片 PATCH 不产生未读红点，需要提醒时用这个 */
  sendFollowUp: (text: string) => Promise<void>;
}

export interface StreamerDeps {
  replier: Replier;
  throttleMs: number;
  onResult?: (threadKey: string, usage?: UsageSnapshot, durationMs?: number, ctx?: ResultCtx) => void | Promise<void>;
}

export class LiveStreamer {
  private readonly turns = new Map<string, Turn>();
  private readonly replyTargets = new Map<string, ReplyTarget>();

  constructor(private readonly deps: StreamerDeps) {}

  /**
   * 设置下一轮输出的回复锚点（话题会话用）：
   * 首帧卡片将 reply 到该消息（in thread），而非直接发到群。
   */
  setReplyTarget(threadKey: string, target: ReplyTarget): void {
    this.replyTargets.set(threadKey, target);
  }

  async onEvent(
    chatId: string,
    threadKey: string,
    ev: EngineEvent,
    cwd?: string,
    engine?: string,
  ): Promise<void> {
    const turn = this.ensureTurn(chatId, threadKey, ev, cwd, engine);
    if (!turn) return;

    switch (ev.kind) {
      case 'init':
        break;
      case 'assistant-text':
      case 'tool-result':
        applyEvent(turn.state, ev);
        this.schedulePatch(turn);
        break;
      case 'tool-use':
        if (ev.name === 'AskUserQuestion') {
          const questions = parseAskUserInput(ev.input);
          if (questions.length > 0) {
            // 有状态提问卡：注册 messageId → 状态，点选后原地 PATCH 反馈
            const askState = initialAskState(turn.threadKey, questions);
            const mid = await this.sendToTurn(turn, renderAskUserCard(askState));
            if (mid) registerAskCard(mid, askState);
          }
        }
        applyEvent(turn.state, ev);
        this.schedulePatch(turn);
        break;
      case 'result':
        turn.state.phase = ev.ok ? 'done' : 'error';
        if (!ev.ok) turn.state.error = ev.text || '执行失败';
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
      case 'error':
        turn.state.phase = 'error';
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
    const turn = this.turns.get(threadKey);
    if (!turn) return;
    // 先同步删除：同 threadKey 立即重启时不会找到旧 turn
    this.turns.delete(threadKey);
    turn.state.phase = 'interrupted';
    closeStreamingText(turn.state);
    // 异步 PATCH 旧卡片（fire-and-forget，已从 map 摘除，不影响新 turn）
    void this.flushNow(turn);
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

    // 会话级事件发生时即起占位卡片（init 即给"已连接"反馈，避免冷启动期间用户无感知）
    if (
      ev.kind !== 'assistant-text' &&
      ev.kind !== 'tool-use' &&
      ev.kind !== 'init'
    ) {
      return undefined;
    }

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
        ? await this.deps.replier.replyCard(turn!.replyTarget.rootMessageId, firstCard, {
            inThread: turn!.replyTarget.inThread,
          })
        : await this.deps.replier.sendCard(chatId, firstCard);
      if (mid) turn!.messageId = mid;
      else log().error({ threadKey }, '首次发卡片失败，后续 PATCH 将不可用');
    })();
    return turn;
  }

  private schedulePatch(turn: Turn): void {
    if (turn.patchTimer) return;
    const since = Date.now() - turn.lastPatchAt;
    const delay = Math.max(0, this.deps.throttleMs - since);
    turn.patchTimer = setTimeout(() => {
      turn.patchTimer = undefined;
      void this.flushNow(turn);
    }, delay);
  }

  private async flushNow(turn: Turn): Promise<void> {
    if (turn.patchTimer) {
      clearTimeout(turn.patchTimer);
      turn.patchTimer = undefined;
    }
    // 串行化：等待 first-send chain 以及上一次 patch
    turn.chain = turn.chain.then(async () => {
      if (!turn.messageId) return;
      const ok = await this.deps.replier.patchCard(turn.messageId, renderLiveCard(turn.state));
      if (ok) {
        turn.lastPatchAt = Date.now();
        return;
      }
      // 卡片更新失败 — 仅在终态（done/error）做 fallback
      const isTerminal = turn.state.phase === 'done' || turn.state.phase === 'error';
      if (!isTerminal) return;

      const text = fullText(turn.state);
      // 用精简卡片重试（去掉正文，仅保留状态信息）
      const minState: LiveCardState = {
        ...turn.state,
        blocks: [{ kind: 'text', content: '（内容过长，已作为消息发送 ↓）', streaming: false }],
      };
      await this.deps.replier.patchCard(turn.messageId, renderLiveCard(minState));
      // 全量内容分批发送为文本消息
      if (text.trim()) {
        await this.sendBatchedMarkdown(turn, text);
      }
    });
    await turn.chain;
  }

  /** 生成"本轮结束后补发消息"的发送函数：话题会话回到 thread，否则直接发群 */
  private makeFollowUp(turn: Turn): (text: string) => Promise<void> {
    return async (text: string) => {
      if (turn.replyTarget) {
        await this.deps.replier.replyText(turn.replyTarget.rootMessageId, text, {
          inThread: turn.replyTarget.inThread,
        });
      } else {
        await this.deps.replier.sendText(turn.chatId, text);
      }
    };
  }

  /** 出站卡片：话题会话回复到 thread，否则直接发群 */
  private async sendToTurn(turn: Turn, cardJson: Parameters<Replier['sendCard']>[1]): Promise<string | undefined> {
    if (turn.replyTarget) {
      return this.deps.replier.replyCard(turn.replyTarget.rootMessageId, cardJson, {
        inThread: turn.replyTarget.inThread,
      });
    }
    return this.deps.replier.sendCard(turn.chatId, cardJson);
  }

  /** 首次卡片发送失败后，将终态内容作为独立文本消息降级发送 */
  private async sendTerminalFallback(turn: Turn, resultOrError: EngineEvent | string): Promise<void> {
    const text = typeof resultOrError === 'string'
      ? resultOrError
      : (resultOrError.kind === 'result' && resultOrError.text ? resultOrError.text : fullText(turn.state));
    if (!text.trim()) return;
    await this.sendBatchedMarkdown(turn, text);
  }

  /** 将长文本分段发送为飞书 Markdown 卡片 */
  private async sendBatchedMarkdown(turn: Turn, text: string, chunkSize = 3500): Promise<void> {
    const chunks = splitByParagraph(text, chunkSize);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      const title = total === 1 ? '📄 完整内容' : `📄 内容 (${i + 1}/${total})`;
      await this.sendToTurn(turn, card(cardHeader(title, 'grey'), [md(chunks[i]!)]));
    }
  }
}

/** 按段落边界拆分长文本，每段不超过 maxLen 字符 */
function splitByParagraph(text: string, maxLen: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = '';

  for (const p of paragraphs) {
    const candidate = buf ? buf + '\n\n' + p : p;
    if (candidate.length > maxLen && buf) {
      chunks.push(buf);
      buf = p.length > maxLen ? p.slice(0, maxLen) : p;
    } else if (candidate.length > maxLen) {
      chunks.push(candidate.slice(0, maxLen));
      buf = '';
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
}

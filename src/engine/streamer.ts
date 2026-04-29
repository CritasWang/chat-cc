import { log } from '../logger.js';
import { previewJson } from '../utils.js';
import { renderLiveCard, type LiveCardState } from '../feishu/cards/live.js';
import { card, cardHeader, md } from '../feishu/cards/base.js';
import { renderAskUserCard, parseAskUserInput } from '../feishu/cards/ask-user.js';
import type { Replier } from '../feishu/replier.js';
import type { EngineEvent, UsageSnapshot } from './events.js';

interface Turn {
  chatId: string;
  threadKey: string;
  messageId?: string;
  state: LiveCardState;
  pendingPatch: boolean;
  patchTimer?: NodeJS.Timeout;
  lastPatchAt: number;
  chain: Promise<void>;
}

export interface StreamerDeps {
  replier: Replier;
  throttleMs: number;
  onResult?: (threadKey: string, usage?: UsageSnapshot, durationMs?: number) => void | Promise<void>;
}

export class LiveStreamer {
  private readonly turns = new Map<string, Turn>();

  constructor(private readonly deps: StreamerDeps) {}

  async onEvent(chatId: string, threadKey: string, ev: EngineEvent, cwd?: string): Promise<void> {
    const turn = this.ensureTurn(chatId, threadKey, ev, cwd);
    if (!turn) return;

    switch (ev.kind) {
      case 'init':
        break;
      case 'assistant-text':
        turn.state.assistantBuf += ev.text;
        this.schedulePatch(turn);
        break;
      case 'tool-use':
        if (ev.name === 'AskUserQuestion') {
          const questions = parseAskUserInput(ev.input);
          if (questions.length > 0) {
            await this.deps.replier.sendCard(turn.chatId, renderAskUserCard(turn.threadKey, questions));
          }
        }
        turn.state.currentTool = { name: ev.name, input: previewJson(ev.input) };
        this.schedulePatch(turn);
        break;
      case 'tool-result':
        turn.state.currentTool = undefined;
        turn.state.toolResults += 1;
        this.schedulePatch(turn);
        break;
      case 'result':
        turn.state.phase = ev.ok ? 'done' : 'error';
        if (!ev.ok) turn.state.error = ev.text || '执行失败';
        turn.state.usage = ev.usage;
        turn.state.durationMs = ev.durationMs;
        await this.flushNow(turn);
        this.turns.delete(threadKey);
        await this.deps.onResult?.(threadKey, ev.usage, ev.durationMs);
        break;
      case 'error':
        turn.state.phase = 'error';
        turn.state.error = ev.message;
        await this.flushNow(turn);
        this.turns.delete(threadKey);
        break;
    }
  }

  /** 外部主动通知"用户已中断" — 会把当前轮标记为 interrupted */
  async markInterrupted(threadKey: string): Promise<void> {
    const turn = this.turns.get(threadKey);
    if (!turn) return;
    turn.state.phase = 'interrupted';
    await this.flushNow(turn);
    this.turns.delete(threadKey);
  }

  private ensureTurn(chatId: string, threadKey: string, ev: EngineEvent, cwd?: string): Turn | undefined {
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

    turn = {
      chatId,
      threadKey,
      state: {
        threadKey,
        assistantBuf: '',
        toolResults: 0,
        phase: 'streaming',
        ...(cwd ? { cwd } : {}),
      },
      pendingPatch: false,
      lastPatchAt: 0,
      chain: Promise.resolve(),
    };
    this.turns.set(threadKey, turn);

    // 立即发卡片首帧（异步），拿到 messageId；后续 PATCH 等 id 就绪
    turn.chain = (async () => {
      const mid = await this.deps.replier.sendCard(chatId, renderLiveCard(turn!.state));
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

      const fullText = turn.state.assistantBuf;
      // 用精简卡片重试（去掉正文，仅保留状态信息）
      const minState: LiveCardState = { ...turn.state, assistantBuf: '（内容过长，已作为消息发送 ↓）' };
      await this.deps.replier.patchCard(turn.messageId, renderLiveCard(minState));
      // 全量内容分批发送为文本消息
      if (fullText.trim()) {
        await this.sendBatchedMarkdown(turn.chatId, fullText);
      }
    });
    await turn.chain;
  }

  /** 将长文本分段发送为飞书 Markdown 卡片 */
  private async sendBatchedMarkdown(chatId: string, text: string, chunkSize = 3500): Promise<void> {
    const chunks = splitByParagraph(text, chunkSize);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      const title = total === 1 ? '📄 完整内容' : `📄 内容 (${i + 1}/${total})`;
      await this.deps.replier.sendCard(chatId, card(cardHeader(title, 'grey'), [md(chunks[i]!)]));
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

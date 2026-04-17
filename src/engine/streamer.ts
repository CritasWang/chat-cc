import { log } from '../logger.js';
import { renderLiveCard, type LiveCardState } from '../feishu/cards/live.js';
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

  async onEvent(chatId: string, threadKey: string, ev: EngineEvent): Promise<void> {
    const turn = this.ensureTurn(chatId, threadKey, ev);
    if (!turn) return;

    switch (ev.kind) {
      case 'init':
        break;
      case 'assistant-text':
        turn.state.assistantBuf += ev.text;
        this.schedulePatch(turn);
        break;
      case 'tool-use':
        turn.state.currentTool = { name: ev.name, input: previewJson(ev.input) };
        this.schedulePatch(turn);
        break;
      case 'tool-result':
        turn.state.currentTool = undefined;
        turn.state.toolResults += 1;
        this.schedulePatch(turn);
        break;
      case 'result':
        turn.state.phase = 'done';
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

  private ensureTurn(chatId: string, threadKey: string, ev: EngineEvent): Turn | undefined {
    let turn = this.turns.get(threadKey);
    if (turn) return turn;

    // 只在"确实要显示"的事件发生时才创建卡片
    if (ev.kind !== 'assistant-text' && ev.kind !== 'tool-use') return undefined;

    turn = {
      chatId,
      threadKey,
      state: {
        threadKey,
        assistantBuf: '',
        toolResults: 0,
        phase: 'streaming',
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
      if (ok) turn.lastPatchAt = Date.now();
    });
    await turn.chain;
  }
}

function previewJson(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (s.length <= 400) return s;
  return s.slice(0, 400) + '…';
}

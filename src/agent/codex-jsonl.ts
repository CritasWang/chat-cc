import type { EngineEvent } from '../engine/events.js';
import { log } from '../logger.js';

/**
 * Codex JSONL → EngineEvent 翻译器（借鉴 lark-bridge agent/codex/jsonl.ts，
 * 目标事件类型换成 chat-cc 的 EngineEvent）。
 *
 * Codex `exec --json` 每行一个 JSON 事件，关键类型：
 *   thread.started / turn.started / item.started / item.completed /
 *   agent_message / turn.completed / turn.failed / error
 *
 * 翻译器维护状态机：Codex 输出可能乱序/缺字段，未知事件计数不抛错。
 */

export type CodexFinishReason = 'failed' | 'interrupted' | 'timeout';

export class CodexJsonlTranslator {
  threadId: string | undefined;
  private terminal = false;
  private lastNonTerminalError: string | undefined;
  private readonly startedItems = new Set<string>();
  private readonly turnStartedAt = Date.now();

  translate(raw: unknown): EngineEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw['type'] !== 'string') return [];

    switch (raw['type']) {
      case 'thread.started': {
        const threadId = str(raw['thread_id'] ?? raw['threadId']);
        if (!threadId) return [];
        this.threadId = threadId;
        return [{ kind: 'init', sessionId: threadId }];
      }
      case 'turn.started':
        return [];
      case 'item.started': {
        const item = rec(raw['item']);
        if (!item || item['type'] !== 'command_execution') return [];
        const id = str(item['id']);
        if (!id) return [];
        this.startedItems.add(id);
        return [
          { kind: 'tool-use', id, name: 'command_execution', input: { command: str(item['command']) ?? '' } },
        ];
      }
      case 'item.completed': {
        const item = rec(raw['item']);
        if (!item) return [];
        if (item['type'] === 'agent_message') {
          const message = str(item['text'] ?? item['message']);
          return message ? [{ kind: 'assistant-text', text: message }] : [];
        }
        if (item['type'] !== 'command_execution') return [];
        const id = str(item['id']);
        if (!id) return [];
        this.startedItems.delete(id);
        const exitCode = num(item['exit_code']);
        return [
          {
            kind: 'tool-result',
            toolUseId: id,
            content: str(item['output'] ?? item['aggregated_output'] ?? item['stdout']) ?? '',
            isError: exitCode !== undefined && exitCode !== 0,
          },
        ];
      }
      case 'agent_message': {
        const message = str(raw['message'] ?? raw['text']);
        return message ? [{ kind: 'assistant-text', text: message }] : [];
      }
      case 'turn.completed': {
        this.terminal = true;
        const usage = rec(raw['usage']);
        return [
          {
            kind: 'result',
            ok: true,
            text: '',
            durationMs: Date.now() - this.turnStartedAt,
            ...(usage
              ? {
                  usage: {
                    inputTokens: num(usage['input_tokens'] ?? usage['inputTokens']) ?? 0,
                    outputTokens: num(usage['output_tokens'] ?? usage['outputTokens']) ?? 0,
                    cacheReadTokens: num(usage['cached_input_tokens'] ?? usage['cachedInputTokens']) ?? 0,
                    cacheCreationTokens: 0,
                  },
                }
              : {}),
          },
        ];
      }
      case 'turn.failed': {
        this.terminal = true;
        return [
          {
            kind: 'result',
            ok: false,
            text: errMsg(raw, 'codex turn failed'),
            durationMs: Date.now() - this.turnStartedAt,
          },
        ];
      }
      case 'error': {
        // 非终态错误：记录，等 turn.failed 或流结束
        this.lastNonTerminalError = errMsg(raw, 'codex error');
        log().warn({ message: this.lastNonTerminalError }, 'codex 非终态错误事件');
        return [];
      }
      default:
        log().debug({ eventType: raw['type'] }, 'codex 未知事件类型');
        return [];
    }
  }

  /** 流结束但未见终态事件时补一个终态 */
  finish(reason: CodexFinishReason = 'failed'): EngineEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
      return [
        {
          kind: 'result',
          ok: false,
          text: `codex 输出流提前结束${detail}`,
          durationMs: Date.now() - this.turnStartedAt,
        },
      ];
    }
    // interrupted / timeout：交给上层 markInterrupted 之类处理，发 ok 但空
    return [
      {
        kind: 'result',
        ok: false,
        text: reason === 'interrupted' ? '已中断' : '超时',
        durationMs: Date.now() - this.turnStartedAt,
      },
    ];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function rec(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function errMsg(raw: Record<string, unknown>, fallback: string): string {
  const nested = rec(raw['error']);
  return str(raw['message']) ?? str(nested?.['message']) ?? str(raw['error']) ?? fallback;
}

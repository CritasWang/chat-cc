import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type EngineEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'result'; ok: boolean; text: string; usage?: UsageSnapshot; durationMs: number }
  | { kind: 'error'; message: string };

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
}

export function translateSdkMessage(msg: SDKMessage): EngineEvent[] {
  const out: EngineEvent[] = [];

  if (msg.type === 'system') {
    const sub = (msg as { subtype?: string }).subtype;
    if (sub === 'init') {
      const sid = (msg as { session_id?: string }).session_id;
      if (sid) out.push({ kind: 'init', sessionId: sid });
    }
    return out;
  }

  if (msg.type === 'assistant') {
    const blocks = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
    for (const b of blocks) {
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        out.push({ kind: 'assistant-text', text: b['text'] as string });
      } else if (b['type'] === 'tool_use') {
        out.push({
          kind: 'tool-use',
          id: (b['id'] as string) ?? '',
          name: (b['name'] as string) ?? '',
          input: b['input'],
        });
      }
    }
    return out;
  }

  if (msg.type === 'user') {
    const rawContent = msg.message?.content ?? [];
    if (Array.isArray(rawContent)) {
      const blocks = rawContent as unknown as Array<Record<string, unknown>>;
      for (const b of blocks) {
        if (b['type'] === 'tool_result') {
          const content = b['content'];
          out.push({
            kind: 'tool-result',
            toolUseId: (b['tool_use_id'] as string) ?? '',
            content: stringifyContent(content),
            isError: Boolean(b['is_error']),
          });
        }
      }
    }
    return out;
  }

  if (msg.type === 'result') {
    const m = msg as {
      subtype?: string;
      is_error?: boolean;
      result?: string;
      errors?: string[];
      duration_ms?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      modelUsage?: Record<string, unknown>;
    };
    const errorDetail = Array.isArray(m.errors) && m.errors.length > 0
      ? m.errors.join('\n')
      : '';
    const text = m.result || errorDetail || '';
    out.push({
      kind: 'result',
      ok: !m.is_error,
      text,
      durationMs: m.duration_ms ?? 0,
      usage: m.usage
        ? {
            inputTokens: m.usage.input_tokens ?? 0,
            outputTokens: m.usage.output_tokens ?? 0,
            cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
          }
        : undefined,
    });
  }

  return out;
}

function stringifyContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((b) => {
      const block = b as Record<string, unknown>;
      if (block['type'] === 'text' && typeof block['text'] === 'string') return block['text'];
      return JSON.stringify(block);
    })
    .join('\n');
}

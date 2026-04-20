import type { UsageSnapshot } from '../../engine/events.js';
import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, hr, md } from './base.js';

export interface LiveCardState {
  threadKey: string;
  assistantBuf: string;
  currentTool?: { name: string; input: string };
  toolResults: number;
  phase: 'streaming' | 'done' | 'error' | 'interrupted';
  error?: string;
  usage?: UsageSnapshot;
  durationMs?: number;
  interrupted?: boolean;
}

export function renderLiveCard(state: LiveCardState): InteractiveCard {
  const elems: unknown[] = [];

  if (state.assistantBuf) {
    elems.push(md(truncate(state.assistantBuf, 4500)));
  }

  if (state.currentTool) {
    elems.push(hr());
    elems.push(md(`🛠 **${state.currentTool.name}**\n\`\`\`\n${truncate(state.currentTool.input, 800)}\n\`\`\``));
  }

  if (state.toolResults > 0 && state.phase === 'streaming') {
    elems.push(md(`_已完成 ${state.toolResults} 次工具调用_`));
  }

  if (state.phase === 'error' && state.error) {
    elems.push(hr());
    elems.push(md(`⚠️ **错误**: ${truncate(state.error, 800)}`));
  }

  if (state.phase !== 'streaming' && state.usage) {
    elems.push(hr());
    elems.push(
      md(
        `tokens · in ${state.usage.inputTokens} · out ${state.usage.outputTokens} · cache-r ${state.usage.cacheReadTokens} · cache-c ${state.usage.cacheCreationTokens}${state.durationMs ? ` · ${(state.durationMs / 1000).toFixed(1)}s` : ''}`,
      ),
    );
  }

  if (state.phase === 'done') {
    elems.push(
      btnRow([
        cmdBtn('📋 查看会话', 'session', 'list'),
        cmdBtn('🛑 停止会话', 'session', `stop ${state.threadKey}`, 'danger'),
      ]),
    );
  } else if (state.phase === 'streaming') {
    elems.push(
      btnRow([
        cmdBtn('⏹ 中断', 'stop', state.threadKey, 'danger'),
        { label: ' ', style: 'default' as const, value: {} },
      ]),
    );
  }

  return card(cardHeader(titleFor(state), colorFor(state)), elems);
}

function titleFor(state: LiveCardState): string {
  switch (state.phase) {
    case 'done':
      return '✅ 完成';
    case 'error':
      return '⚠️ 出错';
    case 'interrupted':
      return '🛑 已中断';
    default:
      return '💬 Claude 思考中…';
  }
}

function colorFor(state: LiveCardState): 'blue' | 'green' | 'red' | 'orange' {
  switch (state.phase) {
    case 'done':
      return 'green';
    case 'error':
      return 'red';
    case 'interrupted':
      return 'orange';
    default:
      return 'blue';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n… （已截断）';
}

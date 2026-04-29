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
  /** stateless=true 时不显示会话相关按钮（用于 /ask 等无状态场景） */
  stateless?: boolean;
  /** 当前工作目录，用于在卡片中展示项目名称 */
  cwd?: string;
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
    const project = state.cwd ? projectName(state.cwd) : '';
    elems.push(hr());
    elems.push(
      md(
        `${project ? `**${project}** · ` : ''}tokens · in ${state.usage.inputTokens} · out ${state.usage.outputTokens} · cache-r ${state.usage.cacheReadTokens} · cache-c ${state.usage.cacheCreationTokens}${state.durationMs ? ` · ${(state.durationMs / 1000).toFixed(1)}s` : ''}`,
      ),
    );
  }

  if (state.phase === 'done') {
    if (state.stateless) {
      elems.push(
        btnRow([
          cmdBtn('📂 项目', 'project', ''),
          cmdBtn('📋 会话', 'session', 'list'),
          cmdBtn('🟢 当前', 'session', 'current'),
        ]),
      );
    } else {
      elems.push(
        btnRow([
          cmdBtn('📋 查看会话', 'session', 'list'),
          cmdBtn('🛑 停止会话', 'session', `stop ${state.threadKey}`, 'danger'),
        ]),
      );
    }
  } else if (state.phase === 'streaming') {
    elems.push(
      btnRow([
        cmdBtn('⏹ 中断', 'stop', state.threadKey, 'danger'),
      ]),
    );
  }

  return card(cardHeader(titleFor(state), colorFor(state)), elems);
}

function titleFor(state: LiveCardState): string {
  const project = state.cwd ? projectName(state.cwd) : '';
  const suffix = project ? ` · ${project}` : '';
  switch (state.phase) {
    case 'done':
      return `✅ 完成${suffix}`;
    case 'error':
      return `⚠️ 出错${suffix}`;
    case 'interrupted':
      return `🛑 已中断${suffix}`;
    default:
      return `💬 Claude 思考中…${suffix}`;
  }
}

function projectName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? '';
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
  let out = s.length <= max ? s : s.slice(0, max) + '\n\n… （已截断）';
  return limitTables(out);
}

/**
 * 飞书卡片有表格数量上限（ErrCode 11310: card table number over limit）。
 * 当 Markdown 中表格过多时，将多余的表格转为纯文本列表以避免 400 错误。
 */
function limitTables(s: string, max = 3): string {
  const sepRegex = /^\|[-:\s|]+\|$/gm;
  const matches = s.match(sepRegex);
  if (!matches || matches.length <= max) return s;

  let tableIdx = 0;
  let inTable = false;

  return s
    .split('\n')
    .map((line) => {
      const isTableLine = /^\s*\|/.test(line);
      const isSep = isTableLine && /^[\s|:-]+$/.test(line);

      if (isSep && !inTable) {
        inTable = true;
        tableIdx++;
      }
      if (!isTableLine) inTable = false;

      if (!isTableLine || tableIdx <= max) return line;
      if (isSep) return '';
      return line
        .replace(/^\|\s*/, '  ')
        .replace(/\s*\|$/, '')
        .replace(/\s*\|\s*/g, ' | ');
    })
    .filter((l) => l !== '')
    .join('\n');
}

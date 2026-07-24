import type { EngineEvent, UsageSnapshot } from '../../engine/events.js';
import type { InteractiveCard } from '../replier.js';
import { previewJson } from '../../utils.js';
import { btnRow, card, cardHeader, cmdBtn, hr, md } from './base.js';

/** 工具组折叠阈值：同组连续工具调用 ≥ 该值时折叠为摘要面板 */
const COLLAPSE_TOOL_THRESHOLD = 3;
/** 正文总预算（字符）— 超出后从头部裁剪，保留最新内容 */
const TEXT_BUDGET = 4500;
/** 单个工具输入/输出在面板 body 中的预算 */
const TOOL_BODY_MAX = 800;

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  /** 输入的 JSON 预览（已截断的字符串） */
  input: string;
  status: ToolStatus;
}

export type LiveBlock =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export interface LiveCardState {
  threadKey: string;
  /** 文本与工具调用按时间交错的块序列 */
  blocks: LiveBlock[];
  phase: 'streaming' | 'done' | 'error' | 'interrupted';
  error?: string;
  usage?: UsageSnapshot;
  durationMs?: number;
  /** stateless=true 时不显示会话相关按钮（用于 /ask 等无状态场景） */
  stateless?: boolean;
  /** 当前工作目录，用于在卡片中展示项目名称 */
  cwd?: string;
  /** 会话引擎（claude/codex），用于卡片标题显示 */
  engine?: string;
  /** 由「无活跃会话 → 自动降级到 /ask」触发，卡片顶部显示醒目提示 */
  fallbackFromNoSession?: boolean;
}

export function initialLiveState(
  threadKey: string,
  opts: Pick<LiveCardState, 'stateless' | 'cwd' | 'fallbackFromNoSession' | 'engine'> = {},
): LiveCardState {
  return {
    threadKey,
    blocks: [],
    phase: 'streaming',
    ...(opts.stateless ? { stateless: true } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(opts.fallbackFromNoSession ? { fallbackFromNoSession: true } : {}),
  };
}

/**
 * 把 EngineEvent 应用到卡片状态（就地变更，与调用方持有引用的用法一致）。
 * 终态事件（result/error）的 phase 切换仍由调用方处理 —— 各调用方
 * 对终态有不同的收尾逻辑（fallback 发文本、onResult 回调等）。
 */
export function applyEvent(state: LiveCardState, ev: EngineEvent): void {
  switch (ev.kind) {
    case 'assistant-text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        last.content += ev.text;
      } else {
        state.blocks.push({ kind: 'text', content: ev.text, streaming: true });
      }
      break;
    }
    case 'tool-use': {
      closeStreamingText(state);
      state.blocks.push({
        kind: 'tool',
        tool: { id: ev.id, name: ev.name, input: previewJson(ev.input), status: 'running' },
      });
      break;
    }
    case 'tool-result': {
      for (const b of state.blocks) {
        if (b.kind === 'tool' && b.tool.id === ev.toolUseId) {
          b.tool.status = ev.isError ? 'error' : 'done';
        }
      }
      break;
    }
    default:
      break;
  }
}

/** 结束所有流式文本块（终态或插入工具块前调用） */
export function closeStreamingText(state: LiveCardState): void {
  for (const b of state.blocks) {
    if (b.kind === 'text') b.streaming = false;
  }
}

/** 全部文本内容（fallback 分批发消息时使用） */
export function fullText(state: LiveCardState): string {
  return state.blocks
    .filter((b): b is Extract<LiveBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.content)
    .join('\n\n');
}

function doneToolCount(state: LiveCardState): number {
  return state.blocks.filter((b) => b.kind === 'tool' && b.tool.status !== 'running').length;
}

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

function* groupBlocks(blocks: LiveBlock[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

export function renderLiveCard(state: LiveCardState): InteractiveCard {
  const elems: unknown[] = [];
  const finalized = state.phase !== 'streaming';

  if (state.fallbackFromNoSession) {
    elems.push(
      md(
        '⚠️ **当前无活跃会话** — 本条按一次性提问（`/ask`）处理，**不保留上下文**。\n' +
          '如需多轮连续对话，请先发送 `/session start @项目别名` 或 `/session start <项目路径>` 开启会话。',
      ),
    );
    elems.push(hr());
  }

  // 文本预算：总量超限时从最早的文本组开始裁剪，保留最新输出
  const groups = [...groupBlocks(state.blocks)];
  const budgeted = budgetText(groups, TEXT_BUDGET);

  for (const group of budgeted) {
    if (group.kind === 'text') {
      if (group.content.trim()) elems.push(md(limitTables(group.content)));
    } else {
      elems.push(...renderToolGroup(group.tools, finalized));
    }
  }

  const running = state.blocks.filter((b) => b.kind === 'tool' && b.tool.status === 'running');
  const done = doneToolCount(state);
  if (state.phase === 'streaming' && done > 0 && running.length === 0) {
    elems.push(md(`_已完成 ${done} 次工具调用_`));
  }

  if (state.phase === 'error' && state.error) {
    elems.push(hr());
    elems.push(md(`⚠️ **错误**: ${truncate(state.error, 800)}`));
  }

  if (finalized && state.usage) {
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

/**
 * 工具组渲染（借鉴 lark-bridge 的折叠策略）：
 * - 少于阈值：逐个渲染为可折叠面板（默认收起，运行中的展开）
 * - 达到阈值且运行中：折叠历史工具为摘要，仅展开最新一个
 * - 达到阈值且已终态：全部折叠为摘要
 *
 * 折叠摘要**丢弃 body 只留标题行** —— 完整 input/output 面板嵌套后序列化
 * JSON 很容易超过飞书单元素 ~30KB 限制，导致 400 打断整个卡片流。
 */
function renderToolGroup(tools: ToolEntry[], finalized: boolean): unknown[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, t.status === 'running'));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1]!;
  const out: unknown[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  out.push(toolPanel(latest, latest.status === 'running'));
  return out;
}

function toolHeaderText(tool: ToolEntry): string {
  const icon = tool.status === 'running' ? '⏳' : tool.status === 'error' ? '❌' : '✅';
  return `${icon} **${tool.name}**`;
}

function toolPanel(tool: ToolEntry, expanded: boolean): unknown {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: tool.input ? codeFence(truncate(tool.input, TOOL_BODY_MAX)) : '_无输入_',
  });
}

function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): unknown {
  const suffix = finalized ? '（已结束）' : '';
  const title = `🧰 **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return collapsiblePanel({ title, expanded: false, border: 'blue', body: headerList });
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): unknown {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: {
      title: { tag: 'markdown', content: opts.title },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function codeFence(s: string): string {
  return '```\n' + s + '\n```';
}

/**
 * 文本预算：所有 text 组总字符数超过 budget 时，从最早的组开始裁剪
 * （头部替换为省略标记），保证卡片始终能容纳最新输出。
 */
function budgetText(groups: Group[], budget: number): Group[] {
  const total = groups.reduce((n, g) => n + (g.kind === 'text' ? g.content.length : 0), 0);
  if (total <= budget) return groups;

  let toCut = total - budget;
  const out: Group[] = [];
  for (const g of groups) {
    if (g.kind !== 'text' || toCut <= 0) {
      out.push(g);
      continue;
    }
    if (g.content.length <= toCut) {
      // 整组裁掉，留一行省略标记
      toCut -= g.content.length;
      out.push({ kind: 'text', content: '_…（较早内容已省略）_' });
    } else {
      out.push({ kind: 'text', content: '…' + g.content.slice(toCut) });
      toCut = 0;
    }
  }
  return out;
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
    default: {
      const engineName = state.engine === 'codex' ? 'Codex' : 'Claude';
      return `💬 ${engineName} 思考中…${suffix}`;
    }
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
  return s.length <= max ? s : s.slice(0, max) + '\n\n… （已截断）';
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

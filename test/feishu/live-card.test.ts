import { describe, it, expect } from 'vitest';
import {
  applyEvent,
  closeStreamingText,
  fullText,
  initialLiveState,
  renderLiveCard,
  type LiveCardState,
} from '../../src/feishu/cards/live.js';
import type { EngineEvent } from '../../src/engine/events.js';

function text(t: string): EngineEvent {
  return { kind: 'assistant-text', text: t };
}
function toolUse(id: string, name = 'Bash'): EngineEvent {
  return { kind: 'tool-use', id, name, input: { cmd: 'ls' } };
}
function toolResult(id: string, isError = false): EngineEvent {
  return { kind: 'tool-result', toolUseId: id, content: 'ok', isError };
}

/** 递归收集卡片 JSON 中某 tag 的元素 */
function collect(obj: unknown, tag: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(obj)) {
    for (const x of obj) collect(x, tag, out);
  } else if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (rec['tag'] === tag) out.push(rec);
    for (const v of Object.values(rec)) collect(v, tag, out);
  }
  return out;
}

describe('applyEvent 状态机', () => {
  it('连续文本合并到同一 streaming 块', () => {
    const s = initialLiveState('t');
    applyEvent(s, text('a'));
    applyEvent(s, text('b'));
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ kind: 'text', content: 'ab', streaming: true });
  });

  it('tool-use 关闭流式文本块并追加工具块', () => {
    const s = initialLiveState('t');
    applyEvent(s, text('a'));
    applyEvent(s, toolUse('t1'));
    applyEvent(s, text('b'));
    expect(s.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect(s.blocks[0]).toMatchObject({ streaming: false });
    expect(s.blocks[2]).toMatchObject({ content: 'b', streaming: true });
  });

  it('tool-result 按 id 匹配更新状态', () => {
    const s = initialLiveState('t');
    applyEvent(s, toolUse('t1'));
    applyEvent(s, toolUse('t2'));
    applyEvent(s, toolResult('t1'));
    applyEvent(s, toolResult('t2', true));
    const tools = s.blocks.filter((b) => b.kind === 'tool');
    expect(tools[0]).toMatchObject({ tool: { id: 't1', status: 'done' } });
    expect(tools[1]).toMatchObject({ tool: { id: 't2', status: 'error' } });
  });

  it('fullText 只拼接文本块', () => {
    const s = initialLiveState('t');
    applyEvent(s, text('a'));
    applyEvent(s, toolUse('t1'));
    applyEvent(s, text('b'));
    expect(fullText(s)).toBe('a\n\nb');
  });
});

describe('renderLiveCard 引擎标题', () => {
  it('默认/claude 显示 Claude 思考中', () => {
    const s = initialLiveState('t');
    applyEvent(s, text('hi'));
    expect(JSON.stringify(renderLiveCard(s))).toContain('Claude 思考中');
  });

  it('codex 会话显示 Codex 思考中', () => {
    const s = initialLiveState('t', { engine: 'codex' });
    applyEvent(s, text('hi'));
    const j = JSON.stringify(renderLiveCard(s));
    expect(j).toContain('Codex 思考中');
    expect(j).not.toContain('Claude 思考中');
  });
});

describe('renderLiveCard 折叠策略', () => {
  function stateWithTools(n: number, phase: LiveCardState['phase'] = 'streaming'): LiveCardState {
    const s = initialLiveState('t');
    for (let i = 0; i < n; i++) {
      applyEvent(s, toolUse(`t${i}`));
      applyEvent(s, toolResult(`t${i}`));
    }
    s.phase = phase;
    if (phase !== 'streaming') closeStreamingText(s);
    return s;
  }

  it('少于 3 个工具逐个渲染面板', () => {
    const cardJson = renderLiveCard(stateWithTools(2));
    const panels = collect(cardJson, 'collapsible_panel');
    expect(panels).toHaveLength(2);
  });

  it('运行中 ≥3 个工具: 折叠历史 + 展开最新', () => {
    const s = stateWithTools(4);
    // 最后一个工具还在 running
    applyEvent(s, toolUse('t9'));
    const cardJson = renderLiveCard(s);
    const panels = collect(cardJson, 'collapsible_panel');
    // 一个折叠摘要 + 一个最新工具面板
    expect(panels).toHaveLength(2);
    expect(panels[0]?.['expanded']).toBe(false);
    expect(panels[1]?.['expanded']).toBe(true);
  });

  it('终态 ≥3 个工具: 全部折叠为一个摘要', () => {
    const cardJson = renderLiveCard(stateWithTools(5, 'done'));
    const panels = collect(cardJson, 'collapsible_panel');
    expect(panels).toHaveLength(1);
    expect(panels[0]?.['expanded']).toBe(false);
  });

  it('文本+工具交错时保持时间顺序分组', () => {
    const s = initialLiveState('t');
    applyEvent(s, text('第一段'));
    applyEvent(s, toolUse('t1'));
    applyEvent(s, toolResult('t1'));
    applyEvent(s, text('第二段'));
    const cardJson = renderLiveCard(s);
    const mds = collect(cardJson, 'markdown').map((m) => m['content'] as string);
    const first = mds.findIndex((c) => c.includes('第一段'));
    const second = mds.findIndex((c) => c.includes('第二段'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it('超长文本部分裁剪：最早的组从头部截断，保留最新输出', () => {
    const s = initialLiveState('t');
    applyEvent(s, text('EARLY'.repeat(400))); // 2000 字符
    applyEvent(s, toolUse('t1'));
    applyEvent(s, text('LATE'.repeat(1000))); // 4000 字符 — 总量 6000 超 4500 预算
    const cardJson = renderLiveCard(s);
    const all = JSON.stringify(cardJson);
    // 后段完整保留
    expect(all).toContain('LATE'.repeat(100));
    // 前段被截断（… 前缀 + 剩余 500 字符），不再包含完整 2000 字符
    expect(all).not.toContain('EARLY'.repeat(400));
    expect(all).toContain('…EARLY');
  });

  it('超长文本整组裁剪：最早的组被替换为省略标记', () => {
    const s = initialLiveState('t');
    applyEvent(s, text('EARLY'.repeat(200))); // 1000 字符
    applyEvent(s, toolUse('t1'));
    applyEvent(s, text('LATE'.repeat(1500))); // 6000 字符 — toCut 2500 > 首组 1000，整组裁掉
    const cardJson = renderLiveCard(s);
    const all = JSON.stringify(cardJson);
    expect(all).toContain('已省略');
    expect(all).not.toContain('EARLY');
  });
});

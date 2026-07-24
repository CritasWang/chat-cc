import { describe, it, expect } from 'vitest';
import {
  initialAskState,
  renderAskUserCard,
  allAnswered,
  answeredCount,
  composeAnswer,
  type AskQuestion,
} from '../../src/feishu/cards/ask-user.js';

function q(question: string, labels: string[], multiSelect = false): AskQuestion {
  return { question, options: labels.map((label) => ({ label })), multiSelect };
}

function cardText(cardJson: unknown): string {
  return JSON.stringify(cardJson);
}

describe('AskCardState 状态流转', () => {
  it('初始状态：无选择、未提交', () => {
    const s = initialAskState('t', [q('用哪种方案?', ['A', 'B'])]);
    expect(answeredCount(s)).toBe(0);
    expect(allAnswered(s)).toBe(false);
    expect(s.submitted).toBe(false);
  });

  it('单选替换、多题 allAnswered 判定', () => {
    const s = initialAskState('t', [q('Q1', ['A', 'B']), q('Q2', ['X', 'Y'])]);
    s.selections[0] = [1];
    expect(answeredCount(s)).toBe(1);
    expect(allAnswered(s)).toBe(false);
    s.selections[1] = [0];
    expect(allAnswered(s)).toBe(true);
  });

  it('composeAnswer：单题只发选项，多题带题干编号', () => {
    const one = initialAskState('t', [q('方案?', ['A', 'B'])]);
    one.selections[0] = [1];
    expect(composeAnswer(one)).toBe('B');

    const two = initialAskState('t', [q('方案?', ['A', 'B']), q('时间?', ['今天', '明天'], true)]);
    two.selections[0] = [0];
    two.selections[1] = [0, 1];
    expect(composeAnswer(two)).toBe('方案?：A\n时间?：今天、明天');
  });
});

describe('renderAskUserCard 渲染', () => {
  it('未答时展示选项按钮与提交按钮', () => {
    const s = initialAskState('t', [q('方案?', ['A', 'B'])]);
    const text = cardText(renderAskUserCard(s));
    expect(text).toContain('__ask');
    expect(text).toContain('0:1');
    expect(text).toContain('提交回答');
    expect(text).toContain('"args":"submit"');
  });

  it('已选项带 ✅ 与高亮样式', () => {
    const s = initialAskState('t', [q('方案?', ['A', 'B'])]);
    s.selections[0] = [0];
    const text = cardText(renderAskUserCard(s));
    expect(text).toContain('✅ A');
    expect(text).toContain('primary_filled');
  });

  it('多题提交按钮带进度', () => {
    const s = initialAskState('t', [q('Q1', ['A']), q('Q2', ['X'])]);
    s.selections[0] = [0];
    const text = cardText(renderAskUserCard(s));
    expect(text).toContain('已答 1/2');
  });

  it('部分作答提交时只发送已答的题', () => {
    const s = initialAskState('t', [q('Q1', ['A']), q('Q2', ['X'])]);
    s.selections[0] = [0];
    expect(composeAnswer(s)).toBe('Q1：A');
  });

  it('多选题提示点选可切换', () => {
    const s = initialAskState('t', [q('Q1', ['A', 'B'], true)]);
    const text = cardText(renderAskUserCard(s));
    expect(text).toContain('点选可切换');
  });

  it('提交后终态：绿头、无按钮、显示所选', () => {
    const s = initialAskState('t', [q('方案?', ['A', 'B'])]);
    s.selections[0] = [1];
    s.submitted = true;
    const text = cardText(renderAskUserCard(s));
    expect(text).toContain('已回答 Claude 的提问');
    expect(text).toContain('已提交给 Claude');
    expect(text).toContain('→ B');
    expect(text).not.toContain('__ask');
  });
});

import { describe, expect, it } from 'vitest';
import { extractAgentFlag, extractModelFlag, extractProfileFlag } from '../../src/commands/session.js';

describe('extractModelFlag', () => {
  it('无 flag 时原样返回', () => {
    expect(extractModelFlag('@proj')).toEqual({ rest: '@proj' });
  });

  it('支持空格与等号两种写法', () => {
    expect(extractModelFlag('@proj --model grok-4.5')).toEqual({
      rest: '@proj',
      model: 'grok-4.5',
    });
    expect(extractModelFlag('--model=gpt-5.6-sol @proj')).toEqual({
      rest: '@proj',
      model: 'gpt-5.6-sol',
    });
  });

  it('保留模型名里的方括号后缀（1M 上下文标记）', () => {
    expect(extractModelFlag('--model deepseek-v4-flash-cc[1m]')).toEqual({
      rest: '',
      model: 'deepseek-v4-flash-cc[1m]',
    });
  });

  it('容纳第三方模型 id 里的 : @ / 分隔符', () => {
    expect(extractModelFlag('--model vendor/model:v2@latest').model).toBe(
      'vendor/model:v2@latest',
    );
  });

  it('不误伤 --modelx 之类的前缀', () => {
    expect(extractModelFlag('--modelx foo')).toEqual({ rest: '--modelx foo' });
  });

  it('与 --codex / --profile 混用时互不干扰', () => {
    const raw = '@proj --claude --profile timecho --model grok-4.5 --name=x';
    const { rest: noAgent, agent } = extractAgentFlag(raw);
    const { rest: noProfile, profile } = extractProfileFlag(noAgent);
    const { rest, model } = extractModelFlag(noProfile);
    expect(agent).toBe('claude');
    expect(profile).toBe('timecho');
    expect(model).toBe('grok-4.5');
    // 每个提取器把自己的 flag 换成一个空格，链式使用会留下多余空白；
    // 下游 parseStartArgs 用 trim + 正则取值，不受影响。
    expect(rest.replace(/\s+/g, ' ')).toBe('@proj --name=x');
  });
});

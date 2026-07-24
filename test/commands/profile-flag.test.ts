import { describe, it, expect } from 'vitest';
import { extractProfileFlag } from '../../src/commands/session.js';

describe('extractProfileFlag --profile 标记解析', () => {
  it('无标记原样返回', () => {
    expect(extractProfileFlag('@myapp')).toEqual({ rest: '@myapp' });
    expect(extractProfileFlag('')).toEqual({ rest: '' });
  });

  it('--profile <name> 空格形式', () => {
    expect(extractProfileFlag('@myapp --profile bytecat')).toEqual({
      rest: '@myapp',
      profile: 'bytecat',
    });
  });

  it('--profile=<name> 等号形式', () => {
    expect(extractProfileFlag('--profile=timecho /path')).toEqual({
      rest: '/path',
      profile: 'timecho',
    });
  });

  it('与 --codex 混用互不干扰（外部先摘 agent 再摘 profile）', () => {
    const { rest } = extractProfileFlag('chat 任务 --profile 4router');
    expect(rest).toBe('chat 任务');
  });

  it('name 含点/横线/下划线', () => {
    expect(extractProfileFlag('--profile a-b.c_d')).toEqual({ rest: '', profile: 'a-b.c_d' });
  });

  it('不误伤 --profilex', () => {
    expect(extractProfileFlag('run --profilex foo')).toEqual({ rest: 'run --profilex foo' });
  });
});

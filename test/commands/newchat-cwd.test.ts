import { describe, expect, it } from 'vitest';
import { extractCwdTarget } from '../../src/commands/newchat.js';

describe('extractCwdTarget', () => {
  it('提取 @别名', () => {
    expect(extractCwdTarget('@chatcc-v3')).toEqual({ rest: '', target: '@chatcc-v3' });
  });

  it('提取绝对路径', () => {
    expect(extractCwdTarget('/Volumes/data/sources/tech-stack')).toEqual({
      rest: '',
      target: '/Volumes/data/sources/tech-stack',
    });
  });

  it('提取 ~/ 路径', () => {
    expect(extractCwdTarget('~/work/foo')).toEqual({ rest: '', target: '~/work/foo' });
  });

  it('群名 + 别名共存，群名保留', () => {
    expect(extractCwdTarget('我的任务 @alias')).toEqual({ rest: '我的任务', target: '@alias' });
    expect(extractCwdTarget('@alias 我的任务')).toEqual({ rest: '我的任务', target: '@alias' });
  });

  it('群名 + 路径共存，群名保留', () => {
    expect(extractCwdTarget('紧急修复 /tmp/proj')).toEqual({ rest: '紧急修复', target: '/tmp/proj' });
  });

  it('纯群名不误判', () => {
    expect(extractCwdTarget('日常讨论群')).toEqual({ rest: '日常讨论群' });
    expect(extractCwdTarget('')).toEqual({ rest: '' });
  });

  it('词中间的 @ 或 / 不误判', () => {
    expect(extractCwdTarget('a@b')).toEqual({ rest: 'a@b' });
    expect(extractCwdTarget('7/17 复盘')).toEqual({ rest: '7/17 复盘' });
  });
});

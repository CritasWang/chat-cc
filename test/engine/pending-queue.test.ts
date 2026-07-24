import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PendingQueue } from '../../src/engine/pending-queue.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PendingQueue', () => {
  it('静默窗口内多条消息合并为一批 flush', () => {
    const flushed: Array<{ scope: string; messages: string[] }> = [];
    const q = new PendingQueue(600, (scope, messages) => flushed.push({ scope, messages }));

    q.push('a', 'msg1');
    vi.advanceTimersByTime(300);
    q.push('a', 'msg2'); // 重置计时器
    vi.advanceTimersByTime(599);
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([{ scope: 'a', messages: ['msg1', 'msg2'] }]);
  });

  it('不同 scope 独立计时互不合并', () => {
    const flushed: string[][] = [];
    const q = new PendingQueue(100, (_s, m) => flushed.push(m));
    q.push('a', '1');
    q.push('b', '2');
    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([['1'], ['2']]);
  });

  it('block 期间消息累积不 flush，unblock 后重新计时合并带出', () => {
    const flushed: string[][] = [];
    const q = new PendingQueue(100, (_s, m) => flushed.push(m));

    q.push('a', 'first');
    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([['first']]);

    q.block('a'); // 模拟 run 开始
    q.push('a', 'during-run-1');
    q.push('a', 'during-run-2');
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1); // run 期间不 flush

    q.unblock('a'); // run 结束
    vi.advanceTimersByTime(100);
    expect(flushed[1]).toEqual(['during-run-1', 'during-run-2']);
  });

  it('block 无积压时 unblock 不触发空 flush', () => {
    const flushed: string[][] = [];
    const q = new PendingQueue(100, (_s, m) => flushed.push(m));
    q.block('a');
    q.unblock('a');
    vi.advanceTimersByTime(500);
    expect(flushed).toHaveLength(0);
  });

  it('maxBlockMs 超时后强制解锁', () => {
    const flushed: string[][] = [];
    const q = new PendingQueue(100, (_s, m) => flushed.push(m), 5_000);
    q.block('a');
    q.push('a', 'stuck');
    vi.advanceTimersByTime(5_000); // 触发 guard 强制 unblock
    expect(q.isBlocked('a')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([['stuck']]);
  });

  it('flush 回调抛异常不影响后续', () => {
    let calls = 0;
    const q = new PendingQueue(100, () => {
      calls++;
      throw new Error('boom');
    });
    q.push('a', '1');
    vi.advanceTimersByTime(100);
    q.push('a', '2');
    vi.advanceTimersByTime(100);
    expect(calls).toBe(2);
  });
});

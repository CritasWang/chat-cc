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
    const flushed: Array<{ scope: string; messages: string[]; requesterIds: string[] }> = [];
    const q = new PendingQueue(600, (scope, messages, requesterIds) =>
      flushed.push({ scope, messages, requesterIds }),
    );

    q.push('a', 'msg1', 'u1');
    vi.advanceTimersByTime(300);
    q.push('a', 'msg2', 'u2'); // 重置计时器
    q.push('a', 'msg3', 'u1'); // requester 按首次出现去重
    vi.advanceTimersByTime(599);
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([
      { scope: 'a', messages: ['msg1', 'msg2', 'msg3'], requesterIds: ['u1', 'u2'] },
    ]);
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

  it('持续失败达到上限后停止自动重试并通知丢弃', () => {
    const discarded = vi.fn();
    let calls = 0;
    const q = new PendingQueue(100, () => {
      calls++;
      throw new Error('persistent failure');
    }, 5_000, {
      maxFlushRetries: 1,
      retryBaseMs: 100,
      onDiscard: discarded,
    });

    q.push('a', 'important', 'u1');
    vi.advanceTimersByTime(100); // 首次失败，允许重试一次
    expect(q.pendingCount('a')).toBe(1);
    vi.advanceTimersByTime(100); // 重试仍失败，停止

    expect(calls).toBe(2);
    expect(q.pendingCount('a')).toBe(0);
    expect(discarded).toHaveBeenCalledWith(
      'a',
      ['important'],
      ['u1'],
      expect.any(Error),
    );
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(2);
  });

  it('clear 后异步失败的旧 flush 不会把已清空消息复活', async () => {
    let rejectFlush!: (err: Error) => void;
    const q = new PendingQueue(100, () => new Promise<void>((_resolve, reject) => {
      rejectFlush = reject;
    }));
    q.push('a', 'old', 'u1');
    await vi.advanceTimersByTimeAsync(100);
    q.clear('a');
    rejectFlush(new Error('late failure'));
    await Promise.resolve();
    expect(q.pendingCount('a')).toBe(0);
  });

  it('按消息数与字符数拒绝无界积压', () => {
    const byCount = new PendingQueue(100, () => {}, 5_000, { maxMessages: 2 });
    byCount.block('a');
    byCount.push('a', 'one');
    byCount.push('a', 'two');
    expect(() => byCount.push('a', 'three')).toThrow(/message limit/);

    const byChars = new PendingQueue(100, () => {}, 5_000, { maxChars: 5 });
    byChars.block('b');
    byChars.push('b', '123');
    expect(() => byChars.push('b', '456')).toThrow(/character limit/);
  });
});

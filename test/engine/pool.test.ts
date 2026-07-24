import { describe, expect, it, vi } from 'vitest';
import { SessionPool, SessionPoolCapacityError, threadKey } from '../../src/engine/pool.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

describe('SessionPool stop 状态机', () => {
  it('并发 context-reset 会升级正在进行的 restart', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const onStop = vi.fn();
    const pool = new SessionPool({
      createSession: ({ threadKey: key, cwd }) => ({
        threadKey: key,
        cwd,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        start() {},
        send() {},
        async interrupt() {},
        close: () => closeGate,
      }),
      onEvent: () => {},
      onStop,
    });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'default' };
    const key = threadKey(input);
    pool.start(input, '/tmp');

    const restarting = pool.stop(key, { keepMeta: true, reason: 'restart' });
    const resetting = pool.stop(key, { keepMeta: true, reason: 'context-reset' });
    releaseClose();
    await Promise.all([restarting, resetting]);

    expect(onStop).toHaveBeenCalledWith(key, true, 'context-reset');
  });

  it('restart 与 destroy 并发时 destroy 胜出且不会复活会话', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let created = 0;
    const pool = new SessionPool({
      createSession: ({ threadKey: key, cwd }) => {
        created++;
        return {
          threadKey: key,
          cwd,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          start() {},
          send() {},
          async interrupt() {},
          close: () => closeGate,
        };
      },
      onEvent: () => {},
    });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'default' };
    const key = threadKey(input);
    pool.start(input, '/tmp');

    const restarting = pool.restart(input, '/tmp');
    const destroying = pool.stop(key, { keepMeta: false, reason: 'destroy' });
    releaseClose();

    await destroying;
    await expect(restarting).rejects.toThrow(/superseded/);
    expect(pool.get(key)).toBeUndefined();
    expect(pool.getMeta(key)).toBeUndefined();
    expect(created).toBe(1);
  });

  it('session.start 同步失败时回滚新建 meta', async () => {
    const close = vi.fn(async () => {});
    const pool = new SessionPool({
      createSession: ({ threadKey: key, cwd }) => ({
        threadKey: key,
        cwd,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        start() { throw new Error('start failed'); },
        send() {},
        async interrupt() {},
        close,
      }),
      onEvent: () => {},
    });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'broken' };
    const key = threadKey(input);

    expect(() => pool.start(input, '/tmp')).toThrow(/start failed/);
    await Promise.resolve();
    expect(pool.get(key)).toBeUndefined();
    expect(pool.getMeta(key)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it('createSession 同步失败时不遗留 meta 或 generation', () => {
    const pool = new SessionPool({
      createSession: () => { throw new Error('factory failed'); },
      onEvent: () => {},
    });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'factory' };
    const key = threadKey(input);

    expect(() => pool.start(input, '/tmp')).toThrow(/factory failed/);
    expect(pool.get(key)).toBeUndefined();
    expect(pool.getMeta(key)).toBeUndefined();
    expect(pool.generationOf(key)).toBe(0);
  });

  it('达到上限后拒绝新会话，但允许获取已运行会话', async () => {
    const pool = new SessionPool({
      maxActiveSessions: 1,
      createSession: ({ threadKey: key, cwd }) => ({
        threadKey: key,
        cwd,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        start() {},
        send() {},
        async interrupt() {},
        async close() {},
      }),
      onEvent: () => {},
    });
    const first = { chatId: 'oc_x', senderId: 'ou_x', slot: 'first' };
    const second = { chatId: 'oc_x', senderId: 'ou_x', slot: 'second' };
    const running = pool.start(first, '/tmp');

    expect(pool.hasStartCapacity()).toBe(false);
    expect(pool.start(first, '/tmp')).toBe(running);
    expect(() => pool.start(second, '/tmp')).toThrowError(SessionPoolCapacityError);

    await pool.stop(threadKey(first), { keepMeta: true, reason: 'idle' });
    expect(pool.hasStartCapacity()).toBe(true);
    expect(pool.start(second, '/tmp')).toBeDefined();
  });

  it('同一会话的在线 danger 切换串行执行', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: boolean[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const pool = new SessionPool({
      createSession: ({ threadKey: key, cwd }) => ({
        threadKey: key,
        cwd,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        start() {},
        send() {},
        async interrupt() {},
        async close() {},
        async setDanger(value) {
          calls.push(value);
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          if (value) await firstGate;
          concurrent -= 1;
          return true;
        },
      }),
      onEvent: () => {},
    });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'danger' };
    const key = threadKey(input);
    pool.start(input, '/tmp');

    const enable = pool.setSessionDanger(key, true, true);
    const disable = pool.setSessionDanger(key, false, false);
    await vi.waitFor(() => expect(calls).toEqual([true]));
    releaseFirst();

    await expect(enable).resolves.toBe('inplace');
    await expect(disable).resolves.toBe('inplace');
    expect(calls).toEqual([true, false]);
    expect(maxConcurrent).toBe(1);
    expect(pool.getMeta(key)?.danger).toBe(false);
  });

  it('idle sweep 不回收正在运行的长任务', async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const close = vi.fn(async () => {});
      const pool = new SessionPool({
        idleTimeoutMs: 1_000,
        idleCheckIntervalMs: 500,
        isBusy: () => busy,
        createSession: ({ threadKey: key, cwd }) => ({
          threadKey: key,
          cwd,
          createdAt: new Date(0),
          lastUsedAt: new Date(0),
          start() {},
          send() {},
          async interrupt() {},
          close,
        }),
        onEvent: () => {},
      });
      pool.start({ chatId: 'oc_x', senderId: 'ou_x', slot: 'busy' }, '/tmp');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(close).not.toHaveBeenCalled();

      busy = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(close).toHaveBeenCalledOnce();
      await pool.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

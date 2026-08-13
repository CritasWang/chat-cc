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

  it('调用 session.close 前已经发布 closing 状态，禁止同步重入取得半死会话', async () => {
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'reentrant-close' };
    const key = threadKey(input);
    let pool!: SessionPool;
    pool = new SessionPool({
      createSession: ({ threadKey: sessionKey, cwd }) => ({
        threadKey: sessionKey,
        cwd,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        start() {},
        send() {},
        async interrupt() {},
        async close() {
          expect(pool.isClosing(key)).toBe(true);
          expect(pool.get(key)).toBeUndefined();
          expect(() => pool.start(input, cwd)).toThrow(/closing/);
        },
      }),
      onEvent: () => {},
    });
    pool.start(input, '/tmp');

    await expect(pool.stop(key, { keepMeta: true, reason: 'restart' })).resolves.toBe(true);
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

  it('danger 更新等待正在关闭的旧实例，并应用到 restart 后的新实例', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const firstSetDanger = vi.fn(async () => true);
    const secondSetDanger = vi.fn(async () => true);
    let created = 0;
    const pool = new SessionPool({
      createSession: ({ threadKey: key, cwd }) => {
        created += 1;
        const first = created === 1;
        return {
          threadKey: key,
          cwd,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          start() {},
          send() {},
          async interrupt() {},
          close: () => first ? closeGate : Promise.resolve(),
          setDanger: first ? firstSetDanger : secondSetDanger,
        };
      },
      onEvent: () => {},
    });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'danger-restart' };
    const key = threadKey(input);
    pool.start(input, '/tmp');

    const restarting = pool.restart(input, '/tmp');
    await vi.waitFor(() => expect(pool.isClosing(key)).toBe(true));
    const updating = pool.setSessionDanger(key, true, true);
    expect(firstSetDanger).not.toHaveBeenCalled();
    releaseClose();

    await expect(restarting).resolves.toBeDefined();
    await expect(updating).resolves.toBe('inplace');
    expect(created).toBe(2);
    expect(firstSetDanger).not.toHaveBeenCalled();
    expect(secondSetDanger).toHaveBeenCalledWith(true);
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

describe('SessionPool 会话级模型', () => {
  /** 造一个可观测 setModel 的会话工厂 */
  function makePool(opts: { setModel?: (m: string) => Promise<boolean> } = {}) {
    const created: string[] = [];
    const setModelCalls: string[] = [];
    const pool = new SessionPool({
      createSession: ({ threadKey: key, cwd, model }) => {
        created.push(model ?? '(none)');
        return {
          threadKey: key,
          cwd,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          start() {},
          send() {},
          async interrupt() {},
          async close() {},
          async setModel(m: string) {
            setModelCalls.push(m);
            return opts.setModel ? opts.setModel(m) : true;
          },
        };
      },
      onEvent: () => {},
    });
    return { pool, created, setModelCalls };
  }

  it('切到具体模型时在线生效，不重启会话', async () => {
    const { pool, created, setModelCalls } = makePool();
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'model-inplace' };
    const key = threadKey(input);
    pool.start(input, '/tmp');

    await expect(pool.setSessionModel(key, 'grok-4.5', 'grok-4.5')).resolves.toBe('inplace');
    expect(setModelCalls).toEqual(['grok-4.5']);
    expect(created).toHaveLength(1); // 没有重启
    expect(pool.getMeta(key)?.model).toBe('grok-4.5');
  });

  it('回归"不指定模型"时必须重启（在线 setModel 无法删掉 env 变量）', async () => {
    const { pool, created, setModelCalls } = makePool();
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'model-clear' };
    const key = threadKey(input);
    pool.start(input, '/tmp', { model: 'grok-4.5' });

    await expect(pool.setSessionModel(key, undefined, undefined)).resolves.toBe('restarted');
    expect(setModelCalls).toEqual([]); // 绝不能调 setModel(undefined)
    expect(created).toEqual(['grok-4.5', '(none)']);
    expect(pool.getMeta(key)?.model).toBeUndefined();
  });

  it('在线切换失败时回退重启', async () => {
    const { pool, created } = makePool({ setModel: async () => false });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'model-fallback' };
    const key = threadKey(input);
    pool.start(input, '/tmp');

    await expect(pool.setSessionModel(key, 'gpt-5.6-sol', 'gpt-5.6-sol')).resolves.toBe('restarted');
    expect(created).toEqual(['(none)', 'gpt-5.6-sol']);
  });

  it('会话未运行时只更新元数据，下次懒启动生效', async () => {
    const { pool, created } = makePool();
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'model-meta' };
    const key = threadKey(input);
    pool.start(input, '/tmp');
    await pool.stop(key, { keepMeta: true, reason: 'idle' });

    await expect(pool.setSessionModel(key, 'grok-4.5', 'grok-4.5')).resolves.toBe('meta');
    expect(pool.getMeta(key)?.model).toBe('grok-4.5');

    pool.start(input, '/tmp'); // 懒启动：从 meta 继承模型
    expect(created).toEqual(['(none)', 'grok-4.5']);
  });

  it('model 与 danger 并发切换共用串行队列，两者都成功', async () => {
    // 曾经的隐患：两条独立队列各自 beginLifecycle，会互相顶掉 token，
    // 让先发起的一方误报 'missing'。
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
        async setDanger() {
          await new Promise((r) => setTimeout(r, 5));
          return true;
        },
        async setModel() {
          await new Promise((r) => setTimeout(r, 5));
          return true;
        },
      }),
      onEvent: () => {},
    });
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'model-danger' };
    const key = threadKey(input);
    pool.start(input, '/tmp');

    const [danger, model] = await Promise.all([
      pool.setSessionDanger(key, true, true),
      pool.setSessionModel(key, 'grok-4.5', 'grok-4.5'),
    ]);
    expect(danger).toBe('inplace');
    expect(model).toBe('inplace');
    expect(pool.getMeta(key)?.danger).toBe(true);
    expect(pool.getMeta(key)?.model).toBe('grok-4.5');
  });

  it('重启时继承 meta 里的模型，显式 opts 可覆盖', async () => {
    const { pool, created } = makePool();
    const input = { chatId: 'oc_x', senderId: 'ou_x', slot: 'model-inherit' };
    pool.start(input, '/tmp', { model: 'grok-4.5' });

    await pool.restart(input, '/tmp'); // 不传 opts → 继承
    expect(created).toEqual(['grok-4.5', 'grok-4.5']);

    await pool.restart(input, '/tmp', { model: 'gpt-5.6-sol' }); // 显式覆盖
    expect(created).toEqual(['grok-4.5', 'grok-4.5', 'gpt-5.6-sol']);
  });
});

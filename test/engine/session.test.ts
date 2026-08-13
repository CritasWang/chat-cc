import { describe, it, expect, vi, beforeEach } from 'vitest';

// 共享 mock 状态（vi.hoisted 保证在 vi.mock factory 提升后仍可安全引用）
const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown>; prompt: AsyncIterable<unknown> }>,
  responders: [] as Array<(prompt: AsyncIterable<any>) => AsyncGenerator<any>>,
  setModelCalls: [] as string[],
  setModelThrows: false,
}));

// mock SDK query：每次调用从 responders 队列取一个 generator，并补上 Session 会用到的 close/interrupt
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    hoisted.calls.push({ options, prompt });
    const responder = hoisted.responders.shift();
    if (!responder) throw new Error('测试未排入 responder');
    const gen = responder(prompt) as AsyncGenerator<any> & { close: () => void; interrupt: () => Promise<void> };
    gen.close = () => {};
    gen.interrupt = async () => {};
    (gen as unknown as { setModel: (m?: string) => Promise<void> }).setModel = async (m) => {
      hoisted.setModelCalls.push(m ?? '(undefined)');
      if (hoisted.setModelThrows) throw new Error('setModel 失败');
    };
    return gen;
  },
}));

import { Session } from '../../src/engine/session.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

function staleResult() {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['No conversation found with session ID: stale-uuid'],
    duration_ms: 0,
    num_turns: 0,
  };
}

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.responders.length = 0;
  hoisted.setModelCalls.length = 0;
  hoisted.setModelThrows = false;
});

describe('Session resume 失效自愈', () => {
  it('close 后 send 明确抛错而不是静默吞消息', async () => {
    const sess = new Session({ threadKey: 'c:u:closed', cwd: '/tmp' });
    await sess.close();
    expect(() => sess.send('lost')).toThrow(/closed/);
  });

  it('close 会丢弃尚未交给 SDK 的本地缓冲', async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const consumed: string[] = [];
    hoisted.responders.push(async function* (prompt) {
      await readGate;
      const message = await prompt[Symbol.asyncIterator]().next();
      if (!message.done) consumed.push((message.value as any)?.message?.content);
    });
    const sess = new Session({ threadKey: 'c:u:close-buffer', cwd: '/tmp' });
    sess.send('must not execute');

    const closing = sess.close();
    releaseRead();
    await closing;
    expect(consumed).toEqual([]);
  });

  it('stale-resume 时降级为无 resume 新会话并重放消息', async () => {
    const events: any[] = [];
    const notices: any[] = [];
    const replayed: Array<string | undefined> = [];

    // 第一次（带 resume）：直接 yield 一个 stale result
    hoisted.responders.push(async function* (prompt) {
      await prompt[Symbol.asyncIterator]().next();
      yield staleResult();
    });
    // 第二次（无 resume）：先从 prompt 读出被重放的消息，再 yield 正常结果
    hoisted.responders.push(async function* (prompt) {
      const it = prompt[Symbol.asyncIterator]();
      const first = await it.next();
      replayed.push((first.value as any)?.message?.content);
      yield { type: 'system', subtype: 'init', session_id: 'fresh-id' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
      yield {
        type: 'result',
        is_error: false,
        result: 'hi',
        duration_ms: 1,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    const sess = new Session({
      threadKey: 'c:u:default',
      cwd: '/tmp',
      resumeId: 'stale-uuid',
      onEvent: (e) => { events.push(e); },
      onNotice: (n) => { notices.push(n); },
    });

    sess.send('hello');

    await vi.waitFor(
      () => {
        expect(notices.length).toBe(1);
        expect(events.some((e) => e.kind === 'result' && e.ok === true)).toBe(true);
      },
      { timeout: 2000 },
    );

    // 两次 query：第一次带 resume，第二次自愈后不带
    expect(hoisted.calls.length).toBe(2);
    expect(hoisted.calls[0]!.options.resume).toBe('stale-uuid');
    expect(hoisted.calls[1]!.options.resume).toBeUndefined();
    // 原消息被自动重放到新会话
    expect(replayed[0]).toBe('hello');
    // notice 带上了失效的 sessionId
    expect(notices[0].staleSessionId).toBe('stale-uuid');
    // stale 错误 result 未透传给上层（用户不会看到错误卡）
    expect(events.some((e) => e.kind === 'result' && e.ok === false)).toBe(false);
    // 新 sessionId 已生效
    expect(sess.sessionId).toBe('fresh-id');

    await sess.close();
  });

  it('普通会话（无 resumeId）正常确认消息且不制造重复 error', async () => {
    const events: any[] = [];
    hoisted.responders.push(async function* (prompt) {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: 'system', subtype: 'init', session_id: 'sid' };
      yield { type: 'result', is_error: false, result: 'ok', duration_ms: 1, num_turns: 1 };
    });
    const sess = new Session({
      threadKey: 'c:u:default',
      cwd: '/tmp',
      onEvent: (e) => { events.push(e); },
    });
    sess.send('hi');
    await vi.waitFor(
      () => {
        expect(events.some((e) => e.kind === 'result' && e.ok)).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(hoisted.calls.length).toBe(1);
    expect(hoisted.calls[0]!.options.resume).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    await sess.close();
  });

  it('query 确认终态后结束时，下一条消息才重建 pump 且不误报 crash', async () => {
    const events: any[] = [];
    const consumed: string[] = [];
    for (const result of ['first', 'second']) {
      hoisted.responders.push(async function* (prompt) {
        const message = await prompt[Symbol.asyncIterator]().next();
        consumed.push((message.value as any)?.message?.content);
        yield { type: 'result', is_error: false, result, duration_ms: 1, num_turns: 1 };
      });
    }
    const sess = new Session({
      threadKey: 'c:u:graceful-end',
      cwd: '/tmp',
      onEvent: (event) => { events.push(event); },
    });

    sess.send('first');
    await vi.waitFor(() => expect(events.filter((event) => event.kind === 'result')).toHaveLength(1));
    await Promise.resolve();
    sess.send('second');
    await vi.waitFor(() => expect(events.filter((event) => event.kind === 'result')).toHaveLength(2));

    expect(consumed).toEqual(['first', 'second']);
    expect(events.some((event) => event.kind === 'error')).toBe(false);
    expect(hoisted.calls).toHaveLength(2);
    await sess.close();
  });

  it('自愈通知回调抛错不会打断新 query 与消息重放', async () => {
    const events: any[] = [];
    hoisted.responders.push(async function* (prompt) {
      await prompt[Symbol.asyncIterator]().next();
      yield staleResult();
    });
    hoisted.responders.push(async function* (prompt) {
      const first = await prompt[Symbol.asyncIterator]().next();
      expect((first.value as any)?.message?.content).toBe('hello');
      yield { type: 'system', subtype: 'init', session_id: 'fresh-after-notice-error' };
      yield { type: 'result', is_error: false, result: 'ok', duration_ms: 1, num_turns: 1 };
    });

    const sess = new Session({
      threadKey: 'c:u:default',
      cwd: '/tmp',
      resumeId: 'stale-uuid',
      onEvent: (e) => { events.push(e); },
      onNotice: () => { throw new Error('notice failed'); },
    });
    sess.send('hello');

    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'result' && e.ok)).toBe(true);
    });
    expect(sess.sessionId).toBe('fresh-after-notice-error');
    await sess.close();
  });

  it('pump 收尾窗口内的新消息会迁移到新 query，不会静默丢失', async () => {
    const events: any[] = [];
    const consumed: string[] = [];
    let sess!: Session;
    let queuedSecond = false;

    hoisted.responders.push(async function* (prompt) {
      const first = await prompt[Symbol.asyncIterator]().next();
      consumed.push((first.value as any)?.message?.content);
      yield { type: 'result', is_error: false, result: 'first done', duration_ms: 1, num_turns: 1 };
      // generator 在 result 后自然结束，模拟 SDK/transport 收尾。
    });
    hoisted.responders.push(async function* (prompt) {
      const second = await prompt[Symbol.asyncIterator]().next();
      consumed.push((second.value as any)?.message?.content);
      yield { type: 'result', is_error: false, result: 'second done', duration_ms: 1, num_turns: 1 };
    });

    sess = new Session({
      threadKey: 'c:u:pump-window',
      cwd: '/tmp',
      onEvent: (event) => {
        events.push(event);
        if (event.kind === 'result' && event.text === 'first done' && !queuedSecond) {
          queuedSecond = true;
          sess.send('second');
        }
      },
    });
    sess.send('first');

    await vi.waitFor(() => {
      expect(events.filter((event) => event.kind === 'result')).toHaveLength(2);
    });
    expect(consumed).toEqual(['first', 'second']);
    expect(events.some((event) => event.kind === 'error')).toBe(false);
    expect(hoisted.calls).toHaveLength(2);
    await sess.close();
  });
});

describe('Session.setModel 在线切换', () => {
  /**
   * 起一个已 start 的 session。responder 挂在 gate 上保持 query 存活（setModel
   * 需要 this.q 有效），测试末尾 release() 让它自然收尾，close() 才不会卡住。
   */
  function startedSession(suffix: string, model?: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    hoisted.responders.push(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sid' };
      await gate;
    });
    const sess = new Session({
      threadKey: `c:u:${suffix}`,
      cwd: '/tmp',
      ...(model ? { model } : {}),
    });
    sess.start(); // 同步建立 query
    return { sess, release };
  }

  it('切换成功后返回 true 并把模型透传给 SDK', async () => {
    const { sess, release } = startedSession('set-model');
    await expect(sess.setModel('grok-4.5')).resolves.toBe(true);
    expect(hoisted.setModelCalls).toEqual(['grok-4.5']);
    release();
    await sess.close();
  });

  it('空模型名直接返回 false，绝不调用 SDK', async () => {
    // setModel(undefined) 只会回落到子进程启动时的 ANTHROPIC_MODEL，
    // 不等于「不指定模型」—— 必须交给 pool 走重启。
    const { sess, release } = startedSession('set-model-empty');
    await expect(sess.setModel('')).resolves.toBe(false);
    expect(hoisted.setModelCalls).toEqual([]);
    release();
    await sess.close();
  });

  it('SDK 报错时返回 false，交由调用方回退重启', async () => {
    const { sess, release } = startedSession('set-model-throw');
    hoisted.setModelThrows = true;
    await expect(sess.setModel('grok-4.5')).resolves.toBe(false);
    release();
    await sess.close();
  });

  it('未启动的会话返回 false', async () => {
    const sess = new Session({ threadKey: 'c:u:set-model-unstarted', cwd: '/tmp' });
    await expect(sess.setModel('grok-4.5')).resolves.toBe(false);
    await sess.close();
  });

  it('构造时传入的模型进入 query options', async () => {
    const { sess, release } = startedSession('model-option', 'deepseek-v4-flash-cc[1m]');
    expect(hoisted.calls[0]?.options['model']).toBe('deepseek-v4-flash-cc[1m]');
    release();
    await sess.close();
  });

  it('在线切换后的模型在 pump 重建时保持', async () => {
    // 关键行为：setModel 回写 cfg.model，使得 pump 重建（buildOptions）后仍用新模型，
    // 而不是退回会话创建时的那个。
    const events: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    hoisted.responders.push(async function* (prompt) {
      await prompt[Symbol.asyncIterator]().next();
      await gate; // 挂住等 setModel，再正常收尾
      yield { type: 'result', is_error: false, result: 'ok', duration_ms: 1, num_turns: 1 };
    });
    hoisted.responders.push(async function* (prompt) {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: 'result', is_error: false, result: 'ok2', duration_ms: 1, num_turns: 1 };
    });

    const sess = new Session({
      threadKey: 'c:u:model-persist',
      cwd: '/tmp',
      onEvent: (e) => {
        events.push(e);
      },
    });
    sess.send('first');
    await vi.waitFor(() => expect(hoisted.calls).toHaveLength(1));
    expect(hoisted.calls[0]?.options['model']).toBeUndefined();

    await expect(sess.setModel('grok-4.5')).resolves.toBe(true);
    release();
    await vi.waitFor(() => expect(events.filter((e) => e.kind === 'result')).toHaveLength(1));
    await Promise.resolve();

    sess.send('next'); // 重建 pump
    await vi.waitFor(() => expect(hoisted.calls).toHaveLength(2));
    expect(hoisted.calls[1]?.options['model']).toBe('grok-4.5');
    await sess.close();
  });
});

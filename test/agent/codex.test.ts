import { describe, it, expect, vi } from 'vitest';
import { buildCodexArgs } from '../../src/agent/codex-args.js';
import { CodexJsonlTranslator } from '../../src/agent/codex-jsonl.js';
import { CodexSession, isStaleCodexResumeError } from '../../src/agent/codex-session.js';
import type { EngineEvent } from '../../src/engine/events.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

describe('buildCodexArgs', () => {
  it('新会话：exec --json + stdin prompt', () => {
    const args = buildCodexArgs({ cwd: '/w', sandbox: 'workspace-write' });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--skip-git-repo-check');
    expect(args[args.length - 1]).toBe('-');
    expect(args).not.toContain('resume');
  });

  it('resume 会话：exec … resume --json <threadId> -', () => {
    const args = buildCodexArgs({ cwd: '/w', sandbox: 'read-only', threadId: 'th_123' });
    const i = args.indexOf('resume');
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toBe('--json');
    expect(args[i + 2]).toBe('th_123');
    expect(args[i + 3]).toBe('-');
  });

  it('model 透传，非法沙箱抛错', () => {
    const args = buildCodexArgs({ cwd: '/w', sandbox: 'danger-full-access', model: 'o4-mini' });
    expect(args).toContain('--model');
    expect(args).toContain('o4-mini');
    expect(() =>
      buildCodexArgs({ cwd: '/w', sandbox: 'rm-rf' as never }),
    ).toThrow(/unsafe sandbox/);
  });
});

describe('CodexJsonlTranslator', () => {
  function run(events: unknown[]): EngineEvent[] {
    const t = new CodexJsonlTranslator();
    return events.flatMap((e) => t.translate(e));
  }

  it('thread.started → init（threadId 作为 sessionId）', () => {
    const out = run([{ type: 'thread.started', thread_id: 'th_1' }]);
    expect(out).toEqual([{ kind: 'init', sessionId: 'th_1' }]);
  });

  it('命令执行完整流：tool-use → tool-result（exit_code 非 0 记为 error）', () => {
    const out = run([
      { type: 'item.started', item: { type: 'command_execution', id: 'c1', command: 'ls' } },
      { type: 'item.completed', item: { type: 'command_execution', id: 'c1', output: 'ok', exit_code: 0 } },
      { type: 'item.started', item: { type: 'command_execution', id: 'c2', command: 'bad' } },
      { type: 'item.completed', item: { type: 'command_execution', id: 'c2', output: 'boom', exit_code: 1 } },
    ]);
    expect(out).toEqual([
      { kind: 'tool-use', id: 'c1', name: 'command_execution', input: { command: 'ls' } },
      { kind: 'tool-result', toolUseId: 'c1', content: 'ok', isError: false },
      { kind: 'tool-use', id: 'c2', name: 'command_execution', input: { command: 'bad' } },
      { kind: 'tool-result', toolUseId: 'c2', content: 'boom', isError: true },
    ]);
  });

  it('agent_message（两种形态）→ assistant-text', () => {
    const out = run([
      { type: 'item.completed', item: { type: 'agent_message', text: '回答A' } },
      { type: 'agent_message', message: '回答B' },
    ]);
    expect(out).toEqual([
      { kind: 'assistant-text', text: '回答A' },
      { kind: 'assistant-text', text: '回答B' },
    ]);
  });

  it('turn.completed → result ok + usage 映射', () => {
    const out = run([
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'result',
      ok: true,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 0 },
    });
  });

  it('turn.failed → result 失败；终态后不再产出事件', () => {
    const t = new CodexJsonlTranslator();
    const out = t.translate({ type: 'turn.failed', error: { message: '爆了' } });
    expect(out[0]).toMatchObject({ kind: 'result', ok: false, text: '爆了' });
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate({ type: 'agent_message', message: 'late' })).toEqual([]);
  });

  it('流提前结束 finish(failed) 补终态并附带最后一个非终态错误', () => {
    const t = new CodexJsonlTranslator();
    t.translate({ type: 'error', message: '限流' });
    const out = t.finish('failed');
    expect(out[0]).toMatchObject({ kind: 'result', ok: false });
    expect((out[0] as { text: string }).text).toContain('限流');
    // 已终态后 finish 幂等
    expect(t.finish('failed')).toEqual([]);
  });

  it('未知事件/非 JSON record 安静忽略', () => {
    expect(run([{ type: 'fancy.new.event' }, null, 42, 'str'])).toEqual([]);
  });
});

describe('Codex stale resume 识别', () => {
  it('识别本地 thread/session 丢失错误', () => {
    expect(isStaleCodexResumeError('thread not found: 123')).toBe(true);
    expect(isStaleCodexResumeError('Session not found for thread_id: abc')).toBe(true);
    expect(isStaleCodexResumeError('Failed to resume session from /tmp/rollout')).toBe(true);
  });

  it('普通执行错误不误判为 stale resume', () => {
    expect(isStaleCodexResumeError('command not found: rg')).toBe(false);
    expect(isStaleCodexResumeError('rate limited')).toBe(false);
  });
});

describe('CodexSession 子进程故障', () => {
  it('close 后 send 明确抛错而不是静默吞消息', async () => {
    const session = new CodexSession({
      threadKey: 'oc_x:ou_x:closed',
      cwd: '/tmp',
      sandbox: 'workspace-write',
    });
    await session.close();
    expect(() => session.send('lost')).toThrow(/closed/);
  });

  it('可执行文件不存在时产出终态且 close 不挂死', async () => {
    const events: EngineEvent[] = [];
    const session = new CodexSession({
      threadKey: 'oc_x:ou_x:default',
      cwd: '/tmp',
      codexBin: '/definitely/not/a/real/codex-binary',
      sandbox: 'workspace-write',
      onEvent: (event) => { events.push(event); },
    });
    session.send('hello');

    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'result' || event.kind === 'error')).toBe(true);
    }, { timeout: 2_000 });
    const terminal = events.find((event) => event.kind === 'result' || event.kind === 'error');
    expect(terminal && (terminal.kind === 'result' ? terminal.text : terminal.message)).toMatch(/ENOENT|not\/a\/real/);
    await expect(session.close(500)).resolves.toBeUndefined();
  });
});

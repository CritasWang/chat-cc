import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { log } from '../logger.js';
import type { EngineEvent } from '../engine/events.js';
import type { AgentSession, AgentSessionCallbacks } from './types.js';
import { buildCodexArgs, type CodexSandboxMode } from './codex-args.js';
import { CodexJsonlTranslator } from './codex-jsonl.js';

/**
 * Codex 会话 — `codex exec` 子进程 + JSONL 流。
 *
 * 与 Claude 的常驻 streaming query 不同，Codex 是「一轮一进程」：
 * 每条消息 spawn 一次 `codex exec`（带 resume threadId 维持上下文），
 * 消息在内部队列串行消费，行为对上层（SessionPool/streamer）透明。
 *
 * sessionId 字段存放 Codex threadId，复用现有持久化/恢复链路。
 */

export interface CodexSessionConfig extends AgentSessionCallbacks {
  threadKey: string;
  cwd: string;
  /** codex 可执行文件（默认 PATH 里的 `codex`） */
  codexBin?: string;
  sandbox: CodexSandboxMode;
  model?: string;
  /** 上次持久化的 Codex threadId，用于 resume */
  resumeId?: string;
  /** 单轮超时（毫秒），超时 SIGTERM；<=0 不限制 */
  turnTimeoutMs?: number;
  /** Codex spawn 后首 token 超时（毫秒）；超时无任何 JSONL → 判定卡死；<=0 不限制 */
  firstTokenTimeoutMs?: number;
  /** 传给 codex 子进程的最小环境。 */
  env?: NodeJS.ProcessEnv;
}

export class CodexSession implements AgentSession {
  readonly threadKey: string;
  readonly cwd: string;
  sessionId?: string;
  createdAt = new Date();
  lastUsedAt = new Date();

  private readonly queue: string[] = [];
  private draining = false;
  private closed = false;
  private current: ChildProcessWithoutNullStreams | undefined;
  private currentRun: Promise<void> | undefined;
  private interrupted = false;

  constructor(private readonly cfg: CodexSessionConfig) {
    this.threadKey = cfg.threadKey;
    this.cwd = cfg.cwd;
    if (cfg.resumeId) this.sessionId = cfg.resumeId;
  }

  start(): void {
    // Codex 无常驻进程，start 为 no-op（首条消息时 spawn）
  }

  send(text: string, _opts?: { parentToolUseId?: string }): void {
    if (this.closed) throw new Error(`codex session ${this.threadKey} is closed`);
    this.lastUsedAt = new Date();
    this.queue.push(text);
    void this.drain().catch((err) => {
      log().error({ err, threadKey: this.threadKey }, 'codex drain 异常');
      void this.emit({ kind: 'error', message: `codex 队列异常: ${String(err)}` }).catch(() => {});
    });
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.queue.length = 0;
    const run = this.currentRun;
    if (this.current) {
      await terminateProcess(this.current, 2_000);
    }
    if (run) await settleWithin(run.catch(() => {}), 3_000);
  }

  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    const run = this.currentRun;
    if (this.current) {
      await terminateProcess(this.current, Math.max(0, timeoutMs - 1_000));
    }
    if (run) await settleWithin(run.catch(() => {}), Math.max(500, timeoutMs));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const prompt = this.queue.shift()!;
        this.interrupted = false;
        const run = this.runOnce(prompt);
        this.currentRun = run;
        try {
          await run;
        } finally {
          if (this.currentRun === run) this.currentRun = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOnce(prompt: string, allowResumeRecovery = true): Promise<void> {
    const resumeIdAtStart = this.sessionId;
    const bin = this.cfg.codexBin || 'codex';
    const args = buildCodexArgs({
      cwd: this.cwd,
      sandbox: this.cfg.sandbox,
      ...(resumeIdAtStart ? { threadId: resumeIdAtStart } : {}),
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
    });
    const translator = new CodexJsonlTranslator();

    log().info({ threadKey: this.threadKey, resume: !!resumeIdAtStart }, 'codex run 启动');

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.cfg.env ? { env: this.cfg.env } : {}),
      });
    } catch (err) {
      await this.emit({ kind: 'error', message: `codex 启动失败: ${String(err)}` });
      return;
    }
    this.current = proc;
    // 必须在下一 tick 前监听 error/close。spawn 失败（ENOENT/EACCES）可能没有 exit 事件，
    // 因此统一等待 close，不能只 await exit。
    const processDone = observeProcess(proc);

    let killTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutMs = this.cfg.turnTimeoutMs ?? 0;
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        log().warn({ threadKey: this.threadKey, timeoutMs }, 'codex run 超时，开始终止进程');
        void terminateProcess(proc, 2_000).catch((err) =>
          log().warn({ err, threadKey: this.threadKey }, 'codex 超时终止进程失败'),
        );
      }, timeoutMs);
      killTimer.unref?.();
    }

    // 首 token 超时：spawn 后 N 分钟无任何 JSONL 输出 → 判定卡死
    let firstTokenTimer: NodeJS.Timeout | undefined;
    let firstTokenArrived = false;
    const firstTokenMs = this.cfg.firstTokenTimeoutMs ?? 0;
    if (firstTokenMs > 0) {
      firstTokenTimer = setTimeout(() => {
        if (!firstTokenArrived && !this.closed) {
          timedOut = true;
          log().warn({ threadKey: this.threadKey, firstTokenMs }, 'codex 首 token 超时，判定卡死');
          void terminateProcess(proc, 2_000).catch((err) =>
            log().warn({ err, threadKey: this.threadKey }, 'codex 首 token 终止失败'),
          );
        }
      }, firstTokenMs);
      firstTokenTimer.unref?.();
    }

    const stderrBuf: string[] = [];
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrBuf.push(s);
      if (stderrBuf.length > 50) stderrBuf.shift();
    });

    // prompt 走 stdin，规避 argv 特殊字符/长度问题
    proc.stdin.on('error', () => { /* EPIPE：进程未启动成功等场景 */ });
    proc.stdin.write(prompt);
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    const diagnosticParts: string[] = [];
    let sawWork = false;
    let recoverStaleResume = false;
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 首 token 定时器：第一个有效 JSONL 行到达即清除
        if (firstTokenTimer && !firstTokenArrived) {
          firstTokenArrived = true;
          clearTimeout(firstTokenTimer);
          firstTokenTimer = undefined;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // 非 JSON 行（横幅/告警）忽略
        }
        if (isDiagnosticEvent(parsed)) pushDiagnostic(diagnosticParts, JSON.stringify(parsed));
        for (const ev of this.tagInit(translator.translate(parsed))) {
          if (ev.kind === 'assistant-text' || ev.kind === 'tool-use' || ev.kind === 'tool-result') {
            sawWork = true;
          }
          if (
            ev.kind === 'result' &&
            !ev.ok &&
            canRecoverStaleResume({
              allowResumeRecovery,
              resumeIdAtStart,
              currentSessionId: this.sessionId,
              sawWork,
              interrupted: this.interrupted,
              timedOut,
              diagnostic: `${ev.text}\n${diagnosticParts.join('\n')}`,
            })
          ) {
            recoverStaleResume = true;
            continue;
          }
          if (ev.kind === 'result' && timedOut) {
            ev.ok = false;
            ev.text = sawWork
              ? `codex 执行超时（>${Math.ceil(timeoutMs / 60_000)} 分钟），已终止`
              : `codex 启动后 ${Math.ceil(firstTokenMs / 60_000)} 分钟无响应（上下文积压可能过大），建议 \`/reset\` 清空上下文后重试`;
          }
          await this.emit(ev);
        }
      }
      let outcome = await settleWithin(processDone, 5_000);
      if (!outcome.settled) {
        log().warn({ threadKey: this.threadKey }, 'codex stdout 已结束但进程未退出，开始终止');
        await terminateProcess(proc, 2_000);
        outcome = await settleWithin(processDone, 1_500);
      }
      if (outcome.settled && outcome.value.error) {
        pushDiagnostic(diagnosticParts, outcome.value.error.message);
      }
      if (stderrBuf.length > 0) pushDiagnostic(diagnosticParts, stderrBuf.join(''));

      recoverStaleResume ||= canRecoverStaleResume({
        allowResumeRecovery,
        resumeIdAtStart,
        currentSessionId: this.sessionId,
        sawWork,
        interrupted: this.interrupted,
        timedOut,
        diagnostic: diagnosticParts.join('\n'),
      });

      if (!recoverStaleResume && !translator.terminalEmitted()) {
        const reason = timedOut ? 'timeout' : this.interrupted ? 'interrupted' : 'failed';
        for (const ev of translator.finish(reason)) {
          if (ev.kind === 'result' && !ev.ok) {
            const diagnostic = [...diagnosticParts, ...stderrBuf].join('\n').slice(-800);
            if (diagnostic && !ev.text.includes(diagnostic)) {
              ev.text = `${ev.text}\n${diagnostic}`.trim();
            }
          }
          if (ev.kind === 'result' && timedOut) {
            ev.ok = false;
            ev.text = sawWork
              ? `codex 执行超时（>${Math.ceil(timeoutMs / 60_000)} 分钟），已终止`
              : `codex 启动后 ${Math.ceil(firstTokenMs / 60_000)} 分钟无响应（上下文积压可能过大），建议 \`/reset\` 清空上下文后重试`;
          }
          await this.emit(ev);
        }
        const code = outcome.settled ? outcome.value.code : null;
        if (code !== 0 && code !== null) {
          log().warn({ threadKey: this.threadKey, code, stderr: stderrBuf.join('').slice(-500) }, 'codex 非零退出');
        }
      }
    } catch (err) {
      pushDiagnostic(diagnosticParts, String(err));
      recoverStaleResume ||= canRecoverStaleResume({
        allowResumeRecovery,
        resumeIdAtStart,
        currentSessionId: this.sessionId,
        sawWork,
        interrupted: this.interrupted,
        timedOut,
        diagnostic: diagnosticParts.join('\n'),
      });
      if (!recoverStaleResume) {
        await terminateProcess(proc, 2_000).catch(() => {});
        await this.emit({ kind: 'error', message: `codex 运行异常: ${String(err)}` });
      }
    } finally {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (killTimer) clearTimeout(killTimer);
      rl.close();
      if (this.current === proc) this.current = undefined;
    }

    if (recoverStaleResume && resumeIdAtStart && !this.closed) {
      if (this.sessionId === resumeIdAtStart) this.sessionId = undefined;
      log().warn(
        { threadKey: this.threadKey, staleSessionId: resumeIdAtStart },
        'codex resume 失效，已降级为新会话并安全重试当前 prompt',
      );
      try {
        this.cfg.onNotice?.({
          text: '原 Codex 会话上下文已过期，已新建会话继续',
          staleSessionId: resumeIdAtStart,
        });
      } catch (err) {
        log().warn({ err, threadKey: this.threadKey }, 'codex resume 自愈通知失败');
      }
      await this.runOnce(prompt, false);
    }
  }

  /** thread.started 更新本会话 threadId（供后续 resume 与持久化） */
  private tagInit(events: EngineEvent[]): EngineEvent[] {
    for (const ev of events) {
      if (ev.kind === 'init') {
        this.sessionId = ev.sessionId;
      }
    }
    return events;
  }

  private async emit(ev: EngineEvent): Promise<void> {
    if (this.closed) return;
    this.lastUsedAt = new Date();
    await this.cfg.onEvent?.(ev);
  }
}

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function observeProcess(proc: ChildProcessWithoutNullStreams): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    proc.once('error', (err) => {
      spawnError = err;
    });
    proc.once('close', (code, signal) => {
      resolve({ code, signal, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}

const terminating = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

async function terminateProcess(proc: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  const existing = terminating.get(proc);
  if (existing) return existing;
  const task = (async () => {
    if (hasExited(proc)) return;
    // proc.killed 仅表示 kill() 曾成功发送信号，不表示子进程已经退出。
    if (!proc.killed) proc.kill('SIGTERM');
    const graceful = await waitForExit(proc, Math.max(0, graceMs));
    if (graceful || hasExited(proc)) return;
    proc.kill('SIGKILL');
    await waitForExit(proc, 1_000);
  })().finally(() => terminating.delete(proc));
  terminating.set(proc, task);
  return task;
}

function hasExited(proc: ChildProcessWithoutNullStreams): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', onExit);
      proc.off('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    proc.once('exit', onExit);
    proc.once('close', onExit);
  });
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface StaleCheck {
  allowResumeRecovery: boolean;
  resumeIdAtStart?: string;
  currentSessionId?: string;
  sawWork: boolean;
  interrupted: boolean;
  timedOut: boolean;
  diagnostic: string;
}

function canRecoverStaleResume(check: StaleCheck): boolean {
  return Boolean(
    check.allowResumeRecovery &&
      check.resumeIdAtStart &&
      check.currentSessionId === check.resumeIdAtStart &&
      !check.sawWork &&
      !check.interrupted &&
      !check.timedOut &&
      isStaleCodexResumeError(check.diagnostic),
  );
}

/** 仅在“带 resume 且尚未产生任何工作事件”时使用，避免副作用重放。 */
export function isStaleCodexResumeError(text: string): boolean {
  const value = text.toLowerCase();
  return (
    value.includes('thread not found') ||
    value.includes('session not found') ||
    value.includes('failed to resume session from') ||
    value.includes('failed to resume thread') ||
    value.includes('no rollout found')
  );
}

function isDiagnosticEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const type = (raw as Record<string, unknown>)['type'];
  return type === 'error' || type === 'turn.failed';
}

function pushDiagnostic(parts: string[], value: string): void {
  if (!value) return;
  parts.push(value.slice(-2_000));
  if (parts.length > 20) parts.shift();
}

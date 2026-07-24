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
  private interrupted = false;

  constructor(private readonly cfg: CodexSessionConfig) {
    this.threadKey = cfg.threadKey;
    this.cwd = cfg.cwd;
    if (cfg.resumeId) this.sessionId = cfg.resumeId;
  }

  start(): void {
    // Codex 无常驻进程，start 为 no-op（首条消息时 spawn）
  }

  send(text: string): void {
    if (this.closed) return;
    this.lastUsedAt = new Date();
    this.queue.push(text);
    void this.drain();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.queue.length = 0;
    if (this.current) {
      this.current.kill('SIGTERM');
    }
  }

  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    if (this.current) {
      this.current.kill('SIGTERM');
      // 宽限期后强杀
      const proc = this.current;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, timeoutMs);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const prompt = this.queue.shift()!;
        this.interrupted = false;
        await this.runOnce(prompt);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOnce(prompt: string): Promise<void> {
    const bin = this.cfg.codexBin || 'codex';
    const args = buildCodexArgs({
      cwd: this.cwd,
      sandbox: this.cfg.sandbox,
      ...(this.sessionId ? { threadId: this.sessionId } : {}),
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
    });
    const translator = new CodexJsonlTranslator();

    log().info({ threadKey: this.threadKey, resume: !!this.sessionId }, 'codex run 启动');

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      await this.emit({ kind: 'error', message: `codex 启动失败: ${String(err)}` });
      return;
    }
    this.current = proc;

    // ENOENT / EACCES 等 spawn 异步错误不抛同步异常，必须监听 error 事件，
    // 否则会成为未处理 EventEmitter error 导致进程 crash。
    proc.on('error', () => {
      // 进程启动失败：error → close（无 exit）→ exitCode=-2，
      // 现有 exit 与 terminalEmitted 逻辑能识别异常退出并产出 error EngineEvent，
      // 此处仅需监听以阻止 crash——无需额外 emit。
    });

    let killTimer: NodeJS.Timeout | undefined;
    const timeoutMs = this.cfg.turnTimeoutMs ?? 0;
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        log().warn({ threadKey: this.threadKey, timeoutMs }, 'codex run 超时，SIGTERM');
        proc.kill('SIGTERM');
      }, timeoutMs);
      killTimer.unref?.();
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
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // 非 JSON 行（横幅/告警）忽略
        }
        for (const ev of this.tagInit(translator.translate(parsed))) {
          await this.emit(ev);
        }
      }
      // 等进程退出，拿 exit code
      const code = await new Promise<number | null>((resolve) => {
        if (proc.exitCode !== null) resolve(proc.exitCode);
        else proc.once('exit', (c) => resolve(c));
      });
      if (!translator.terminalEmitted()) {
        const reason = this.interrupted ? 'interrupted' : 'failed';
        for (const ev of translator.finish(reason)) {
          if (ev.kind === 'result' && !ev.ok && stderrBuf.length > 0) {
            ev.text = `${ev.text}\n${stderrBuf.join('').slice(-800)}`.trim();
          }
          await this.emit(ev);
        }
        if (code !== 0 && code !== null) {
          log().warn({ threadKey: this.threadKey, code, stderr: stderrBuf.join('').slice(-500) }, 'codex 非零退出');
        }
      }
    } catch (err) {
      await this.emit({ kind: 'error', message: `codex 运行异常: ${String(err)}` });
    } finally {
      if (killTimer) clearTimeout(killTimer);
      rl.close();
      this.current = undefined;
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
    this.lastUsedAt = new Date();
    await this.cfg.onEvent?.(ev);
  }
}

import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../logger.js';
import { translateSdkMessage, type EngineEvent } from './events.js';

export interface SessionConfig {
  threadKey: string;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: Options['permissionMode'];
  resumeId?: string;
  /** 单轮无输出/未结束超时；超时 abort 当前 query，下条消息自动恢复。 */
  turnTimeoutMs?: number;
  extraOptions?: Omit<
    Options,
    'cwd' | 'model' | 'allowedTools' | 'disallowedTools' | 'permissionMode' | 'resume'
  >;
  onEvent?: (e: EngineEvent) => void | Promise<void>;
  /** 带外通知（如 resume 失效已自愈），不走 onEvent/streamer 链路 */
  onNotice?: (n: { text: string; staleSessionId?: string }) => void;
}

class MessageQueue {
  private buf: SDKUserMessage[] = [];
  private wakeup: (() => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage): boolean {
    if (this.closed) return false;
    this.buf.push(m);
    this.wakeup?.();
    this.wakeup = null;
    return true;
  }

  /** 尚未交给 SDK prompt iterator 的消息；这些消息可证明没有被执行。 */
  buffered(): SDKUserMessage[] {
    return [...this.buf];
  }

  takeBuffered(): SDKUserMessage[] {
    const buffered = this.buf;
    this.buf = [];
    return buffered;
  }

  close(): void {
    this.closed = true;
    // close 表示旧 consumer 永久作废；安全迁移方必须在调用前显式 takeBuffered()。
    // 不清空会导致 stream() 醒来后先 yield 旧缓冲，再检查 closed。
    this.buf = [];
    this.wakeup?.();
    this.wakeup = null;
  }

  async *stream(): AsyncIterable<SDKUserMessage> {
    while (true) {
      while (this.buf.length > 0) {
        yield this.buf.shift()!;
      }
      if (this.closed) return;
      await new Promise<void>((r) => {
        this.wakeup = r;
      });
    }
  }
}

export class Session {
  readonly threadKey: string;
  sessionId?: string;
  private queue = new MessageQueue();
  private q?: Query;
  private pumpPromise?: Promise<void>;
  private started = false;
  createdAt = new Date();
  lastUsedAt = new Date();
  /** 已发送但尚未被 SDK result 确认；仅 stale-resume 或仍在本地 buffer 时允许重放。 */
  private pending: SDKUserMessage[] = [];
  /** 最近一次已确认失效的 resume ID；只阻止同一个坏 ID 无限自愈循环。 */
  private rejectedResumeId?: string;
  /** close() 后置位：pump 停止分发事件，防止被替换的旧会话（僵尸）继续刷卡片/记账 */
  private closed = false;
  /** 当前 pump 已结束或异常退出；下次 send() 前必须重建 query。 */
  private pumpNeedsRestart = false;
  private abortController = new AbortController();
  private turnTimer?: NodeJS.Timeout;
  private timeoutError?: string;
  /** 当前 pump 是否至少产出过一个 result；用于区分正常收尾与启动即退出。 */
  private terminalSeenInPump = false;

  readonly cwd: string;

  constructor(private readonly cfg: SessionConfig) {
    this.threadKey = cfg.threadKey;
    this.cwd = cfg.cwd;
    if (cfg.resumeId) this.sessionId = cfg.resumeId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.q = query({ prompt: this.queue.stream(), options: this.buildOptions(true) });
    this.launchPump();
  }

  private launchPump(): void {
    this.terminalSeenInPump = false;
    this.pumpPromise = this.runLoop().then(
      () => this.handlePumpEnd(),
      (err) => this.handlePumpEnd(err),
    );
  }

  private handlePumpEnd(err?: unknown): void {
    if (this.closed) return;

    // runLoop Promise 的完成回调晚于 async generator 实际耗尽。窗口内的新 send 可能已经
    // 写入旧 queue；只重放仍留在 queue.buf 的消息，因为它们尚未交给 SDK，绝无副作用。
    const buffered = this.queue.buffered();
    const bufferedSet = new Set(buffered);
    const unsafePendingCount = this.pending.reduce(
      (count, message) => count + (bufferedSet.has(message) ? 0 : 1),
      0,
    );
    const terminalSeen = this.terminalSeenInPump;
    const shouldReportError = !terminalSeen || unsafePendingCount > 0;
    let autoRecovered = false;

    if (terminalSeen && buffered.length > 0 && unsafePendingCount === 0) {
      const replay = this.queue.takeBuffered();
      this.pending = replay;
      try {
        this.replacePump(replay, true);
        autoRecovered = true;
        log().warn(
          { thread: this.threadKey, sessionId: this.sessionId, replayedCount: replay.length },
          'session pump 收尾窗口内有未消费消息，已自动迁移到新 pump',
        );
      } catch (recoverErr) {
        this.pumpNeedsRestart = true;
        this.reportPumpError(recoverErr);
        return;
      }
    } else {
      // async generator 已结束，下一条 send 必须先重建 query。这里不把正常收尾误报为 crash。
      this.pumpNeedsRestart = true;
    }

    if (!shouldReportError) {
      if (err) {
        log().warn({ err, thread: this.threadKey }, 'session pump 在终态后退出，等待后续发送恢复');
      }
      if (autoRecovered) return;
      this.clearTurnTimer();
      this.timeoutError = undefined;
      return;
    }

    this.reportPumpError(err ?? new Error(this.timeoutError ?? 'session pump 意外结束'));
  }

  /** 泵异常上报：调用方必须先把 pump 状态切到“可恢复”或已完成自动恢复。 */
  private reportPumpError(err: unknown): void {
    // 已 close 的会话（如 /danger 重启后被替换的旧实例）的 pump 收尾异常不再上报，
    // 避免向已终结的直播卡片发送虚假 error 事件
    if (this.closed) return;
    log().error({ err, thread: this.threadKey }, 'session pump 异常退出');
    this.clearTurnTimer();
    const message = this.timeoutError ?? String(err);
    this.timeoutError = undefined;
    const reported = this.cfg.onEvent?.({ kind: 'error', message });
    if (reported && typeof reported.then === 'function') {
      void reported.catch((eventErr) =>
        log().error({ err: eventErr, thread: this.threadKey }, 'session pump error 事件上报失败'),
      );
    }
  }

  private buildOptions(withResume: boolean): Options {
    const resumeId = this.sessionId;
    return {
      cwd: this.cfg.cwd,
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
      ...(this.cfg.allowedTools ? { allowedTools: this.cfg.allowedTools } : {}),
      ...(this.cfg.disallowedTools ? { disallowedTools: this.cfg.disallowedTools } : {}),
      ...(this.cfg.permissionMode ? { permissionMode: this.cfg.permissionMode } : {}),
      ...(withResume && resumeId ? { resume: resumeId } : {}),
      ...(this.cfg.extraOptions ?? {}),
      abortController: this.abortController,
    };
  }

  send(text: string, opts?: { parentToolUseId?: string }): void {
    if (this.closed) throw new Error(`session ${this.threadKey} is closed`);
    this.lastUsedAt = new Date();
    if (this.pumpNeedsRestart) {
      this.restartPump();
    }
    if (!this.started) this.start();
    const m: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: opts?.parentToolUseId ?? null,
    };
    if (!this.queue.push(m)) {
      // JS 同步段内 close() 无法插入这里；该分支用于防未来重构或异常 queue 状态静默吞消息。
      if (this.closed) throw new Error(`session ${this.threadKey} is closed`);
      this.pumpNeedsRestart = true;
      this.restartPump();
      if (!this.queue.push(m)) throw new Error(`session ${this.threadKey} queue is closed`);
    }
    this.pending.push(m);
    this.armTurnTimer();
  }

  async interrupt(): Promise<void> {
    if (this.q && !this.closed) await this.q.interrupt();
  }

  /**
   * 在线切换权限模式（SDK setPermissionMode 控制请求），不打断运行中的任务。
   * 依赖创建时始终安装 canUseTool + allowDangerouslySkipPermissions（见 main.ts 会话工厂），
   * 因此开/关两个方向均可在线切换。
   * @returns true 切换成功；false 表示无法在线切换（未启动/已关闭/SDK 不支持或报错），
   *          调用方（pool.setSessionDanger）应回退为重启生效。
   */
  async setDanger(danger: boolean): Promise<boolean> {
    if (!this.started || !this.q || this.closed) return false;
    const mode = danger ? ('bypassPermissions' as const) : ('default' as const);
    try {
      await this.q.setPermissionMode(mode);
      // 记入 cfg：stale-resume 自愈重建（rebuildWithoutResume → buildOptions）时保持当前模式
      this.cfg.permissionMode = mode;
      return true;
    } catch (err) {
      log().warn({ err, thread: this.threadKey, danger }, 'setPermissionMode 在线切换失败，回退重启生效');
      return false;
    }
  }

  /**
   * 在线切换模型（SDK 控制请求），不打断运行中的任务。
   *
   * 只处理「切到某个具体模型」。传空值时必须返回 false 交给调用方重启：
   * SDK 的 setModel(undefined) 只会回落到**本 CLI 子进程启动时**的
   * ANTHROPIC_MODEL，而不是「不指定模型」—— 想真正清掉那个环境变量，
   * 只有重建子进程 env 一条路（见 pool.setSessionModel）。
   *
   * @returns true 已在线生效；false 需由调用方回退为重启生效。
   */
  async setModel(model: string): Promise<boolean> {
    if (!model || !this.started || !this.q || this.closed) return false;
    try {
      await this.q.setModel(model);
      // 记入 cfg：pump 重建 / stale-resume 自愈（→ buildOptions）时保持当前模型
      this.cfg.model = model;
      return true;
    } catch (err) {
      log().warn({ err, thread: this.threadKey, model }, 'setModel 在线切换失败，回退重启生效');
      return false;
    }
  }

  /**
   * pump 结束后重建 query。不会重放已经交给 SDK 的 pending（其副作用状态未知），
   * 只迁移仍留在 MessageQueue.buf、可证明从未交给 SDK 的消息。
   */
  private restartPump(): void {
    const oldQueue = this.queue;
    const buffered = oldQueue.takeBuffered();
    const bufferedSet = new Set(buffered);
    const droppedCount = this.pending.reduce(
      (count, message) => count + (bufferedSet.has(message) ? 0 : 1),
      0,
    );
    this.pending = buffered;
    this.replacePump(buffered, true);
    log().warn(
      {
        thread: this.threadKey,
        sessionId: this.sessionId,
        droppedCount,
        replayedBufferedCount: buffered.length,
      },
      '泵已恢复（仅迁移尚未交给 SDK 的缓冲消息）',
    );
  }

  /** 同步替换 queue/query；messages 必须是可证明尚未交给旧 SDK 的消息。 */
  private replacePump(messages: SDKUserMessage[], withResume: boolean): void {
    const oldQueue = this.queue;
    const oldQ = this.q;
    const nextQueue = new MessageQueue();
    for (const message of messages) {
      if (!nextQueue.push(message)) throw new Error('new session queue unexpectedly closed');
    }

    this.queue = nextQueue;
    this.abortController = new AbortController();
    oldQueue.close();
    oldQ?.close();

    this.q = query({ prompt: this.queue.stream(), options: this.buildOptions(withResume) });
    this.pumpNeedsRestart = false;
    this.started = true;
    this.launchPump();
  }

  async close(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTurnTimer();
    this.abortController.abort();
    this.queue.close();
    if (this.q) this.q.close();
    if (this.pumpPromise) {
      await Promise.race([
        this.pumpPromise,
        new Promise<void>((r) => setTimeout(r, timeoutMs)),
      ]);
    }
  }

  /** 顶层泵循环：消费当前 query，若遇 stale-resume 则重建为无 resume 会话后继续。 */
  private async runLoop(): Promise<void> {
    while (true) {
      const action = await this.pumpOnce();
      if (action === 'recovered' && !this.closed) {
        this.rebuildWithoutResume();
        continue;
      }
      return;
    }
  }

  /** 消费 this.q 直到自然结束（'done'）或检测到 resume 失效需重建（'recovered'）。 */
  private async pumpOnce(): Promise<'done' | 'recovered'> {
    if (!this.q) return 'done';
    try {
      for await (const msg of this.q) {
        // close() 后不再分发：旧 query 的 5s 收尾竞速超时后若仍在产出（僵尸），
        // 其事件不得再触达 streamer/cost（会刷已终结的卡片、重复记账）
        if (this.closed) return 'done';
        for (const ev of translateSdkMessage(msg)) {
          // 同一条 SDK 消息可产出多个事件（text + tool_use 等），await onEvent 期间
          // 可能被并发 close() —— 事件粒度再查一次，保证 closed 后一个事件都不漏出
          if (this.closed) return 'done';
          if (ev.kind === 'init' && !this.sessionId) this.sessionId = ev.sessionId;
          // stale-resume 拦截：原会话上下文已不存在。不转发该错误 result，直接退出
          // for-await（自动触发旧 query .return() 干净中断），交由 runLoop 重建为新会话。
          // 用运行时 sessionId（当前 query 实际使用的 resume ID）判断，而非 cfg.resumeId
          //（cfg.resumeId 仅标记启动时是否有持久化 ID，会话自愈后 sessionId 可能为空）。
          if (
            ev.kind === 'result' &&
            ev.ok === false &&
            this.sessionId &&
            ev.detail?.errors?.some((e) => e.includes('No conversation found with session ID')) &&
            this.rejectedResumeId !== this.sessionId
          ) {
            return 'recovered';
          }
          this.lastUsedAt = new Date();
          // 任意非 stale 的 result（无论 ok/error）：消息已被消费，清空重放缓冲
          if (ev.kind === 'result') {
            if (this.timeoutError) {
              ev.ok = false;
              ev.text = this.timeoutError;
            }
            this.terminalSeenInPump = true;
            this.timeoutError = undefined;
            this.clearTurnTimer();
            this.pending = [];
          }
          await this.cfg.onEvent?.(ev);
        }
      }
      return 'done';
    } catch (err) {
      // 部分情况下 stale-resume 不以 result 形式出现，而是 SDK 直接抛错。
      // 用运行时 sessionId 判断：自愈后 sessionId 已置空，不会再误判。
      if (
        this.sessionId &&
        this.rejectedResumeId !== this.sessionId &&
        String(err).includes('No conversation found')
      ) {
        return 'recovered';
      }
      throw err;
    }
  }

  /**
   * resume 失效自愈：丢弃失效 sessionId，用不带 resume 的全新 query 重建会话，
   * 并把 in-flight 消息重放进新 queue（用户无感，仅丢失旧对话历史）。
   * 同步段（切换 queue 引用 + 重放）中间不 await，避免并发 send 落到已 close 的旧 queue。
   */
  private rebuildWithoutResume(): void {
    const stale = this.sessionId;
    this.rejectedResumeId = stale;
    this.sessionId = undefined;
    this.lastUsedAt = new Date();

    const oldQ = this.q;
    const oldQueue = this.queue;
    this.queue = new MessageQueue();
    for (const m of this.pending) {
      if (!this.queue.push(m)) throw new Error('new session queue unexpectedly closed');
    }

    oldQueue.close();
    oldQ?.close();

    this.q = query({ prompt: this.queue.stream(), options: this.buildOptions(false) });
    // 当前 runLoop 会在下一次 while 迭代继续消费新 query；这里不能另起第二个 pump。
    this.terminalSeenInPump = false;
    log().warn(
      { thread: this.threadKey, staleSessionId: stale },
      'resume 失效，已降级为新建会话并重放',
    );
    try {
      this.cfg.onNotice?.({ text: '原会话上下文已过期，已新建会话继续', staleSessionId: stale });
    } catch (err) {
      log().warn({ err, thread: this.threadKey }, 'resume 自愈通知失败');
    }
  }

  private armTurnTimer(): void {
    this.clearTurnTimer();
    const timeoutMs = this.cfg.turnTimeoutMs ?? 0;
    if (timeoutMs <= 0) return;
    this.turnTimer = setTimeout(() => {
      if (this.closed) return;
      this.timeoutError = `会话响应超时（>${Math.ceil(timeoutMs / 60_000)} 分钟），已中断当前 query`;
      this.abortController.abort(new Error(this.timeoutError));
    }, timeoutMs);
    this.turnTimer.unref?.();
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = undefined;
  }
}

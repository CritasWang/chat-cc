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

  push(m: SDKUserMessage): void {
    if (this.closed) return;
    this.buf.push(m);
    this.wakeup?.();
    this.wakeup = null;
  }

  close(): void {
    this.closed = true;
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
  /** 已投递进当前 query 但尚未被 SDK result 确认的消息（仅 stale-resume 自愈时重放） */
  private pending: SDKUserMessage[] = [];
  /** 一次性闸门：stale-resume 只自愈一次（新建会话无 resume，不会再 stale） */
  private resumeRecovered = false;
  /** close() 后置位：pump 停止分发事件，防止被替换的旧会话（僵尸）继续刷卡片/记账 */
  private closed = false;
  /** 泵异常退出后置位，下次 send() 触发自动恢复 */
  private pumpCrashed = false;

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
    this.pumpPromise = this.runLoop().catch((err) => this.handlePumpCrash(err));
  }

  /** 泵异常收敛：已 close 的会话静默，否则记日志 → 置位 pumpCrashed → 发 error 事件 */
  private handlePumpCrash(err: unknown): void {
    // 已 close 的会话（如 /danger 重启后被替换的旧实例）的 pump 收尾异常不再上报，
    // 避免向已终结的直播卡片发送虚假 error 事件
    if (this.closed) return;
    log().error({ err, thread: this.threadKey }, 'session pump 异常退出');
    // 先置位再发事件：下游 onEvent 拿到 error 时 pumpCrashed 已为 true，
    // 后续 send() 能正确触发 recoverFromCrash()
    this.pumpCrashed = true;
    void this.cfg.onEvent?.({ kind: 'error', message: String(err) });
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
    };
  }

  send(text: string): void {
    this.lastUsedAt = new Date();
    if (this.pumpCrashed) {
      // 泵已崩溃：自动恢复（重建空 query，不重放 pending，上下文经 sessionId resume）
      this.recoverFromCrash();
    }
    if (!this.started) this.start();
    const m: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    this.queue.push(m);
    this.pending.push(m);
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
   * 泵崩溃后自动恢复：使用当前 sessionId 重建 query，**不自动重放 pending**。
   * 无法证明 pending 中消息的副作用尚未执行——工具可能已成功但 result 未产出。
   * 仅 stale-resume 自愈路径可安全重放（已知旧会话已不存在）。
   */
  private recoverFromCrash(): void {
    const oldQueue = this.queue;
    const oldQ = this.q;
    this.queue = new MessageQueue();
    const droppedCount = this.pending.length;
    this.pending = [];

    oldQueue.close();
    oldQ?.close();

    // 重建空 query（不重放 pending），每次 send 时 push 入队自然触发消费
    this.q = query({ prompt: this.queue.stream(), options: this.buildOptions(true) });
    this.pumpPromise = this.runLoop().catch((err) => this.handlePumpCrash(err));
    this.pumpCrashed = false;
    this.started = true;
    log().warn({ thread: this.threadKey, sessionId: this.sessionId, droppedCount },
      '泵崩溃已恢复（pending 已丢弃，等待新消息）');
  }

  async close(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
            !this.resumeRecovered
          ) {
            return 'recovered';
          }
          this.lastUsedAt = new Date();
          // 任意非 stale 的 result（无论 ok/error）：消息已被消费，清空重放缓冲
          if (ev.kind === 'result') {
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
        !this.resumeRecovered &&
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
    this.resumeRecovered = true;
    this.sessionId = undefined;
    this.lastUsedAt = new Date();

    const oldQ = this.q;
    const oldQueue = this.queue;
    this.queue = new MessageQueue();
    for (const m of this.pending) this.queue.push(m);

    oldQueue.close();
    oldQ?.close();

    this.q = query({ prompt: this.queue.stream(), options: this.buildOptions(false) });
    log().warn(
      { thread: this.threadKey, staleSessionId: stale },
      'resume 失效，已降级为新建会话并重放',
    );
    this.cfg.onNotice?.({ text: '原会话上下文已过期，已新建会话继续', staleSessionId: stale });
  }
}

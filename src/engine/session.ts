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
  /** 已投递进当前 queue、但当前 query 尚未产出 result 的消息（resume 失效时用于重放） */
  private pending: SDKUserMessage[] = [];
  /** 仅带 resumeId 启动时追踪 pending；普通会话零开销 */
  private trackingPending: boolean;
  /** 一次性闸门：stale-resume 只自愈一次（新建会话无 resume，不会再 stale） */
  private resumeRecovered = false;

  readonly cwd: string;

  constructor(private readonly cfg: SessionConfig) {
    this.threadKey = cfg.threadKey;
    this.cwd = cfg.cwd;
    this.trackingPending = !!cfg.resumeId;
    if (cfg.resumeId) this.sessionId = cfg.resumeId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.q = query({ prompt: this.queue.stream(), options: this.buildOptions(true) });
    this.pumpPromise = this.runLoop().catch((err) => {
      log().error({ err, thread: this.threadKey }, 'session pump 异常退出');
      void this.cfg.onEvent?.({ kind: 'error', message: String(err) });
    });
  }

  private buildOptions(withResume: boolean): Options {
    return {
      cwd: this.cfg.cwd,
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
      ...(this.cfg.allowedTools ? { allowedTools: this.cfg.allowedTools } : {}),
      ...(this.cfg.disallowedTools ? { disallowedTools: this.cfg.disallowedTools } : {}),
      ...(this.cfg.permissionMode ? { permissionMode: this.cfg.permissionMode } : {}),
      ...(withResume && this.cfg.resumeId ? { resume: this.cfg.resumeId } : {}),
      ...(this.cfg.extraOptions ?? {}),
    };
  }

  send(text: string): void {
    this.lastUsedAt = new Date();
    if (!this.started) this.start();
    const m: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    this.queue.push(m);
    if (this.trackingPending) this.pending.push(m);
  }

  async interrupt(): Promise<void> {
    if (this.q) await this.q.interrupt();
  }

  async close(timeoutMs = 5000): Promise<void> {
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
      if (action === 'recovered') {
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
        for (const ev of translateSdkMessage(msg)) {
          if (ev.kind === 'init' && !this.sessionId) this.sessionId = ev.sessionId;
          // stale-resume 拦截：原会话上下文已不存在。不转发该错误 result，直接退出
          // for-await（自动触发旧 query .return() 干净中断），交由 runLoop 重建为新会话。
          if (
            ev.kind === 'result' &&
            ev.ok === false &&
            ev.detail?.errors?.some((e) => e.includes('No conversation found with session ID')) &&
            this.cfg.resumeId &&
            !this.resumeRecovered
          ) {
            return 'recovered';
          }
          this.lastUsedAt = new Date();
          // 当前 query 产出成功 result：resume 已验证有效，停止追踪并清空重放缓冲。
          if (ev.kind === 'result' && ev.ok) {
            this.trackingPending = false;
            this.pending = [];
          }
          await this.cfg.onEvent?.(ev);
        }
      }
      return 'done';
    } catch (err) {
      // 部分情况下 stale-resume 不以 result 形式出现，而是 SDK 直接抛错。
      if (
        this.cfg.resumeId &&
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
    this.trackingPending = false;
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

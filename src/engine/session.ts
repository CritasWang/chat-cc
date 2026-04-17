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
  private readonly queue = new MessageQueue();
  private q?: Query;
  private pumpPromise?: Promise<void>;
  private started = false;
  createdAt = new Date();
  lastUsedAt = new Date();

  constructor(private readonly cfg: SessionConfig) {
    this.threadKey = cfg.threadKey;
    if (cfg.resumeId) this.sessionId = cfg.resumeId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const options: Options = {
      cwd: this.cfg.cwd,
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
      ...(this.cfg.allowedTools ? { allowedTools: this.cfg.allowedTools } : {}),
      ...(this.cfg.disallowedTools ? { disallowedTools: this.cfg.disallowedTools } : {}),
      ...(this.cfg.permissionMode ? { permissionMode: this.cfg.permissionMode } : {}),
      ...(this.cfg.resumeId ? { resume: this.cfg.resumeId } : {}),
      ...(this.cfg.extraOptions ?? {}),
    };

    this.q = query({ prompt: this.queue.stream(), options });
    this.pumpPromise = this.pump().catch((err) => {
      log().error({ err, thread: this.threadKey }, 'session pump 异常退出');
      void this.cfg.onEvent?.({ kind: 'error', message: String(err) });
    });
  }

  send(text: string): void {
    this.lastUsedAt = new Date();
    if (!this.started) this.start();
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
    if (this.q) await this.q.interrupt();
  }

  async close(): Promise<void> {
    this.queue.close();
    if (this.q) this.q.close();
    if (this.pumpPromise) await this.pumpPromise;
  }

  private async pump(): Promise<void> {
    if (!this.q) return;
    for await (const msg of this.q) {
      for (const ev of translateSdkMessage(msg)) {
        if (ev.kind === 'init' && !this.sessionId) this.sessionId = ev.sessionId;
        this.lastUsedAt = new Date();
        await this.cfg.onEvent?.(ev);
      }
    }
  }
}

import { log } from '../logger.js';

/**
 * per-scope 消息静默窗口队列（借鉴 lark-bridge bot/pending-queue.ts）。
 *
 * 行为：
 * - push() 后启动/重置静默计时器；窗口内的连续消息合并为一批
 * - block()：agent 运行期间暂停该 scope 的 flush，消息继续累积
 * - unblock()：运行结束后重新武装计时器，把运行期间攒下的消息一次性带出
 *
 * 净效果：同一会话同时最多一个 run 在跑；run 期间发来的所有消息
 * 合并成下一批（run 结束后再静默 quietMs 才 flush）。
 */

interface PendingEntry {
  messages: string[];
  timer?: NodeJS.Timeout;
}

export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly blockTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly quietMs: number,
    private readonly onFlush: (scope: string, messages: string[]) => void,
    /** block 的最长时长（防 run 挂死后 scope 永久静默）；<=0 不设上限 */
    private readonly maxBlockMs: number = 60 * 60_000,
  ) {}

  push(scope: string, text: string): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(text);
      if (!this.blocked.has(scope)) existing.timer = this.armTimer(scope);
      return existing.messages.length;
    }
    const entry: PendingEntry = { messages: [text] };
    if (!this.blocked.has(scope)) entry.timer = this.armTimer(scope);
    this.map.set(scope, entry);
    return 1;
  }

  /** 暂停 flush（run 启动时调用），消息继续累积 */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (this.maxBlockMs > 0) {
      const guard = setTimeout(() => {
        log().warn({ scope, maxBlockMs: this.maxBlockMs }, 'pending-queue block 超时，强制解锁');
        this.unblock(scope);
      }, this.maxBlockMs);
      guard.unref?.();
      this.blockTimers.set(scope, guard);
    }
  }

  /** 恢复 flush（run 结束时调用）；若期间有积压则重新武装静默计时器 */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const guard = this.blockTimers.get(scope);
    if (guard) {
      clearTimeout(guard);
      this.blockTimers.delete(scope);
    }
    const entry = this.map.get(scope);
    if (!entry || entry.messages.length === 0) return;
    entry.timer = this.armTimer(scope);
  }

  isBlocked(scope: string): boolean {
    return this.blocked.has(scope);
  }

  pendingCount(scope: string): number {
    return this.map.get(scope)?.messages.length ?? 0;
  }

  private armTimer(scope: string): NodeJS.Timeout {
    const t = setTimeout(() => this.flush(scope), this.quietMs);
    t.unref?.();
    return t;
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry || entry.messages.length === 0) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log().error({ err, scope }, 'pending-queue flush 回调异常');
    }
  }
}

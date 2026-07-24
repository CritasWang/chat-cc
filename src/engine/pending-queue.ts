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
  chars: number;
  /** 当前批次连续 flush 失败次数；新消息并入时不重置，避免持久故障无限重试。 */
  failures: number;
  /** 本批消息的发送者，按首次出现顺序去重；用于把审批/提问绑定到实际运行批次。 */
  requesterIds: string[];
  timer?: NodeJS.Timeout;
}

export interface PendingQueueOptions {
  maxMessages?: number;
  maxChars?: number;
  /** 首次 flush 失败后最多重试几次；默认 3。 */
  maxFlushRetries?: number;
  /** flush 重试退避基数；默认 max(quietMs, 250ms)。 */
  retryBaseMs?: number;
  /** 重试耗尽后的通知钩子。 */
  onDiscard?: (
    scope: string,
    messages: string[],
    requesterIds: string[],
    err: unknown,
  ) => void | Promise<void>;
}

export class PendingQueueCapacityError extends Error {
  constructor(readonly reason: 'messages' | 'chars') {
    super(reason === 'messages' ? 'pending message limit exceeded' : 'pending character limit exceeded');
    this.name = 'PendingQueueCapacityError';
  }
}

export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly blockTimers = new Map<string, NodeJS.Timeout>();
  /** 仅保存仍在执行的 flush token；clear() 删除 token 即可使迟发失败失效，不留永久 epoch。 */
  private readonly inFlight = new Map<string, Set<symbol>>();

  constructor(
    private readonly quietMs: number,
    private readonly onFlush: (
      scope: string,
      messages: string[],
      requesterIds: string[],
    ) => void | Promise<void>,
    /** block 的最长时长（防 run 挂死后 scope 永久静默）；<=0 不设上限 */
    private readonly maxBlockMs: number = 60 * 60_000,
    private readonly options: PendingQueueOptions = {},
  ) {}

  push(scope: string, text: string, requesterId?: string): number {
    const existing = this.map.get(scope);
    if (existing) {
      this.assertCapacity(existing.messages.length + 1, existing.chars + text.length);
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(text);
      existing.chars += text.length;
      appendUnique(existing.requesterIds, requesterId);
      if (!this.blocked.has(scope)) existing.timer = this.armTimer(scope);
      return existing.messages.length;
    }
    this.assertCapacity(1, text.length);
    const entry: PendingEntry = {
      messages: [text],
      chars: text.length,
      failures: 0,
      requesterIds: requesterId ? [requesterId] : [],
    };
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

  /** 明确丢弃某 scope 的积压（/clear、/cd、彻底销毁会话时使用）。 */
  clear(scope: string): void {
    const entry = this.map.get(scope);
    if (entry?.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    // 删除当前 token 集合，使已经进入 onFlush 的异步回调即使稍后失败，也不能复活旧消息。
    this.inFlight.delete(scope);
    this.releaseBlock(scope);
  }

  private armTimer(scope: string, delayMs = this.quietMs): NodeJS.Timeout {
    const t = setTimeout(() => this.flush(scope), Math.max(0, delayMs));
    t.unref?.();
    return t;
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry || entry.messages.length === 0) return;
    this.map.delete(scope);
    const token = this.registerFlush(scope);
    try {
      const result = this.onFlush(scope, entry.messages, entry.requesterIds);
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).then(
          () => this.finishFlush(scope, token),
          (err) => this.restoreFailedFlush(scope, entry, token, err),
        );
      } else {
        this.finishFlush(scope, token);
      }
    } catch (err) {
      this.restoreFailedFlush(scope, entry, token, err);
    }
  }

  private restoreFailedFlush(
    scope: string,
    failed: PendingEntry,
    token: symbol,
    err: unknown,
  ): void {
    // flush 后若用户执行了 /clear、/cd 或 destroy，旧回调即使稍后失败也不能复活旧消息。
    if (!this.finishFlush(scope, token)) {
      log().warn({ err, scope, count: failed.messages.length }, 'pending-queue flush 失败，但 scope 已清空，丢弃旧批次');
      return;
    }

    const failures = failed.failures + 1;
    const newer = this.map.get(scope);
    if (newer?.timer) clearTimeout(newer.timer);

    const maxRetries = Math.max(0, this.options.maxFlushRetries ?? 3);
    if (failures > maxRetries) {
      log().error(
        { err, scope, count: failed.messages.length, failures, maxRetries },
        'pending-queue flush 重试耗尽，丢弃失败批次',
      );
      this.releaseBlock(scope);
      if (newer && newer.messages.length > 0) newer.timer = this.armTimer(scope);
      try {
        const notified = this.options.onDiscard?.(
          scope,
          failed.messages,
          failed.requesterIds,
          err,
        );
        if (notified && typeof notified.then === 'function') {
          void notified.catch((notifyErr) =>
            log().warn({ err: notifyErr, scope }, 'pending-queue 丢弃通知失败'),
          );
        }
      } catch (notifyErr) {
        log().warn({ err: notifyErr, scope }, 'pending-queue 丢弃通知异常');
      }
      return;
    }

    log().error(
      { err, scope, count: failed.messages.length, failures, maxRetries },
      'pending-queue flush 回调异常，消息已回队',
    );
    const entry: PendingEntry = newer
      ? {
          messages: [...failed.messages, ...newer.messages],
          chars: failed.chars + newer.chars,
          failures,
          requesterIds: mergeUnique(failed.requesterIds, newer.requesterIds),
        }
      : {
          messages: [...failed.messages],
          chars: failed.chars,
          failures,
          requesterIds: [...failed.requesterIds],
        };
    const dropped = this.trimToCapacity(entry);
    if (dropped > 0) {
      log().warn({ scope, dropped }, 'pending-queue 回队超过容量，已丢弃最新消息');
    }
    this.map.set(scope, entry);
    this.releaseBlock(scope);
    const baseMs = Math.max(1, this.options.retryBaseMs ?? Math.max(this.quietMs, 250));
    const retryMs = Math.min(30_000, baseMs * 2 ** Math.max(0, failures - 1));
    entry.timer = this.armTimer(scope, retryMs);
  }

  private releaseBlock(scope: string): void {
    this.blocked.delete(scope);
    const guard = this.blockTimers.get(scope);
    if (guard) clearTimeout(guard);
    this.blockTimers.delete(scope);
  }

  private registerFlush(scope: string): symbol {
    const token = Symbol(scope);
    const tokens = this.inFlight.get(scope) ?? new Set<symbol>();
    tokens.add(token);
    this.inFlight.set(scope, tokens);
    return token;
  }

  /** 返回 token 是否仍有效；无论结果如何都会从 inFlight 中移除。 */
  private finishFlush(scope: string, token: symbol): boolean {
    const tokens = this.inFlight.get(scope);
    if (!tokens || !tokens.delete(token)) return false;
    if (tokens.size === 0) this.inFlight.delete(scope);
    return true;
  }

  private assertCapacity(messages: number, chars: number): void {
    if (this.options.maxMessages !== undefined && messages > this.options.maxMessages) {
      throw new PendingQueueCapacityError('messages');
    }
    if (this.options.maxChars !== undefined && chars > this.options.maxChars) {
      throw new PendingQueueCapacityError('chars');
    }
  }

  private trimToCapacity(entry: PendingEntry): number {
    let dropped = 0;
    while (
      (this.options.maxMessages !== undefined && entry.messages.length > this.options.maxMessages) ||
      (this.options.maxChars !== undefined && entry.chars > this.options.maxChars)
    ) {
      const removed = entry.messages.pop();
      if (removed === undefined) break;
      entry.chars -= removed.length;
      dropped += 1;
    }
    return dropped;
  }
}

function appendUnique(items: string[], value: string | undefined): void {
  if (value && !items.includes(value)) items.push(value);
}

function mergeUnique(first: string[], second: string[]): string[] {
  const out = [...first];
  for (const value of second) appendUnique(out, value);
  return out;
}

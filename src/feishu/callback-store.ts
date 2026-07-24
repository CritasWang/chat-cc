import { readFileSync, existsSync } from 'node:fs';
import { writeFileAtomicSync } from '../platform/atomic-write.js';
import { log } from '../logger.js';

/**
 * 卡片回调防重放（借鉴 lark-bridge callback-store）。
 *
 * 两层防护：
 * 1. **短窗口去重**（内存）— 同一 (messageId + action value) 在 TTL 窗口内
 *    重复触发视为双击/重放，直接吞掉。覆盖「用户连点按钮导致重复执行命令」。
 * 2. **一次性 nonce**（持久化，原子写）— 按钮 value 携带 `nonce` 时，首次
 *    consume 成功、后续永久拒绝；进程重启后仍生效。用于审批等 one-shot 操作。
 */

const DEFAULT_DEDUPE_TTL_MS = 3_000;
/** nonce 持久化上限 — 超过后按插入序淘汰最老的（防无限增长） */
const MAX_PERSISTED_NONCES = 2_000;

export class CallbackStore {
  private readonly recent = new Map<string, number>();
  private readonly nonces = new Set<string>();
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly persistPath?: string,
    private readonly dedupeTtlMs: number = DEFAULT_DEDUPE_TTL_MS,
  ) {
    this.loadPersisted();
  }

  /**
   * 短窗口去重：首次调用返回 true（放行），TTL 内重复返回 false。
   */
  dedupe(key: string, now = Date.now()): boolean {
    // 顺带清理过期项，防 map 无限增长
    for (const [k, t] of this.recent) {
      if (now - t > this.dedupeTtlMs) this.recent.delete(k);
    }
    const last = this.recent.get(key);
    if (last !== undefined && now - last <= this.dedupeTtlMs) return false;
    this.recent.set(key, now);
    return true;
  }

  /**
   * 一次性 nonce：首次 consume 返回 true，之后永久返回 false。
   */
  consume(nonce: string): boolean {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    if (this.nonces.size > MAX_PERSISTED_NONCES) {
      const oldest = this.nonces.values().next().value;
      if (oldest !== undefined) this.nonces.delete(oldest);
    }
    this.schedulePersist();
    return true;
  }

  /** 撤销一个已消费的 nonce（如操作被取消后允许重试） */
  revoke(nonce: string): void {
    if (this.nonces.delete(nonce)) this.schedulePersist();
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.persistPath, 'utf8')) as unknown;
      if (Array.isArray(data)) {
        for (const n of data) {
          if (typeof n === 'string') this.nonces.add(n);
        }
        while (this.nonces.size > MAX_PERSISTED_NONCES) {
          const oldest = this.nonces.values().next().value;
          if (oldest === undefined) break;
          this.nonces.delete(oldest);
        }
      }
    } catch (err) {
      log().warn({ err, path: this.persistPath }, 'callback nonce 持久化文件损坏，忽略');
    }
  }

  private schedulePersist(): void {
    if (!this.persistPath || this.persistTimer) return;
    // 防抖：短时间多次 consume 合并为一次落盘
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      try {
        writeFileAtomicSync(this.persistPath!, JSON.stringify([...this.nonces]));
      } catch (err) {
        log().warn({ err }, 'callback nonce 持久化失败');
      }
    }, 200);
    this.persistTimer.unref?.();
  }
}

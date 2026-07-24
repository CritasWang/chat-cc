import { existsSync, readFileSync } from 'node:fs';
import { log } from '../logger.js';
import { writeFileAtomicSync } from '../platform/atomic-write.js';

/**
 * 入站消息去重收据。
 *
 * 飞书 WS 在 ack 丢失/重连时可能重复投递同一 message_id。这里采用有界、持久化的
 * at-most-once 闸门，避免重复启动 agent、重复执行命令或重复下载媒体。
 */
export class MessageReceiptStore {
  private readonly ids = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly maxEntries = 5_000,
  ) {
    this.load();
  }

  /** 首次接收返回 true；已处理过返回 false。写盘发生在放行之前。 */
  accept(messageId: string): boolean {
    if (!messageId || this.ids.has(messageId)) return false;
    this.ids.add(messageId);
    this.compact();
    this.persist();
    return true;
  }

  /** 后台处理在真正进入 Router 前失败时撤销，允许后续重投再次尝试。 */
  revoke(messageId: string): void {
    if (!this.ids.delete(messageId)) return;
    this.persist();
  }

  private compact(): void {
    while (this.ids.size > this.maxEntries) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return;
      for (const id of raw) {
        if (typeof id === 'string' && id) this.ids.add(id);
      }
      this.compact();
    } catch (err) {
      log().warn({ err, path: this.path }, '消息去重收据损坏，忽略旧数据');
    }
  }

  private persist(): void {
    try {
      writeFileAtomicSync(this.path, JSON.stringify([...this.ids]));
    } catch (err) {
      // 不因本地磁盘异常阻断正常收消息；最坏退化为本进程内去重。
      log().warn({ err, path: this.path }, '消息去重收据写盘失败');
    }
  }
}

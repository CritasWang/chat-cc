import type { Replier } from '../feishu/replier.js';
import type { UsageSnapshot } from './events.js';

/**
 * Monitor — 订阅 LiveStreamer 的 onResult 回调，做额外的"完成后动作"。
 * M3 阶段先只用来支持「结束后推送 cost snippet」的可选开关；M4 会扩展到 approval pending、idle 检测等。
 */
export class Monitor {
  constructor(
    private readonly replier: Replier,
    private readonly notifyChatId: string,
  ) {}

  async onResult(threadKey: string, usage?: UsageSnapshot, durationMs?: number): Promise<void> {
    if (!this.notifyChatId) return;
    if (!usage) return;
    const line = `✓ ${threadKey} · in ${usage.inputTokens} · out ${usage.outputTokens}${durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''}`;
    await this.replier.sendText(this.notifyChatId, line);
  }
}

import type { UsageSnapshot } from './events.js';

/**
 * 简单的 token/cost 聚合器。按 threadKey 维度累加，提供全局与每 thread 的快照。
 * 估算价格按 Claude Sonnet 4.5 的公开挂牌价做默认回退（USD / 1M tokens）。
 */
const DEFAULT_PRICE = {
  inputPerM: 3.0,
  outputPerM: 15.0,
  cacheReadPerM: 0.3,
  cacheCreationPerM: 3.75,
};

export class CostAggregator {
  private readonly per = new Map<string, UsageSnapshot>();

  add(threadKey: string, u: UsageSnapshot): void {
    const cur = this.per.get(threadKey) ?? zero();
    this.per.set(threadKey, addUsage(cur, u));
  }

  get(threadKey: string): UsageSnapshot {
    return this.per.get(threadKey) ?? zero();
  }

  total(): UsageSnapshot {
    let acc = zero();
    for (const v of this.per.values()) acc = addUsage(acc, v);
    return acc;
  }

  entries(): Array<{ threadKey: string; usage: UsageSnapshot }> {
    return [...this.per.entries()].map(([threadKey, usage]) => ({ threadKey, usage }));
  }

  reset(threadKey?: string): void {
    if (threadKey) this.per.delete(threadKey);
    else this.per.clear();
  }

  estimateUsd(u: UsageSnapshot): number {
    const p = DEFAULT_PRICE;
    return (
      (u.inputTokens / 1_000_000) * p.inputPerM +
      (u.outputTokens / 1_000_000) * p.outputPerM +
      (u.cacheReadTokens / 1_000_000) * p.cacheReadPerM +
      (u.cacheCreationTokens / 1_000_000) * p.cacheCreationPerM
    );
  }
}

function zero(): UsageSnapshot {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function addUsage(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  const out: UsageSnapshot = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
  if (b.model) out.model = b.model;
  else if (a.model) out.model = a.model;
  return out;
}

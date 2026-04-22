import { renderCostCard } from '../feishu/cards/cost.js';
import type { CommandFn } from './types.js';

export function makeUsageCommand(deps: {
  getReport: () => Promise<{ totals: import('../engine/events.js').UsageSnapshot; byThread: Array<{ threadKey: string; usage: import('../engine/events.js').UsageSnapshot }>; estimatedUsd: number }>;
}): CommandFn {
  return async (_args, meta, { replier }) => {
    const report = await deps.getReport();
    await replier.replyCard(meta.messageId, renderCostCard(report));
    return;
  };
}

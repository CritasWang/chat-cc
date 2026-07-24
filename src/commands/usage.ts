import { renderCostCard } from '../feishu/cards/cost.js';
import type { CommandFn } from './types.js';
import { replyOptions, type MessageMeta } from '../feishu/router.js';

export function makeUsageCommand(deps: {
  getReport: (meta: MessageMeta) => Promise<{
    totals: import('../engine/events.js').UsageSnapshot;
    byThread: Array<{ threadKey: string; usage: import('../engine/events.js').UsageSnapshot }>;
    actualUsd?: number;
    estimatedUsd: number;
  }>;
}): CommandFn {
  return async (_args, meta, { replier }) => {
    const report = await deps.getReport(meta);
    await replier.replyCard(meta.messageId, renderCostCard(report), replyOptions(meta));
    return;
  };
}

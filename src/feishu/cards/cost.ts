import type { UsageSnapshot } from '../../engine/events.js';
import type { InteractiveCard } from '../replier.js';
import { card, cardHeader, hr, md } from './base.js';

export interface CostReport {
  totals: UsageSnapshot;
  byThread: Array<{ threadKey: string; usage: UsageSnapshot }>;
  actualUsd?: number;
  estimatedUsd?: number;
}

export function renderCostCard(r: CostReport): InteractiveCard {
  const elems: unknown[] = [];
  const t = r.totals;
  elems.push(
    md(
      `**总计**\n` +
        `- input: \`${fmt(t.inputTokens)}\`\n` +
        `- output: \`${fmt(t.outputTokens)}\`\n` +
        `- cache read: \`${fmt(t.cacheReadTokens)}\`\n` +
        `- cache create: \`${fmt(t.cacheCreationTokens)}\`` +
        (r.actualUsd !== undefined ? `\n- SDK 实报（有数据轮次）: \`$${r.actualUsd.toFixed(4)}\`` : '') +
        (r.estimatedUsd !== undefined ? `\n- Token 估算: \`$${r.estimatedUsd.toFixed(4)}\`` : ''),
    ),
  );

  if (r.byThread.length > 0) {
    elems.push(hr());
    const shown = r.byThread.slice(0, 30);
    const lines = shown.map(
      (t) =>
        `• \`${t.threadKey}\` — in ${fmt(t.usage.inputTokens)} · out ${fmt(t.usage.outputTokens)} · cache-r ${fmt(t.usage.cacheReadTokens)}`,
    );
    if (r.byThread.length > shown.length) lines.push(`…另有 ${r.byThread.length - shown.length} 个会话未展开`);
    elems.push(md('**按会话**\n' + lines.join('\n')));
  }

  return card(cardHeader('💰 Token / Cost', 'purple'), elems);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

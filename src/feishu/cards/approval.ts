import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, hr, md } from './base.js';

export interface ApprovalCardSpec {
  requestId: string;
  toolName: string;
  toolInputPreview: string;
  threadKey: string;
}

export function renderApprovalCard(s: ApprovalCardSpec): InteractiveCard {
  return card(cardHeader('🔐 工具审批', 'orange'), [
    md(`会话 \`${s.threadKey}\` 请求调用工具：\n**${s.toolName}**`),
    hr(),
    md('```\n' + s.toolInputPreview + '\n```'),
    btnRow([
      {
        label: '✅ 允许',
        value: { cmd: '__approve', args: s.requestId, decision: 'allow' },
        style: 'primary',
      },
      {
        label: '❌ 拒绝',
        value: { cmd: '__approve', args: s.requestId, decision: 'deny' },
        style: 'danger',
      },
    ]),
  ]);
}

export function renderApprovalResolved(s: ApprovalCardSpec, decision: 'allow' | 'deny'): InteractiveCard {
  return card(
    cardHeader(
      decision === 'allow' ? '✅ 已允许' : '❌ 已拒绝',
      decision === 'allow' ? 'green' : 'grey',
    ),
    [md(`${s.toolName} · ${s.threadKey}`)],
  );
}

import type { InteractiveCard } from '../replier.js';
import { buttonRow, card, divider, header, markdown } from './base.js';

export interface ApprovalCardSpec {
  requestId: string;
  toolName: string;
  toolInputPreview: string;
  threadKey: string;
}

export function renderApprovalCard(s: ApprovalCardSpec): InteractiveCard {
  return card(header('🔐 工具审批', 'orange'), [
    markdown(`会话 \`${s.threadKey}\` 请求调用工具：\n**${s.toolName}**`),
    divider(),
    markdown('```\n' + s.toolInputPreview + '\n```'),
    buttonRow([
      {
        text: '✅ 允许',
        value: { cmd: '__approve', args: s.requestId, decision: 'allow' },
        type: 'primary',
      },
      {
        text: '❌ 拒绝',
        value: { cmd: '__approve', args: s.requestId, decision: 'deny' },
        type: 'danger',
      },
    ]),
  ]);
}

export function renderApprovalResolved(s: ApprovalCardSpec, decision: 'allow' | 'deny'): InteractiveCard {
  return card(
    header(
      decision === 'allow' ? '✅ 已允许' : '❌ 已拒绝',
      decision === 'allow' ? 'green' : 'grey',
    ),
    [markdown(`${s.toolName} · ${s.threadKey}`)],
  );
}

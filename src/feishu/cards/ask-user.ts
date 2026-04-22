import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, hr, md, type BtnSpec } from './base.js';

export interface AskQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export function renderAskUserCard(
  _threadKey: string,
  questions: AskQuestion[],
): InteractiveCard {
  const elements: unknown[] = [];

  for (const q of questions) {
    elements.push(md(`**${q.question}**`));
    if (q.options.length > 0) {
      const buttons: BtnSpec[] = q.options.map((opt, i) => ({
        label: opt.label,
        style: i === 0 ? 'primary' : 'default',
        value: { cmd: 's', args: opt.label },
      }));
      // 每行 2 个按钮
      for (let i = 0; i < buttons.length; i += 2) {
        elements.push(btnRow(buttons.slice(i, i + 2)));
      }
      if (q.options.some((o) => o.description)) {
        const desc = q.options
          .filter((o) => o.description)
          .map((o) => `• **${o.label}** — ${o.description}`)
          .join('\n');
        elements.push(md(desc));
      }
    }
    elements.push(hr());
  }

  elements.push(md('*点击按钮或直接发消息回答*'));

  return card(cardHeader('❓ Claude 提问', 'wathet'), elements);
}

export function parseAskUserInput(input: unknown): AskQuestion[] {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return [];
  const rawQuestions = inp['questions'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rawQuestions)) return [];

  return rawQuestions.map((q) => ({
    question: String(q['question'] ?? ''),
    multiSelect: Boolean(q['multiSelect']),
    options: Array.isArray(q['options'])
      ? (q['options'] as Array<Record<string, unknown>>).map((o) => ({
          label: String(o['label'] ?? ''),
          description: typeof o['description'] === 'string' ? o['description'] : undefined,
        }))
      : [],
  }));
}

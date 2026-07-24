import type { InteractiveCard } from '../replier.js';
import { card, cardHeader, hr, md, plainText } from './base.js';

export interface AskQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 提问卡片的可变状态：随用户点选原地 PATCH 更新 */
export interface AskCardState {
  threadKey: string;
  requesterId: string;
  chatId: string;
  generation: number;
  expiresAt: number;
  questions: AskQuestion[];
  /** 每题已选项索引集合（单选题至多一个元素） */
  selections: number[][];
  submitted: boolean;
}

export function initialAskState(
  threadKey: string,
  questions: AskQuestion[],
  context: { requesterId?: string; chatId?: string; generation?: number; ttlMs?: number } = {},
): AskCardState {
  return {
    threadKey,
    requesterId: context.requesterId ?? '',
    chatId: context.chatId ?? '',
    generation: context.generation ?? 0,
    expiresAt: Date.now() + (context.ttlMs ?? 10 * 60_000),
    questions,
    selections: questions.map(() => []),
    submitted: false,
  };
}

export function answeredCount(state: AskCardState): number {
  return state.selections.filter((s) => s.length > 0).length;
}

export function allAnswered(state: AskCardState): boolean {
  return answeredCount(state) === state.questions.length;
}

/** 汇总答案为一条回复消息（多题带题干；未作答的题跳过） */
export function composeAnswer(state: AskCardState): string {
  const parts = state.questions
    .map((q, i) => {
      const labels = state.selections[i]!.map((oi) => q.options[oi]?.label ?? '').filter(Boolean);
      return { question: q.question, answer: labels.join('、') };
    })
    .filter((p) => p.answer);
  if (state.questions.length === 1) return parts[0]?.answer ?? '';
  return parts.map((p) => `${p.question}：${p.answer}`).join('\n');
}

/**
 * 提问按钮回调 value 约定：
 *   { cmd: '__ask', args: `${qIdx}:${optIdx}` }  选择/切换某选项
 *   { cmd: '__ask', args: 'submit' }             多选场景手动提交
 * messageId 由回调事件自带，用于定位卡片状态。
 */
function askBtn(label: string, args: string, selected: boolean): Record<string, unknown> {
  return {
    tag: 'button',
    text: plainText(selected ? `✅ ${label}` : label),
    type: selected ? 'primary_filled' : 'default',
    size: 'medium',
    width: 'default',
    behaviors: [{ type: 'callback', value: { cmd: '__ask', args } }],
  };
}

function btnGrid(buttons: Record<string, unknown>[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push({
      tag: 'column_set',
      flex_mode: 'wrap',
      horizontal_spacing: '8px',
      columns: buttons.slice(i, i + 2).map((b) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [b],
      })),
    });
  }
  return rows;
}

export function renderAskUserCard(state: AskCardState): InteractiveCard {
  const elements: unknown[] = [];
  const total = state.questions.length;
  const multi = total > 1;
  const hasMultiSelect = state.questions.some((q) => q.multiSelect);

  state.questions.forEach((q, qi) => {
    const chosen = new Set(state.selections[qi]);
    const numbered = multi ? `${qi + 1}. ` : '';
    const tag = q.multiSelect ? '（可多选）' : '';
    const done = chosen.size > 0 ? ' ✅' : '';
    elements.push(md(`**${numbered}${q.question}**${tag}${done}`));

    if (state.submitted) {
      // 终态：只展示选中项，不再有按钮
      const labels = [...chosen].map((oi) => q.options[oi]?.label ?? '').filter(Boolean);
      elements.push(md(`→ ${labels.join('、') || '（未选择）'}`));
    } else if (q.options.length > 0) {
      elements.push(
        ...btnGrid(q.options.map((opt, oi) => askBtn(opt.label, `${qi}:${oi}`, chosen.has(oi)))),
      );
      if (q.options.some((o) => o.description)) {
        const desc = q.options
          .filter((o) => o.description)
          .map((o) => `• **${o.label}** — ${o.description}`)
          .join('\n');
        elements.push(md(desc));
      }
    }
    elements.push(hr());
  });

  if (state.submitted) {
    elements.push(md('*✅ 已提交给 Claude，等待回复…*'));
  } else {
    const answered = answeredCount(state);
    // 统一显式提交：选完点「提交回答」才发送，提交前可任意改选
    elements.push(
      ...btnGrid([
        {
          tag: 'button',
          text: plainText(total > 1 ? `📨 提交回答（已答 ${answered}/${total}）` : '📨 提交回答'),
          type: 'primary',
          size: 'medium',
          width: 'default',
          behaviors: [{ type: 'callback', value: { cmd: '__ask', args: 'submit' } }],
        },
      ]),
    );
    const hint = hasMultiSelect ? '点选可切换（多选题） · ' : '点选可换选 · ';
    elements.push(md(`*${hint}选好后点「提交回答」发送 · 也可直接发消息回答*`));
  }

  return card(
    cardHeader(
      state.submitted ? '✅ 已回答 Claude 的提问' : `❓ Claude 提问${multi ? `（${total} 题）` : ''}`,
      state.submitted ? 'green' : 'wathet',
    ),
    elements,
  );
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

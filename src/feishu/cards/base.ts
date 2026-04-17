import type { InteractiveCard } from '../replier.js';

export type CardColor =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey'
  | 'default';

export function plainText(text: string): Record<string, unknown> {
  return { tag: 'plain_text', content: text };
}

export function md(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

export function hr(): Record<string, unknown> {
  return { tag: 'hr' };
}

export interface BtnSpec {
  label: string;
  style?: 'default' | 'primary' | 'danger' | 'primary_filled';
  value: Record<string, unknown>;
}

function btn(spec: BtnSpec): Record<string, unknown> {
  return {
    tag: 'button',
    text: plainText(spec.label),
    type: spec.style ?? 'default',
    size: 'medium',
    width: 'default',
    behaviors: [{ type: 'callback', value: spec.value }],
  };
}

/** schema 2.0 按钮行：用 column_set（action 标签已弃用） */
export function btnRow(buttons: BtnSpec[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'wrap',
    horizontal_spacing: '8px',
    columns: buttons.map((b) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [btn(b)],
    })),
  };
}

/** 快捷：命令按钮 { cmd, args } */
export function cmdBtn(
  label: string,
  cmd: string,
  args: string,
  style?: BtnSpec['style'],
): BtnSpec {
  return { label, style, value: { cmd, args } };
}

/** 快捷：命令按钮 + refresh 原地刷新 */
export function cmdBtnRefresh(
  label: string,
  cmd: string,
  args: string,
  refresh: string,
  style?: BtnSpec['style'],
): BtnSpec {
  return { label, style, value: { cmd, args, refresh } };
}

/** 快捷：纯 toast 按钮 */
export function toastBtn(label: string, toast: string, style?: BtnSpec['style']): BtnSpec {
  return { label, style, value: { echo: toast, silent: true } };
}

export function cardHeader(title: string, color: CardColor = 'blue'): Record<string, unknown> {
  return {
    title: plainText(title),
    template: color,
  };
}

export function card(h: Record<string, unknown>, elements: unknown[]): InteractiveCard {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: h,
    body: { elements },
  };
}

/** 把纯文本包装成一张简单卡片 */
export function textCard(text: string, title = 'ChatCC', color: CardColor = 'blue'): InteractiveCard {
  return card(cardHeader(title, color), [md(text)]);
}

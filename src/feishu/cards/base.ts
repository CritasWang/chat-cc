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

export function markdown(text: string): Record<string, unknown> {
  return { tag: 'markdown', content: text };
}

export function divider(): Record<string, unknown> {
  return { tag: 'hr' };
}

export interface ButtonSpec {
  text: string;
  type?: 'primary' | 'default' | 'danger';
  value: Record<string, unknown>;
}

export function buttonRow(buttons: ButtonSpec[]): Record<string, unknown> {
  return {
    tag: 'action',
    actions: buttons.map((b) => ({
      tag: 'button',
      text: plainText(b.text),
      type: b.type ?? 'default',
      value: b.value,
    })),
  };
}

export function header(title: string, color: CardColor = 'blue'): Record<string, unknown> {
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
    elements,
  };
}

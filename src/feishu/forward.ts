import type * as Lark from '@larksuiteoapi/node-sdk';
import { log } from '../logger.js';

/**
 * 合并转发消息解析（借鉴 lark-bridge bot/quote.ts）。
 *
 * 飞书 merge_forward 消息本体没有文本内容，需要用 im.v1.message.get
 * 取回**原始消息项列表**（父消息 + 全部子消息），再拼装成对 agent
 * 友好的聊天记录文本。interactive 卡片在 SDK 侧只是占位符，
 * 这里解析原始卡片 JSON 提取可读文本。
 */

interface ApiMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  sender?: { id?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: Array<{ id?: string; name?: string; key?: string }>;
}

const MAX_ITEMS = 50;
const MAX_TEXT_PER_ITEM = 2000;

export async function fetchForwardTranscript(
  client: Lark.Client,
  messageId: string,
): Promise<string | undefined> {
  let items: ApiMessageItem[];
  try {
    const resp = await client.im.v1.message.get({ path: { message_id: messageId } });
    items = ((resp.data as { items?: ApiMessageItem[] } | undefined)?.items ?? []) as ApiMessageItem[];
  } catch (err) {
    log().warn({ err, messageId }, '合并转发消息拉取失败');
    return undefined;
  }
  if (items.length === 0) return undefined;

  // 子消息 = 除父消息外的全部，按时间排序
  const children = items
    .filter((i) => i.message_id !== messageId)
    .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0))
    .slice(0, MAX_ITEMS);
  if (children.length === 0) return undefined;

  const lines: string[] = [];
  for (const item of children) {
    const who = senderLabel(item);
    const text = renderItem(item);
    lines.push(`${who}: ${text}`);
  }
  return lines.join('\n');
}

function senderLabel(item: ApiMessageItem): string {
  const name = item.mentions?.find((m) => m.id === item.sender?.id)?.name;
  if (name) return name;
  const id = item.sender?.id ?? '';
  // open_id 太长，取尾部片段做区分
  return id ? `用户(…${id.slice(-6)})` : '未知发送者';
}

function renderItem(item: ApiMessageItem): string {
  const raw = item.body?.content ?? '';
  switch (item.msg_type) {
    case 'text':
      return truncate(parseJson(raw)?.['text'] as string | undefined ?? raw);
    case 'post':
      return truncate(renderPost(raw));
    case 'interactive':
      return truncate(renderInteractive(raw));
    case 'image':
      return '[图片]';
    case 'file':
      return '[文件]';
    case 'audio':
      return '[语音]';
    case 'media':
      return '[视频]';
    case 'sticker':
      return '[表情]';
    case 'merge_forward':
      return '[嵌套的合并转发记录]';
    default:
      return `[${item.msg_type ?? '未知类型'}消息]`;
  }
}

/** 富文本(post)：递归提取 text/a/at 节点的文本 */
function renderPost(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return raw;
  const out: string[] = [];
  const title = parsed['title'];
  if (typeof title === 'string' && title) out.push(title);
  const content = parsed['content'];
  if (Array.isArray(content)) {
    for (const para of content) {
      if (!Array.isArray(para)) continue;
      const line = para
        .map((node: Record<string, unknown>) => {
          const tag = node['tag'];
          if (tag === 'text') return String(node['text'] ?? '');
          if (tag === 'a') return `${node['text'] ?? ''}(${node['href'] ?? ''})`;
          if (tag === 'at') return `@${node['user_name'] ?? node['user_id'] ?? ''}`;
          if (tag === 'img') return '[图片]';
          return '';
        })
        .join('');
      if (line) out.push(line);
    }
  }
  return out.join('\n') || raw;
}

/** interactive 卡片：递归收集 JSON 中所有 content/text 字段 */
function renderInteractive(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return '[卡片]';
  const texts: string[] = [];
  collectTexts(parsed, texts);
  return texts.length > 0 ? `[卡片] ${texts.join(' | ')}` : '[卡片]';
}

function collectTexts(obj: unknown, out: string[]): void {
  if (out.length > 30) return;
  if (Array.isArray(obj)) {
    for (const x of obj) collectTexts(x, out);
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  const rec = obj as Record<string, unknown>;
  for (const key of ['content', 'text']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() && !v.startsWith('{')) out.push(v.trim());
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') collectTexts(v, out);
  }
}

function parseJson(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function truncate(s: string | undefined): string {
  if (!s) return '';
  return s.length > MAX_TEXT_PER_ITEM ? s.slice(0, MAX_TEXT_PER_ITEM) + '…（截断）' : s;
}

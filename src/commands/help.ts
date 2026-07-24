import type { CommandFn } from './types.js';
import { renderHelpCard } from '../feishu/cards/help.js';

/**
 * /help [--pin] — 命令手册卡片（含常用操作按钮，兼作命令面板）。
 * `--pin`：发送到群并置顶，常驻群顶部随时点按钮。
 */
export const helpCommand: CommandFn = async (args, meta, { replier }) => {
  const wantPin = /(^|\s)--pin(\s|$)/.test(args) || args.trim() === 'pin';
  if (!wantPin) {
    await replier.replyCard(meta.messageId, renderHelpCard());
    return;
  }
  const mid = await replier.sendCard(meta.chatId, renderHelpCard());
  if (!mid) return '❌ 发送失败';
  const pinned = await replier.pinMessage(mid);
  return pinned ? undefined : '（已发送，但置顶失败 — 可能缺 im:pin 权限，可手动 Pin）';
};

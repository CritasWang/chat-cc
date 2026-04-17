import type { CommandFn } from './types.js';
import { renderHelpCard } from '../feishu/cards/help.js';

export const helpCommand: CommandFn = async (_args, meta, { replier }) => {
  await replier.replyCard(meta.messageId, renderHelpCard());
  return;
};

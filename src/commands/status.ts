import type { CommandFn } from './types.js';
import { renderStatusCard } from '../feishu/cards/status.js';

export const statusCommand: CommandFn = async (_args, meta, { cfg, pool, replier }) => {
  await replier.replyCard(meta.messageId, renderStatusCard(cfg, pool));
  return;
};

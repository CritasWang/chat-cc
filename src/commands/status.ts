import type { CommandFn } from './types.js';
import { renderStatusCard } from '../feishu/cards/status.js';
import { parseThreadKey } from '../engine/pool.js';

export const statusCommand: CommandFn = async (_args, meta, { cfg, pool, replier, configPath, apiProfiles, chatNames }) => {
  const cur = apiProfiles?.current();
  const chatIds = pool.list().map((s) => parseThreadKey(s.threadKey).chatId);
  const names = await chatNames?.resolveAll(chatIds);
  await replier.replyCard(
    meta.messageId,
    renderStatusCard(cfg, pool, configPath, cur ? { name: cur.name, baseUrl: cur.baseUrl } : undefined, names),
  );
  return;
};

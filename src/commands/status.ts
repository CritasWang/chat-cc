import type { CommandFn } from './types.js';
import { MAX_STATUS_SESSIONS, renderStatusCard } from '../feishu/cards/status.js';
import { parseThreadKey } from '../engine/pool.js';
import { listAccessibleSessions } from './session-context.js';
import { effectiveModelOf } from './model-context.js';
import { isPrivileged } from '../policy/owner.js';
import { replyOptions } from '../feishu/router.js';

export const statusCommand: CommandFn = async (_args, meta, { cfg, pool, replier, configPath, apiProfiles, chatNames }) => {
  const cur = isPrivileged(cfg, meta.senderId) ? apiProfiles?.current() : undefined;
  const sessions = listAccessibleSessions(meta, pool);
  const chatIds = sessions
    .slice(0, MAX_STATUS_SESSIONS)
    .map((s) => parseThreadKey(s.threadKey).chatId);
  const names = await chatNames?.resolveAll(chatIds);
  await replier.replyCard(
    meta.messageId,
    renderStatusCard(
      cfg,
      pool,
      configPath,
      cur
        ? {
            name: cur.name,
            baseUrl: cur.baseUrl,
            ...(cur.model ? { model: cur.model } : {}),
            ...(cur.smallFastModel ? { smallFastModel: cur.smallFastModel } : {}),
          }
        : undefined,
      names,
      sessions,
      (tk) => effectiveModelOf(tk, { cfg, pool, apiProfiles }),
    ),
    replyOptions(meta),
  );
  return;
};

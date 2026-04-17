import type { Config } from '../config.js';
import type { SessionPool } from '../engine/pool.js';
import type { Replier } from '../feishu/replier.js';
import type { MessageMeta } from '../feishu/router.js';

export interface CommandDeps {
  cfg: Config;
  pool: SessionPool;
  replier: Replier;
}

export type CommandFn = (args: string, meta: MessageMeta, deps: CommandDeps) => Promise<string | void>;

export function senderKey(meta: MessageMeta): string {
  return meta.senderId || meta.chatId;
}

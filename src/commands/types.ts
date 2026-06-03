import type { Config } from '../config.js';
import type { SessionPool } from '../engine/pool.js';
import type { ApprovalGate } from '../engine/hooks.js';
import type { LiveStreamer } from '../engine/streamer.js';
import type { Replier } from '../feishu/replier.js';
import type { MessageMeta } from '../feishu/router.js';

export interface CommandDeps {
  cfg: Config;
  pool: SessionPool;
  replier: Replier;
  streamer: LiveStreamer;
  gate: ApprovalGate;
  configPath: string;
}

/** 命令调用的附加上下文（由 router 在特殊路径下传入，普通命令可忽略） */
export interface CommandExtra {
  /** router 在「无活跃会话 → 自动降级到 /ask」时置真，用于提示用户当前为一次性提问 */
  fallbackFromNoSession?: boolean;
}

export type CommandFn = (
  args: string,
  meta: MessageMeta,
  deps: CommandDeps,
  extra?: CommandExtra,
) => Promise<string | void>;

export function senderKey(meta: MessageMeta): string {
  return meta.senderId || meta.chatId;
}

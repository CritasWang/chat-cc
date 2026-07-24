import type { Config } from '../config.js';
import type { SessionPool } from '../engine/pool.js';
import type { ApprovalGate } from '../engine/hooks.js';
import type { LiveStreamer } from '../engine/streamer.js';
import type { PendingQueue } from '../engine/pending-queue.js';
import type { ApiProfileStore } from '../engine/api-profiles.js';
import type { ChatNameCache } from '../feishu/chat-names.js';
import type { Replier } from '../feishu/replier.js';
import type { MessageMeta } from '../feishu/router.js';

export interface CommandDeps {
  cfg: Config;
  pool: SessionPool;
  replier: Replier;
  streamer: LiveStreamer;
  gate: ApprovalGate;
  configPath: string;
  /** 消息静默窗口队列：会话消息统一经此投递（合批 + run 期间排队） */
  pending: PendingQueue;
  /** API profile 切换（可选功能，未配置 cc-profiles.zsh 时为不可用状态） */
  apiProfiles?: ApiProfileStore;
  /** chatId → 群名缓存（状态卡等展示用） */
  chatNames?: ChatNameCache;
  /** 校验配置后请求 daemon 做完整重启，避免局部热更新造成 split-brain。 */
  requestRestart?: () => boolean;
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

/**
 * 活跃会话指针的作用域键：**每个群/单聊独立**（chatId + senderId）。
 * 修复跨群会话串扰：此前只按 senderId 键控，同一用户在所有群共享一个
 * 活跃指针 —— 在 A 群发消息会被路由到 B 群的会话、B 群建新会话会顶掉
 * A 群的活跃指针。现在「当前会话」的语义收敛为「当前群里的当前会话」。
 */
export function senderKey(meta: MessageMeta): string {
  return `${meta.chatId}|${meta.senderId || meta.chatId}`;
}

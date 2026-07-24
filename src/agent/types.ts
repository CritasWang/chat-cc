import type { EngineEvent } from '../engine/events.js';

/**
 * Agent 会话统一接口（借鉴 lark-bridge AgentAdapter 思路，
 * 按 chat-cc 的长会话模型收敛）。
 *
 * 两个实现：
 * - engine/session.ts `Session` — Claude（Agent SDK 进程内 streaming query）
 * - agent/codex-session.ts `CodexSession` — Codex（`codex exec` 子进程 + JSONL）
 *
 * SessionPool 只依赖本接口；事件统一为 EngineEvent 流。
 */

export type AgentKind = 'claude' | 'codex';

export interface AgentSession {
  readonly threadKey: string;
  readonly cwd: string;
  /** Claude: SDK session id；Codex: thread id。持久化后用于 resume */
  sessionId?: string;
  createdAt: Date;
  lastUsedAt: Date;
  start(): void;
  send(text: string): void;
  interrupt(): Promise<void>;
  close(timeoutMs?: number): Promise<void>;
  /**
   * 可选：在线切换权限模式（不打断运行中的任务）。
   * 返回 true 表示已在线生效；false / 未实现（如 Codex 沙箱参数固化在子进程启动时）
   * 表示需由调用方回退为重启生效。
   */
  setDanger?(danger: boolean): Promise<boolean>;
}

export interface AgentSessionCallbacks {
  onEvent?: (e: EngineEvent) => void | Promise<void>;
  onNotice?: (n: { text: string; staleSessionId?: string }) => void;
}

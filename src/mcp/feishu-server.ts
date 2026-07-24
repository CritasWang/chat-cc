import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Replier } from '../feishu/replier.js';
import { log } from '../logger.js';

/**
 * Claude → 飞书 反向 MCP server。Claude 对话里可通过这些工具主动给飞书发消息、查用户。
 * 所有工具默认纳入 canUseTool 审批流（见 hooks.ts 的 autoApprovePatterns）。
 */
export interface FeishuMcpDeps {
  replier: Replier;
  /** 兜底群聊 id（当 Claude 未指定 chat_id 时） */
  defaultChatId: string;
  /** 允许被发送消息的 chat_id 白名单（调用方必须至少放入当前源群）。 */
  allowedChats: string[];
  /** 每个 chat_id 的最小发送间隔（毫秒） */
  perChatRateLimitMs: number;
  /** 进程级共享限流器；所有 Session/MCP server 必须复用同一实例。 */
  rateLimiter: FeishuRateLimiter;
}

export class FeishuRateLimiter {
  private readonly lastSentAt = new Map<string, number>();

  reserve(chatId: string, intervalMs: number):
    | { ok: false; waitMs: number }
    | { ok: true; release: () => void } {
    const now = Date.now();
    const last = this.lastSentAt.get(chatId) ?? 0;
    const elapsed = now - last;
    if (elapsed < intervalMs) return { ok: false, waitMs: intervalMs - elapsed };

    // 发送前先占位，使并发调用无法同时通过检查。
    // delete+set 同时刷新 Map 插入顺序，容量淘汰才是真正的最近最少使用近似。
    this.lastSentAt.delete(chatId);
    this.lastSentAt.set(chatId, now);
    this.compact(intervalMs, now);
    return {
      ok: true,
      release: () => {
        if (this.lastSentAt.get(chatId) === now) this.lastSentAt.delete(chatId);
      },
    };
  }

  private compact(intervalMs: number, now: number): void {
    if (this.lastSentAt.size <= 1000) return;
    const cutoff = now - Math.max(intervalMs * 10, 60_000);
    for (const [key, at] of this.lastSentAt) {
      if (at < cutoff) this.lastSentAt.delete(key);
    }
    while (this.lastSentAt.size > 1000) {
      const oldest = this.lastSentAt.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lastSentAt.delete(oldest);
    }
  }
}

export function buildFeishuMcpServer(deps: FeishuMcpDeps) {
  const sendMessageTool = tool(
    'send_message',
    '给指定飞书 chat_id 发送一条文本消息；chat_id 省略时使用默认通知群。',
    {
      chat_id: z.string().optional().describe('飞书 open_chat_id；省略则用默认通知群'),
      text: z.string().min(1).max(20_000).describe('消息正文'),
    },
    async (args) => {
      const chatId = args.chat_id ?? deps.defaultChatId;
      if (!chatId) {
        return { content: [{ type: 'text', text: '错误：未指定 chat_id 且未配置默认通知群' }], isError: true };
      }
      if (!deps.allowedChats.includes(chatId)) {
        return { content: [{ type: 'text', text: `错误：chat_id ${chatId} 不在白名单` }], isError: true };
      }
      const reservation = deps.rateLimiter.reserve(chatId, deps.perChatRateLimitMs);
      if (!reservation.ok) {
        return { content: [{ type: 'text', text: `rate limited：${reservation.waitMs}ms 后可重试` }], isError: true };
      }
      const mid = await deps.replier.sendText(chatId, args.text);
      if (!mid) {
        reservation.release();
        return { content: [{ type: 'text', text: '发送失败' }], isError: true };
      }
      log().info({ chatId, messageId: mid }, 'mcp.feishu.send_message OK');
      return { content: [{ type: 'text', text: `sent message_id=${mid}` }] };
    },
  );

  const pingTool = tool(
    'ping',
    '反向能力健康检查',
    { echo: z.string().optional() },
    async (args) => ({ content: [{ type: 'text', text: `pong ${args.echo ?? ''}`.trim() }] }),
  );

  return createSdkMcpServer({
    name: 'feishu',
    version: '1.0.0',
    tools: [sendMessageTool, pingTool],
    alwaysLoad: true,
  });
}

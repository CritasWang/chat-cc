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
  /** 允许被发送消息的 chat_id 白名单；空则允许所有 */
  allowedChats: string[];
  /** 每个 chat_id 的最小发送间隔（毫秒） */
  perChatRateLimitMs: number;
}

export function buildFeishuMcpServer(deps: FeishuMcpDeps) {
  const lastSentAt = new Map<string, number>();

  const sendMessageTool = tool(
    'send_message',
    '给指定飞书 chat_id 发送一条文本消息；chat_id 省略时使用默认通知群。',
    {
      chat_id: z.string().optional().describe('飞书 open_chat_id；省略则用默认通知群'),
      text: z.string().min(1).describe('消息正文'),
    },
    async (args) => {
      const chatId = args.chat_id ?? deps.defaultChatId;
      if (!chatId) {
        return { content: [{ type: 'text', text: '错误：未指定 chat_id 且未配置默认通知群' }], isError: true };
      }
      if (deps.allowedChats.length > 0 && !deps.allowedChats.includes(chatId)) {
        return { content: [{ type: 'text', text: `错误：chat_id ${chatId} 不在白名单` }], isError: true };
      }
      const last = lastSentAt.get(chatId) ?? 0;
      const elapsed = Date.now() - last;
      if (elapsed < deps.perChatRateLimitMs) {
        const wait = deps.perChatRateLimitMs - elapsed;
        return { content: [{ type: 'text', text: `rate limited：${wait}ms 后可重试` }], isError: true };
      }
      const mid = await deps.replier.sendText(chatId, args.text);
      if (!mid) {
        return { content: [{ type: 'text', text: '发送失败' }], isError: true };
      }
      lastSentAt.set(chatId, Date.now());
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
  });
}

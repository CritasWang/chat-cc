import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../logger.js';
import { resolveCwd } from '../config.js';
import { translateSdkMessage } from '../engine/events.js';
import type { CommandFn } from './types.js';

/**
 * /ask [@alias] <question>
 * 无状态单次提问 — 每次起一个独立 query，不保留上下文。
 */
export const askCommand: CommandFn = async (args, _meta, { cfg }) => {
  const trimmed = args.trim();
  if (!trimmed) return '用法: /ask [@项目别名] <问题>';

  let prompt = trimmed;
  let cwd = cfg.default_cwd;
  if (trimmed.startsWith('@')) {
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx > 0) {
      cwd = resolveCwd(cfg, trimmed.slice(0, spaceIdx));
      prompt = trimmed.slice(spaceIdx + 1).trim();
    }
  }
  if (!prompt) return '用法: /ask [@项目别名] <问题>';

  const options: Options = {
    cwd,
    allowedTools: cfg.claude_allowed_tools,
    ...(cfg.claude_danger_mode ? { permissionMode: 'bypassPermissions' as const } : {}),
  };

  const pieces: string[] = [];
  try {
    const q = query({ prompt, options });
    const deadline = Date.now() + cfg.claude_ask_timeout_min * 60_000;
    for await (const msg of q) {
      if (Date.now() > deadline) {
        await q.interrupt();
        return '⏱ /ask 超时（超过 ' + cfg.claude_ask_timeout_min + ' 分钟），已中断';
      }
      for (const ev of translateSdkMessage(msg)) {
        if (ev.kind === 'assistant-text') pieces.push(ev.text);
        if (ev.kind === 'result') {
          if (ev.text) return ev.text;
          return pieces.join('').trim() || '(空结果)';
        }
      }
    }
    return pieces.join('').trim() || '(空结果)';
  } catch (err) {
    log().error({ err }, '/ask 失败');
    return '/ask 失败: ' + (err instanceof Error ? err.message : String(err));
  }
};

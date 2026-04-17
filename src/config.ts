import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const ConfigSchema = z.object({
  app_id: z.string().default(''),
  app_secret: z.string().default(''),

  allowed_users: z.array(z.string()).default([]),
  allowed_chats: z.array(z.string()).default([]),

  default_cwd: z.string().default('.'),
  projects: z.record(z.string(), z.string()).default({}),

  claude_allowed_tools: z.array(z.string()).default(['Read', 'Glob', 'Grep']),
  claude_danger_mode: z.boolean().default(false),

  claude_ask_timeout_min: z.number().int().positive().default(50),
  claude_session_timeout_min: z.number().int().positive().default(50),

  max_chunk_size: z.number().int().positive().default(3500),

  shell_whitelist: z.array(z.string()).default([]),

  notify_chat_id: z.string().default(''),
  status_push_interval_min: z.number().int().nonnegative().default(180),
  status_push_chat_id: z.string().default(''),

  stream_throttle_ms: z.number().int().positive().default(500),

  persistence_dir: z.string().default('./data/sessions'),
  idle_timeout_minutes: z.number().int().nonnegative().default(30),
  idle_check_seconds: z.number().int().positive().default(60),

  /**
   * 卡片按钮回调 HTTP webhook。飞书开放平台「回调配置」里必须填
   * http(s)://<host>:<card_webhook_port><card_webhook_path>。
   * WSClient 同时也会订阅 card.action.trigger 作为副路径。
   */
  card_webhook_port: z.number().int().positive().default(9876),
  card_webhook_path: z.string().default('/webhook/card'),
  card_encrypt_key: z.string().default(''),
  card_verification_token: z.string().default(''),

  approval_timeout_ms: z.number().int().positive().default(120_000),
  /** 自动允许的工具名正则（按工具名匹配） */
  auto_approve_tools: z.array(z.string()).default(['^(Read|Glob|Grep|LS|WebFetch|WebSearch|TodoWrite)$']),

  mcp_feishu_rate_limit_ms: z.number().int().nonnegative().default(10_000),

  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  let raw: unknown = {};
  try {
    raw = parseYaml(readFileSync(path, 'utf8')) ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const cfg = ConfigSchema.parse(raw);

  const envId = process.env['FEISHU_APP_ID'];
  const envSecret = process.env['FEISHU_APP_SECRET'];
  return {
    ...cfg,
    app_id: envId?.length ? envId : cfg.app_id,
    app_secret: envSecret?.length ? envSecret : cfg.app_secret,
  };
}

export function resolveCwd(cfg: Config, input: string): string {
  if (!input) return cfg.default_cwd;
  if (input.startsWith('@')) {
    const alias = input.slice(1);
    const mapped = cfg.projects[alias];
    if (mapped) return mapped;
  }
  return input;
}

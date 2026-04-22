import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configPath as defaultConfigPath, sessionsDir } from './paths.js';

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

  persistence_dir: z.string().default(''),
  idle_timeout_minutes: z.number().int().nonnegative().default(30),
  idle_check_seconds: z.number().int().positive().default(60),

  approval_timeout_ms: z.number().int().positive().default(120_000),
  auto_approve_tools: z.array(z.string()).default(['^(Read|Glob|Grep|LS|LSP|WebFetch|WebSearch|TodoWrite|AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookRead|PushNotification)$']),

  mcp_feishu_rate_limit_ms: z.number().int().nonnegative().default(10_000),

  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ConfigLoadResult {
  config: Config;
  meta: { path: string; usedLegacy: boolean };
}

const LEGACY_PATHS = ['./config.local.yaml', './config.yaml'];

export function resolveConfigPath(): string {
  const envPath = process.env['CHAT_CC_CONFIG'];
  if (envPath) return envPath;

  const home = defaultConfigPath();
  if (existsSync(home)) return home;

  for (const legacy of LEGACY_PATHS) {
    if (existsSync(legacy)) return legacy;
  }

  return home;
}

export function loadConfig(path?: string): ConfigLoadResult {
  const cfgPath = path ?? resolveConfigPath();
  let raw: unknown = {};
  let usedLegacy = false;

  try {
    raw = parseYaml(readFileSync(cfgPath, 'utf8')) ?? {};
    usedLegacy = LEGACY_PATHS.includes(cfgPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const cfg = ConfigSchema.parse(raw);

  if (!cfg.persistence_dir) {
    cfg.persistence_dir = sessionsDir();
  }

  const envId = process.env['FEISHU_APP_ID'];
  const envSecret = process.env['FEISHU_APP_SECRET'];
  const result = {
    ...cfg,
    app_id: envId?.length ? envId : cfg.app_id,
    app_secret: envSecret?.length ? envSecret : cfg.app_secret,
  };

  return { config: result, meta: { path: cfgPath, usedLegacy: usedLegacy } };
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

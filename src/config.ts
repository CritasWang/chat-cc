import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configPath as defaultConfigPath, sessionsDir } from './paths.js';
import { loadRuntimeOverrides } from './engine/runtime-overrides.js';

const ConfigSchema = z.object({
  app_id: z.string().default(''),
  app_secret: z.string().default(''),

  allowed_users: z.array(z.string()).default([]),
  allowed_chats: z.array(z.string()).default([]),
  /** 管理员 open_id 列表：可执行敏感命令（/danger、/reload、/profile use）。
   *  留空则不额外设限（维持 allowed_users 白名单语义，向后兼容） */
  admin_users: z.array(z.string()).default([]),

  default_cwd: z.string().default('.'),
  projects: z.record(z.string(), z.string()).default({}),

  claude_allowed_tools: z.array(z.string()).default(['Read', 'Glob', 'Grep']),
  claude_danger_mode: z.boolean().default(false),

  /** 会话引擎：claude（Agent SDK，默认）或 codex（codex exec 子进程） */
  agent: z.enum(['claude', 'codex']).default('claude'),
  /** codex 可执行文件路径（默认 PATH 里的 codex） */
  codex_bin: z.string().default('codex'),
  /** codex 沙箱模式；danger 模式开启时自动升级为 danger-full-access */
  codex_sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  /** codex 模型（留空用 Codex 默认） */
  codex_model: z.string().default(''),

  /** /new chat 建群后自动打的会话标签列表（feed 标签，借道本机 lark-cli 用户身份；空数组禁用）。
   *  默认打两个：通用 `ai` + 引擎细分 `cc`/`codex` */
  new_chat_tags_claude: z.array(z.string()).default(['AI', 'Claude']),
  new_chat_tags_codex: z.array(z.string()).default(['AI', 'Codex']),
  /** lark-cli 可执行文件（打标签用） */
  lark_cli_bin: z.string().default('lark-cli'),
  /** 会话级 danger 开启时给群打的标签（off/clear 时移除；留空禁用） */
  danger_tag: z.string().default('Danger'),

  claude_ask_timeout_min: z.number().int().positive().default(50),
  claude_session_timeout_min: z.number().int().positive().default(50),

  max_chunk_size: z.number().int().positive().default(3500),

  shell_whitelist: z.array(z.string()).default([]),

  notify_chat_id: z.string().default(''),
  /** 完成通知安静阈值（分钟）：仅当该群距用户上次发消息超过此时长才推送（前台快速对话不打扰）；0 = 总是推送 */
  notify_quiet_minutes: z.number().nonnegative().default(2),
  /** 后台会话完成时在源群补发一条轻量提示（卡片 PATCH 不产生未读红点，需要新消息才有提醒） */
  notify_done_ping: z.boolean().default(true),
  status_push_interval_min: z.number().int().nonnegative().default(180),
  status_push_chat_id: z.string().default(''),

  stream_throttle_ms: z.number().int().positive().default(500),

  /** 消息静默窗口（毫秒）：窗口内的连续消息合并为一条 prompt；0 禁用（直接逐条投递） */
  message_debounce_ms: z.number().int().nonnegative().default(600),

  persistence_dir: z.string().default(''),
  idle_timeout_minutes: z.number().int().nonnegative().default(30),
  idle_check_seconds: z.number().int().positive().default(60),

  approval_timeout_ms: z.number().int().positive().default(120_000),
  auto_approve_tools: z.array(z.string()).default(['^(Read|Glob|Grep|LS|LSP|WebFetch|WebSearch|AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookRead|PushNotification)$']),

  mcp_feishu_rate_limit_ms: z.number().int().nonnegative().default(10_000),

  /** 用户消息资源（图片/文件）落盘保留天数，超期自动清理；0 = 不清理 */
  media_retention_days: z.number().int().nonnegative().default(7),

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

  // 运行时覆盖（如飞书里 /danger on --global）优先于 config.yaml，daemon 重启后仍生效
  const overrides = loadRuntimeOverrides();
  if (overrides.claude_danger_mode !== undefined) {
    cfg.claude_danger_mode = overrides.claude_danger_mode;
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

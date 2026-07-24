import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configPath as defaultConfigPath, sessionsDir } from './paths.js';
import { loadRuntimeOverrides } from './engine/runtime-overrides.js';

export const DEFAULT_AGENT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
] as const;

const ConfigSchema = z.object({
  app_id: z.string().default(''),
  app_secret: z.string().default(''),

  /** 显式允许所有用户；默认 false，避免空白名单意外开放。 */
  allow_all_users: z.boolean().default(false),
  allowed_users: z.array(z.string()).default([]),
  allowed_chats: z.array(z.string()).default([]),
  /** 管理员 open_id 列表：留空时无人可执行敏感命令。 */
  admin_users: z.array(z.string()).default([]),

  default_cwd: z.string().default('.'),
  projects: z.record(z.string(), z.string()).default({}),
  /** 允许作为会话 cwd 的附加根目录；default_cwd 与 projects 会自动纳入。 */
  allowed_cwd_roots: z.array(z.string()).default([]),
  /** 传给 Claude/Codex 子进程的环境变量白名单。 */
  agent_env_allowlist: z.array(z.string()).default([...DEFAULT_AGENT_ENV_ALLOWLIST]),

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
  /** /ask 资源上限，防单个用户或全局并发耗尽 Agent 进程。 */
  max_concurrent_asks: z.number().int().positive().default(20),
  max_concurrent_asks_per_user: z.number().int().positive().default(2),
  max_concurrent_comment_queries: z.number().int().positive().default(10),
  /** 同时驻留的 Session/query 上限，防话题/多槽位批量创建耗尽进程资源。 */
  max_active_sessions: z.number().int().positive().default(20),

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
  max_pending_messages_per_session: z.number().int().positive().default(100),
  max_pending_chars_per_session: z.number().int().positive().default(100_000),

  persistence_dir: z.string().default(''),
  idle_timeout_minutes: z.number().int().nonnegative().default(30),
  idle_check_seconds: z.number().int().positive().default(60),

  approval_timeout_ms: z.number().int().positive().default(120_000),
  auto_approve_tools: z.array(z.string()).default(['^(Read|Glob|Grep|LS|LSP|WebFetch|WebSearch|AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookRead|PushNotification)$']),

  mcp_feishu_rate_limit_ms: z.number().int().nonnegative().default(10_000),

  /** 用户消息资源（图片/文件）落盘保留天数，超期自动清理；0 = 不清理 */
  media_retention_days: z.number().int().nonnegative().default(7),

  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;
export const CONFIG_KEYS = new Set(Object.keys(ConfigSchema.shape));

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

  const cfg = parseConfig(raw);

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

/** 只做 schema/正则校验，不读取文件、环境变量或运行时覆盖。 */
export function parseConfig(raw: unknown): Config {
  const cfg = ConfigSchema.parse(raw);
  for (const pattern of cfg.auto_approve_tools) {
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new Error(`auto_approve_tools 包含无效正则 ${JSON.stringify(pattern)}: ${String(err)}`);
    }
  }
  return cfg;
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

export type CwdValidation =
  | { ok: true; cwd: string }
  | { ok: false; reason: 'missing' | 'not-directory' | 'outside-allowed-roots'; cwd: string };

/**
 * 规范化并校验会话 cwd：必须是现存目录，且位于 default_cwd/projects/allowed_cwd_roots 之一。
 * 使用 realpath 后比较，防止通过 symlink 或 `..` 越出允许根目录。
 */
export function validateCwd(cfg: Config, input: string): CwdValidation {
  if (!existsSync(input)) return { ok: false, reason: 'missing', cwd: input };

  let cwd: string;
  try {
    cwd = realpathSync(input);
    if (!statSync(cwd).isDirectory()) return { ok: false, reason: 'not-directory', cwd };
  } catch {
    return { ok: false, reason: 'missing', cwd: input };
  }

  const roots = [cfg.default_cwd, ...Object.values(cfg.projects), ...cfg.allowed_cwd_roots]
    .filter(Boolean)
    .flatMap((root) => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });

  const allowed = roots.some((root) => {
    const rel = relative(root, cwd);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  return allowed
    ? { ok: true, cwd }
    : { ok: false, reason: 'outside-allowed-roots', cwd };
}

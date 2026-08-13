import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configPath as defaultConfigPath, sessionsDir } from './paths.js';
import { loadRuntimeOverrides } from './engine/runtime-overrides.js';

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

  claude_allowed_tools: z.array(z.string()).default(['Read', 'Glob', 'Grep']),
  claude_danger_mode: z.boolean().default(false),
  /**
   * Claude 全局默认模型。优先级：会话级 /model > profile 第三段 > 本项 >
   * daemon 启动时的 ANTHROPIC_MODEL > 不指定（Claude Code 内置默认）。
   */
  claude_model: z.string().default(''),

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
  /** Codex exec spawn 后首 token 超时（分钟）；超时未收到任何 JSONL → 判定卡死 */
  codex_first_token_timeout_min: z.number().int().positive().default(10),
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

/** 已从 v3/v4 移除、但读取旧部署配置时应无害忽略的字段。 */
const LEGACY_IGNORED_CONFIG_KEYS = [
  'agent_env_allowlist',
  'claude_bin',
  'hook_port',
] as const;

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
  // 空串是有意义的值（/model clear --global = 回归"不指定模型"），不能用真值判断
  if (overrides.claude_model !== undefined) {
    cfg.claude_model = overrides.claude_model;
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
  // 已知历史键兼容性忽略；其他未知键仍由 strict schema 拒绝，避免拼写错误静默生效。
  const normalized =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (() => {
          const copy = { ...(raw as Record<string, unknown>) };
          for (const key of LEGACY_IGNORED_CONFIG_KEYS) delete copy[key];
          return copy;
        })()
      : raw;
  const cfg = ConfigSchema.parse(normalized);
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

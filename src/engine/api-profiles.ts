import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync } from '../platform/atomic-write.js';
import { chatccHome } from '../paths.js';
import { log } from '../logger.js';
import type { EnvOverrides } from '../agent/env.js';

/**
 * API profile 切换（可选补充功能）。
 *
 * 数据源：`~/.claude/cc-profiles.zsh`（用户本地已有的 shell 切换器，单一数据源），
 * 解析其中的 CC_PROFILES / CC_PROFILE_EXTRA 关联数组与 CC_DEFAULT_PROFILE。
 *
 *   CC_PROFILES=(
 *     bytecat "sk-xxx|https://api.example.org"
 *     grok    "sk-xxx|https://api.example.org|grok-4.5"
 *     gpt     "sk-xxx|https://api.example.org|gpt-5.6-sol|gpt-5.6-luna"
 *     ...
 *   )
 *   CC_DEFAULT_PROFILE=bytecat
 *   CC_PROFILE_EXTRA=(
 *     gpt "CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol ENABLE_TOOL_SEARCH=false"
 *   )
 *
 * 值按 `|` 分四段：token | baseUrl | 模型 | 小模型，后两段可省略。
 * 与 ccuse 对齐：切到某 profile 时注入它的四段值与 EXTRA，切走时清除
 * 上一个 profile 留下的同名变量（见 ApiProfileStore.managedBaseline）。
 *
 * 文件不存在 → available() 为 false，功能整体隐藏，
 * 不影响任何未使用 profile 的用户（零配置兼容）。
 *
 * 当前选择持久化在 ~/.chat-cc/api-profile.json（原子写），重启保留。
 */

export interface ApiProfile {
  name: string;
  token: string;
  baseUrl: string;
  /** 第三段 → ANTHROPIC_MODEL。模型名可能带 `[1m]` 之类的后缀，原样保留。 */
  model?: string;
  /** 第四段 → ANTHROPIC_SMALL_FAST_MODEL（后台辅助请求用的小模型）。 */
  smallFastModel?: string;
  /** CC_PROFILE_EXTRA 里同名条目解析出的额外环境变量。 */
  extraEnv?: Record<string, string>;
}

export const DEFAULT_PROFILES_PATH = join(homedir(), '.claude', 'cc-profiles.zsh');

/** profile 机制固定管理的环境变量：无论当前 profile 设没设，都必须显式赋值或删除。 */
const PROFILE_CORE_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

export class ApiProfileStore {
  private profiles = new Map<string, ApiProfile>();
  private defaultName: string | undefined;
  private currentName: string | undefined;
  private loaded = false;

  constructor(
    private readonly sourcePath: string = DEFAULT_PROFILES_PATH,
    private readonly statePath: string = join(chatccHome(), 'api-profile.json'),
  ) {}

  /** 数据源文件是否存在且至少解析出一个 profile */
  available(): boolean {
    this.ensureLoaded();
    return this.profiles.size > 0;
  }

  list(): ApiProfile[] {
    this.ensureLoaded();
    return [...this.profiles.values()];
  }

  get(name: string): ApiProfile | undefined {
    this.ensureLoaded();
    return this.profiles.get(name);
  }

  /** 当前生效的 profile：显式选择 > CC_DEFAULT_PROFILE > 无 */
  current(): ApiProfile | undefined {
    this.ensureLoaded();
    if (this.currentName) {
      const p = this.profiles.get(this.currentName);
      if (p) return p;
    }
    return this.defaultName ? this.profiles.get(this.defaultName) : undefined;
  }

  /** 切换 profile 并持久化；不存在返回 false */
  use(name: string): boolean {
    this.ensureLoaded();
    if (!this.profiles.has(name)) return false;
    this.currentName = name;
    try {
      writeFileAtomicSync(this.statePath, JSON.stringify({ name }));
    } catch (err) {
      log().warn({ err }, 'api-profile 选择持久化失败（本次运行内仍生效）');
    }
    return true;
  }

  /** 重新读取数据源（cc-profiles.zsh 变更后调用） */
  reload(): void {
    this.loaded = false;
    this.profiles.clear();
    this.defaultName = undefined;
    this.currentName = undefined;
    this.ensureLoaded();
  }

  /** 所有 profile 的 EXTRA key 并集 —— 切走时要把上一个 profile 留下的全部清掉。 */
  private managedExtraKeys(): string[] {
    this.ensureLoaded();
    const keys = new Set<string>();
    for (const p of this.profiles.values()) {
      for (const k of Object.keys(p.extraEnv ?? {})) keys.add(k);
    }
    return [...keys];
  }

  /**
   * 基线：把 profile 机制管理的所有 key 先标记为删除，再由具体 profile 覆盖回来。
   *
   * 这就是 ccuse 里 `unset` 的等价物 —— 每个 Agent 子进程的环境都是从
   * daemon 的 process.env 现造的，若不显式删除，上一个 profile 的模型/EXTRA
   * 就会从 daemon 环境里穿透过来。
   */
  private managedBaseline(): EnvOverrides {
    const base: EnvOverrides = {};
    for (const k of PROFILE_CORE_KEYS) base[k] = null;
    for (const k of this.managedExtraKeys()) base[k] = null;
    return base;
  }

  private overridesOf(p: ApiProfile): EnvOverrides {
    return {
      ...this.managedBaseline(),
      ...(p.extraEnv ?? {}),
      // 四段值后写，优先级高于 EXTRA：EXTRA 里若误写了凭据/端点键，在终端里只
      // 影响一个窗口，在这里却会把整个机器人的流量导向别处 —— 故刻意偏离 ccuse。
      ANTHROPIC_AUTH_TOKEN: p.token,
      ANTHROPIC_BASE_URL: p.baseUrl,
      ...(p.model ? { ANTHROPIC_MODEL: p.model } : {}),
      ...(p.smallFastModel ? { ANTHROPIC_SMALL_FAST_MODEL: p.smallFastModel } : {}),
    };
  }

  /** 注入子进程/SDK 的环境变量增量（null = 删除）；数据源不存在时返回空对象 */
  envOverrides(): EnvOverrides {
    const p = this.current();
    if (p) return this.overridesOf(p);
    // 数据源存在但没选中任何 profile → 仍要清干净（“显式地没有 profile”）；
    // 数据源完全不存在 → 功能整体关闭，保持零配置继承语义。
    return this.available() ? this.managedBaseline() : {};
  }

  /**
   * 会话级解析：指定名字用指定 profile（会话覆盖，类比终端各窗口
   * 各自 ccuse）。未指定时跟随全局 current()；显式名字已失效时
   * 必须 fail-closed，不能带着旧 sessionId 静默切到另一组端点/凭据。
   */
  envOverridesFor(name?: string): EnvOverrides {
    if (name) {
      const p = this.get(name);
      if (p) return this.overridesOf(p);
      throw new Error(`会话指定的 API profile 不存在: ${name}`);
    }
    return this.envOverrides();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.sourcePath)) return;
    try {
      const parsed = parseProfilesZsh(readFileSync(this.sourcePath, 'utf8'));
      this.profiles = parsed.profiles;
      this.defaultName = parsed.defaultName;
    } catch (err) {
      log().warn({ err, path: this.sourcePath }, 'cc-profiles.zsh 解析失败，profile 功能不可用');
      return;
    }
    // 恢复上次选择
    try {
      if (existsSync(this.statePath)) {
        const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as { name?: string };
        if (state.name && this.profiles.has(state.name)) this.currentName = state.name;
      }
    } catch {
      /* 状态文件损坏则回落默认 */
    }
  }
}

/** zsh 关联数组的条目行：`name "值"` / `name '值'`（本格式的值内部不含引号）。 */
const ZSH_ENTRY_RE = /^[ \t]*([A-Za-z0-9_.-]+)[ \t]+(["'])([^"']*)\2/;

/**
 * 取 `NAME=( ... )` 块内的 key → 原始值字符串。
 *
 * 注意：块正则在**第一个** `)` 处截断。本格式的值都被引号包住且不含 `)`，
 * 因此当前安全；万一将来某个值里出现 `)`，块会被提前截断 —— 宁可少解析
 * 几条，也好过跨块误吞后面的 shell 函数体。
 */
function parseZshAssoc(content: string, varName: string): Map<string, string> {
  const out = new Map<string, string>();
  const block = new RegExp(`${varName}=\\(([\\s\\S]*?)\\)`).exec(content)?.[1];
  if (!block) return out;
  for (const line of block.split('\n')) {
    // 注释行必须跳过：真实文件里被注释掉的条目同样是多段格式。
    if (/^[ \t]*#/.test(line)) continue;
    const m = ZSH_ENTRY_RE.exec(line);
    const name = m?.[1];
    if (!name) continue;
    out.set(name, m?.[3] ?? '');
  }
  return out;
}

/**
 * `KEY=VALUE KEY2=VALUE2` → Record。与 ccuse 的 `${(s: :)extra}` 行为一致：
 * 按空白切分（值本身不能含空格），只在首个 `=` 处切开（值里可以再有 `=`）。
 */
export function parseExtraEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of raw.trim().split(/\s+/)) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue; // 没有 `=` 或以 `=` 开头 → 丢弃
    const key = kv.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // 非法环境变量名 → 丢弃
    out[key] = kv.slice(eq + 1);
  }
  return out;
}

function parseProfileExtra(content: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [name, raw] of parseZshAssoc(content, 'CC_PROFILE_EXTRA')) {
    const env = parseExtraEnv(raw);
    if (Object.keys(env).length > 0) out.set(name, env);
  }
  return out;
}

export function parseProfilesZsh(content: string): {
  profiles: Map<string, ApiProfile>;
  defaultName?: string;
} {
  const profiles = new Map<string, ApiProfile>();
  const extras = parseProfileExtra(content);

  for (const [name, raw] of parseZshAssoc(content, 'CC_PROFILES')) {
    // 只按 `|` 切分，不对各段做字符集约束 —— 模型名里的 `[1m]` 等后缀原样保留。
    const seg = raw.split('|').map((s) => s.trim());
    const token = seg[0] ?? '';
    const baseUrl = seg[1] ?? '';
    if (!token || !baseUrl) continue; // 前两段是最低要求，与旧行为一致
    const model = seg[2] ?? ''; // 中间段可以留空：`tok|url||small`
    const smallFastModel = seg[3] ?? '';
    const extraEnv = extras.get(name);
    profiles.set(name, {
      name,
      token,
      baseUrl,
      ...(model ? { model } : {}),
      ...(smallFastModel ? { smallFastModel } : {}),
      ...(extraEnv ? { extraEnv } : {}),
    });
  }

  const defMatch = content.match(/^\s*CC_DEFAULT_PROFILE=["']?([A-Za-z0-9_.-]+)["']?/m);
  const defaultName = defMatch?.[1] && profiles.has(defMatch[1]) ? defMatch[1] : undefined;

  return { profiles, ...(defaultName ? { defaultName } : {}) };
}

/** token 打码显示：sk-abc… 只留前 8 位 */
export function maskToken(token: string): string {
  return token.length <= 10 ? token.slice(0, 4) + '…' : token.slice(0, 10) + '…';
}

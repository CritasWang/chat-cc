import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync } from '../platform/atomic-write.js';
import { chatccHome } from '../paths.js';
import { log } from '../logger.js';

/**
 * API profile 切换（可选补充功能）。
 *
 * 数据源：`~/.claude/cc-profiles.zsh`（用户本地已有的 shell 切换器，单一数据源），
 * 解析其中的 CC_PROFILES 关联数组与 CC_DEFAULT_PROFILE。
 *
 *   CC_PROFILES=(
 *     bytecat "sk-xxx|https://api.example.org"
 *     ...
 *   )
 *   CC_DEFAULT_PROFILE=bytecat
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
}

export const DEFAULT_PROFILES_PATH = join(homedir(), '.claude', 'cc-profiles.zsh');

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
    this.ensureLoaded();
  }

  /** 注入子进程/SDK 的环境变量增量；无 profile 时返回空对象 */
  envOverrides(): Record<string, string> {
    const p = this.current();
    if (!p) return {};
    return {
      ANTHROPIC_AUTH_TOKEN: p.token,
      ANTHROPIC_BASE_URL: p.baseUrl,
    };
  }

  /**
   * 会话级解析：指定名字用指定 profile（会话覆盖，类比终端各窗口
   * 各自 ccuse），未指定或名字已失效则回落全局 current()。
   */
  envOverridesFor(name?: string): Record<string, string> {
    if (name) {
      const p = this.get(name);
      if (p) {
        return { ANTHROPIC_AUTH_TOKEN: p.token, ANTHROPIC_BASE_URL: p.baseUrl };
      }
      log().warn({ name }, '会话指定的 API profile 不存在，回落全局默认');
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

export function parseProfilesZsh(content: string): {
  profiles: Map<string, ApiProfile>;
  defaultName?: string;
} {
  const profiles = new Map<string, ApiProfile>();
  let defaultName: string | undefined;

  // CC_PROFILES=( ... ) 块
  const blockMatch = content.match(/CC_PROFILES=\(([\s\S]*?)\)/);
  if (blockMatch) {
    // 每行形如：  name "token|url"   （允许单引号；跳过注释）
    const entryRe = /^\s*([A-Za-z0-9_.-]+)\s+["']([^"'|]+)\|([^"']+)["']/gm;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(blockMatch[1]!)) !== null) {
      const [, name, token, baseUrl] = m;
      if (!name || !token || !baseUrl) continue;
      profiles.set(name, { name, token: token.trim(), baseUrl: baseUrl.trim() });
    }
  }

  const defMatch = content.match(/^\s*CC_DEFAULT_PROFILE=["']?([A-Za-z0-9_.-]+)["']?/m);
  if (defMatch?.[1] && profiles.has(defMatch[1])) defaultName = defMatch[1];

  return { profiles, ...(defaultName ? { defaultName } : {}) };
}

/** token 打码显示：sk-abc… 只留前 8 位 */
export function maskToken(token: string): string {
  return token.length <= 10 ? token.slice(0, 4) + '…' : token.slice(0, 10) + '…';
}

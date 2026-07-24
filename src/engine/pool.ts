import { log } from '../logger.js';
import type { EngineEvent } from './events.js';
import type { PersistedSession } from './persistence.js';
import type { AgentSession, AgentKind } from '../agent/types.js';

export interface CreateSessionInput {
  threadKey: string;
  cwd: string;
  resumeId?: string;
  /** 会话级引擎选择；缺省跟随全局 config `agent` */
  agent?: AgentKind;
  /** 会话级 API profile（类比终端各窗口各自 ccuse）；缺省跟随全局当前 profile */
  apiProfile?: string;
  /** 会话级权限模式覆盖：true=danger / false=审批；缺省跟随全局 claude_danger_mode */
  danger?: boolean;
  onEvent: (e: EngineEvent) => void | Promise<void>;
  onNotice: (n: { text: string; staleSessionId?: string }) => void;
}

export interface PoolDeps {
  /** 会话工厂：按部署配置创建 Claude Session 或 CodexSession */
  createSession: (input: CreateSessionInput) => AgentSession;
  onEvent: (threadKey: string, e: EngineEvent) => void | Promise<void>;
  onStop?: (threadKey: string, keepMeta: boolean) => void;
  /** 带外通知（如 resume 失效已自愈），由 Session 经 pool 透传到上层 */
  onNotice?: (threadKey: string, n: { text: string; staleSessionId?: string }) => void;
  /** 空闲多久自动 disconnect（毫秒）；<=0 表示关闭 */
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
}

export interface ThreadKey {
  chatId: string;
  senderId: string;
  /** 同一 user+chat 下的槽位名，用于多会话并存（不传则为 "default"） */
  slot?: string;
}

export const DEFAULT_SLOT = 'default';

export function threadKey(k: ThreadKey): string {
  return `${k.chatId}:${k.senderId}:${k.slot || DEFAULT_SLOT}`;
}

export function parseThreadKey(tk: string): Required<ThreadKey> {
  const parts = tk.split(':');
  if (parts.length >= 3) {
    return {
      chatId: parts[0] ?? '',
      senderId: parts[1] ?? '',
      slot: parts.slice(2).join(':') || DEFAULT_SLOT,
    };
  }
  if (parts.length === 2) {
    return { chatId: parts[0] ?? '', senderId: parts[1] ?? '', slot: DEFAULT_SLOT };
  }
  return { chatId: tk, senderId: '', slot: DEFAULT_SLOT };
}

/** 活跃会话指针作用域：每个群/单聊独立（与 commands/types.ts senderKey 一致） */
export function userKeyOf(k: ThreadKey): string {
  return `${k.chatId}|${k.senderId || k.chatId}`;
}

/** 规范化 slot 名：只保留 URL-friendly 字符 */
export function normalizeSlot(raw: string): string {
  const s = (raw || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-');
  return s || DEFAULT_SLOT;
}

const TOPIC_SLOT_PREFIX = 't-';

/**
 * 话题群会话 key：一个话题(thread) = 一个会话，群内共享（senderId 置空）。
 * 形如 `oc_xxx::t-omt_xxx`，与 3 段 threadKey 格式兼容。
 */
export function topicThreadKey(chatId: string, threadId: string): string {
  return threadKey({ chatId, senderId: '', slot: TOPIC_SLOT_PREFIX + normalizeSlot(threadId) });
}

export function isTopicThreadKey(tk: string): boolean {
  return parseThreadKey(tk).slot.startsWith(TOPIC_SLOT_PREFIX);
}

interface ThreadMeta {
  threadKey: string;
  sessionId?: string;
  cwd: string;
  /** 会话级引擎（用户显式指定时记录并持久化；undefined = 跟随全局配置） */
  agent?: AgentKind;
  /** 会话级 API profile（用户显式指定时记录并持久化；undefined = 跟随全局当前） */
  apiProfile?: string;
  /** 会话级权限模式覆盖（undefined = 跟随全局 claude_danger_mode） */
  danger?: boolean;
  createdAt: Date;
  lastUsedAt: Date;
}

export class SessionPool {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly activeByUser = new Map<string, string>();
  private readonly meta = new Map<string, ThreadMeta>();
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly deps: PoolDeps) {
    if ((deps.idleTimeoutMs ?? 0) > 0) {
      const interval = deps.idleCheckIntervalMs ?? 60_000;
      this.idleTimer = setInterval(() => void this.sweepIdle(), interval);
    }
  }

  /** 从磁盘预热：加载会话 metadata，但不 spawn Session，lazy 等用户再来 */
  prewarm(persisted: PersistedSession[]): void {
    let migrated = 0;
    for (const p of persisted) {
      if (!p.threadKey) continue;
      // 兼容旧的 2 段 threadKey：升级到 3 段 slot=default
      let tk = p.threadKey;
      if (tk.split(':').length < 3) {
        tk = `${tk}:${DEFAULT_SLOT}`;
        migrated += 1;
      }
      this.meta.set(tk, {
        threadKey: tk,
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        cwd: p.cwd || '.',
        ...(p.agent ? { agent: p.agent } : {}),
        ...(p.apiProfile ? { apiProfile: p.apiProfile } : {}),
        ...(p.danger !== undefined ? { danger: p.danger } : {}),
        createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
        lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt) : new Date(),
      });
    }
    // 恢复 activeByUser：找到标记为 wasActive 的会话
    for (const p of persisted) {
      if (!p.wasActive || !p.threadKey) continue;
      let ptk = p.threadKey;
      if (ptk.split(':').length < 3) ptk = `${ptk}:${DEFAULT_SLOT}`;
      const parsed = parseThreadKey(ptk);
      this.activeByUser.set(userKeyOf(parsed), ptk);
    }
    log().info({ loaded: persisted.length, migrated, activeUsers: this.activeByUser.size }, 'pool 预热完成');
  }

  /** 返回某个用户在某个群内的所有会话（活跃 + 仅有 meta 的） */
  listByScope(chatId: string, senderId: string): ReturnType<SessionPool['list']> {
    return this.list().filter((s) => {
      const p = parseThreadKey(s.threadKey);
      return p.chatId === chatId && p.senderId === senderId;
    });
  }

  list(): Array<{ threadKey: string; sessionId?: string; cwd: string; lastUsed: Date; active: boolean }> {
    const out: Array<ReturnType<SessionPool['list']>[number]> = [];
    const seen = new Set<string>();
    for (const s of this.sessions.values()) {
      const m = this.meta.get(s.threadKey);
      out.push({
        threadKey: s.threadKey,
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        cwd: m?.cwd ?? '.',
        lastUsed: s.lastUsedAt,
        active: true,
      });
      seen.add(s.threadKey);
    }
    for (const m of this.meta.values()) {
      if (seen.has(m.threadKey)) continue;
      out.push({
        threadKey: m.threadKey,
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
        cwd: m.cwd,
        lastUsed: m.lastUsedAt,
        active: false,
      });
    }
    return out;
  }

  get(key: string): AgentSession | undefined {
    return this.sessions.get(key);
  }

  getActive(userKey: string): AgentSession | undefined {
    const k = this.activeByUser.get(userKey);
    return k ? this.sessions.get(k) : undefined;
  }

  /** 用户当前活跃会话的 threadKey（无论 Session 是否在运行） */
  activeThreadKeyOf(userKey: string): string | undefined {
    return this.activeByUser.get(userKey);
  }

  /**
   * 获取用户的活跃会话；若只有 meta（重启后预热态）则自动懒启动恢复。
   * 用于 send / 隐式消息投递，保证重启后用户直接发消息即可恢复对话。
   */
  getOrResumeActive(userKey: string): AgentSession | undefined {
    const k = this.activeByUser.get(userKey);
    if (!k) return undefined;
    const existing = this.sessions.get(k);
    if (existing) return existing;
    // 仅有 meta（预热态），懒启动
    const m = this.meta.get(k);
    if (!m) {
      this.activeByUser.delete(userKey);
      return undefined;
    }
    log().info({ threadKey: k, userKey }, '懒启动：从预热 meta 恢复会话');
    return this.start(parseThreadKey(k), m.cwd);
  }

  setActive(userKey: string, threadKey: string): void {
    this.activeByUser.set(userKey, threadKey);
  }

  /** 检查某个 threadKey 是否为任意用户的活跃会话 */
  isActiveForAnyUser(threadKey: string): boolean {
    for (const k of this.activeByUser.values()) {
      if (k === threadKey) return true;
    }
    return false;
  }

  getSessionId(threadKey: string): string | undefined {
    return this.sessions.get(threadKey)?.sessionId ?? this.meta.get(threadKey)?.sessionId;
  }

  getMeta(threadKey: string): ThreadMeta | undefined {
    return this.meta.get(threadKey);
  }

  updateSessionId(threadKey: string, sessionId: string): void {
    const m = this.meta.get(threadKey);
    if (m) {
      m.sessionId = sessionId;
      m.lastUsedAt = new Date();
    }
  }

  /** 清除内存 meta 里的 sessionId（resume 失效自愈后调用，避免再用失效 id） */
  clearSessionId(threadKey: string): void {
    const m = this.meta.get(threadKey);
    if (m) m.sessionId = undefined;
  }

  private handleNotice(threadKey: string, n: { text: string; staleSessionId?: string }): void {
    // resume 失效已自愈：清掉内存 meta 的失效 sessionId（新会话 init 会写入新 id），再透传上层
    this.clearSessionId(threadKey);
    this.deps.onNotice?.(threadKey, n);
  }

  start(
    keyInput: ThreadKey,
    cwd: string,
    opts: { agent?: AgentKind; apiProfile?: string; danger?: boolean } = {},
  ): AgentSession {
    const key = threadKey(keyInput);
    // 话题会话不参与「用户活跃会话」指针 — 路由由 thread_id 确定，无需 active 机制
    const isTopic = isTopicThreadKey(key);
    const userKey = userKeyOf(keyInput);
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key, cwd);
      if (!isTopic) this.activeByUser.set(userKey, key);
      return existing;
    }

    const prior = this.meta.get(key);
    const resumeId = prior?.sessionId;
    // 引擎/API profile：本次显式指定 > 该会话历史选择 > 缺省（工厂内回落全局配置）
    const agent = opts.agent ?? prior?.agent;
    const apiProfile = opts.apiProfile ?? prior?.apiProfile;
    const danger = opts.danger ?? prior?.danger;
    const sess = this.deps.createSession({
      threadKey: key,
      cwd,
      ...(resumeId ? { resumeId } : {}),
      ...(agent ? { agent } : {}),
      ...(apiProfile ? { apiProfile } : {}),
      ...(danger !== undefined ? { danger } : {}),
      onEvent: (e) => this.handleEvent(key, e),
      onNotice: (n) => this.handleNotice(key, n),
    });
    sess.start();

    this.sessions.set(key, sess);
    if (!isTopic) this.activeByUser.set(userKey, key);
    this.meta.set(key, {
      threadKey: key,
      ...(resumeId ? { sessionId: resumeId } : {}),
      cwd,
      ...(agent ? { agent } : {}),
      ...(apiProfile ? { apiProfile } : {}),
      ...(danger !== undefined ? { danger } : {}),
      createdAt: prior?.createdAt ?? new Date(),
      lastUsedAt: new Date(),
    });
    if (resumeId) log().info({ threadKey: key, resumeId, agent, apiProfile, danger }, '从磁盘恢复会话');
    return sess;
  }

  /**
   * 设置/清除某会话的 API profile 并重启该会话使之生效（上下文经 resume 保留）。
   * profile 传 undefined 表示清除会话覆盖、回归全局默认。
   * 仅重启目标会话，其他会话不受影响 —— 类比终端里只在当前窗口 ccuse。
   */
  async setSessionApiProfile(key: string, profile: string | undefined): Promise<boolean> {
    const m = this.meta.get(key);
    if (!m) return false;
    if (profile === undefined) delete m.apiProfile;
    else m.apiProfile = profile;

    // 未运行（预热态）：改 meta 即可，下次懒启动自然生效
    if (!this.sessions.get(key)) return true;

    await this.stop(key, { keepMeta: true });
    this.start(parseThreadKey(key), m.cwd);
    return true;
  }

  /**
   * 设置/清除某会话的权限模式覆盖。
   * danger 传 undefined 表示清除覆盖、回归全局 claude_danger_mode；
   * effective 为覆盖解析后的实际生效值（由调用方按「覆盖 > 全局」算好传入）。
   *
   * 优先在线切换（Session.setDanger → SDK setPermissionMode，不打断运行中的任务）；
   * 引擎不支持或在线切换失败时回退为重启生效（上下文经 resume 保留，运行中任务会被中断）。
   * @returns 'inplace' 在线生效 | 'restarted' 重启生效 | 'meta' 会话未运行仅更新元数据 | 'missing' 无此会话
   */
  async setSessionDanger(
    key: string,
    danger: boolean | undefined,
    effective: boolean,
  ): Promise<'inplace' | 'restarted' | 'meta' | 'missing'> {
    const m = this.meta.get(key);
    if (!m) return 'missing';
    if (danger === undefined) delete m.danger;
    else m.danger = danger;

    const s = this.sessions.get(key);
    if (!s) return 'meta';

    if (s.setDanger && (await s.setDanger(effective))) {
      log().info({ threadKey: key, danger: effective }, '权限模式已在线切换（未重启会话）');
      return 'inplace';
    }

    await this.stop(key, { keepMeta: true });
    this.start(parseThreadKey(key), m.cwd);
    return 'restarted';
  }

  async stop(key: string, { keepMeta = true } = {}): Promise<boolean> {
    const s = this.sessions.get(key);
    if (!s && !this.meta.has(key)) return false;
    // 先从池里摘除再等 close；若 close() 因 SDK pump 卡死挂住，后续 start 也能直接新建
    if (s) this.sessions.delete(key);
    // keepMeta=true（idle 回收 / restartAll 前的临时停）保留 activeByUser 指针，
    // 使后续 getOrResumeActive 能凭磁盘 meta + SDK resumeId 懒恢复同一会话、延续多轮上下文；
    // 仅 keepMeta=false（彻底销毁，如 /session stop）才清除活跃指针与 meta。
    if (!keepMeta) {
      for (const [u, k] of this.activeByUser) {
        if (k === key) this.activeByUser.delete(u);
      }
      this.meta.delete(key);
    }
    if (s) {
      await s.close().catch((err) => log().warn({ err, threadKey: key }, 'session close 异常（已忽略）'));
    }
    // onStop（含 pending.unblock）必须在 close 完成之后：
    // unblock 会武装 flush 计时器，flush 懒启动新会话；若旧会话尚在收尾，
    // 同一 resumeId 可能被新旧两个 query 短暂同时持有
    this.deps.onStop?.(key, keepMeta);
    return true;
  }

  /**
   * 重启所有正在运行的会话。
   * 先 stop（keepMeta: true），再 start，令新配置（如 danger mode 切换）立即生效。
   */
  async restartAll(): Promise<void> {
    const entries = [...this.sessions.keys()].map((k) => {
      const m = this.meta.get(k);
      return { threadKey: k, parsed: parseThreadKey(k), cwd: m?.cwd ?? '.' };
    });
    if (entries.length === 0) return;
    log().info({ count: entries.length }, '重启所有活跃会话');
    // 先全部 stop
    await Promise.allSettled(entries.map(({ threadKey }) => this.stop(threadKey, { keepMeta: true })));
    // 再全部 start（使用最新 buildConfig）
    for (const { parsed, cwd } of entries) {
      this.start(parsed, cwd);
    }
  }

  async closeAll(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    await Promise.allSettled([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    this.activeByUser.clear();
  }

  private touch(key: string, cwd?: string): void {
    const m = this.meta.get(key);
    if (m) {
      m.lastUsedAt = new Date();
      if (cwd) m.cwd = cwd;
    }
  }

  private async handleEvent(key: string, e: EngineEvent): Promise<void> {
    if (e.kind === 'init') {
      this.updateSessionId(key, e.sessionId);
    } else {
      this.touch(key);
    }
    await this.deps.onEvent(key, e);
  }

  private async sweepIdle(): Promise<void> {
    const timeoutMs = this.deps.idleTimeoutMs ?? 0;
    if (timeoutMs <= 0) return;
    const now = Date.now();
    const victims: string[] = [];
    for (const [k, s] of this.sessions) {
      if (now - s.lastUsedAt.getTime() > timeoutMs) victims.push(k);
    }
    for (const k of victims) {
      log().info({ threadKey: k, idleMs: timeoutMs }, '会话空闲超时，自动关闭（保留磁盘 meta）');
      await this.stop(k, { keepMeta: true }).catch((err) =>
        log().error({ err, threadKey: k }, 'idle close 失败'),
      );
    }
  }
}

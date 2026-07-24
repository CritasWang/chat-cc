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
  onStop?: (threadKey: string, keepMeta: boolean, reason: StopReason) => void;
  /** 带外通知（如 resume 失效已自愈），由 Session 经 pool 透传到上层 */
  onNotice?: (threadKey: string, n: { text: string; staleSessionId?: string }) => void;
  /** 空闲多久自动 disconnect（毫秒）；<=0 表示关闭 */
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
  /** 同时运行的 AgentSession 上限；<=0 表示不限制。 */
  maxActiveSessions?: number;
  /** 当前是否有一轮 Agent 任务在运行；忙碌会话不参与 idle 回收。 */
  isBusy?: (threadKey: string) => boolean;
  /** 当前全局默认引擎；用于把 sessionId 与实际引擎绑定。 */
  defaultAgent?: () => AgentKind;
  /** active 指针变化时同步持久化新旧状态。 */
  onActiveChange?: (userKey: string, previous: string | undefined, next: string | undefined) => void;
  /** 会话级 agent/profile/danger/sessionId 等元数据变化时持久化。 */
  onMetaChange?: (threadKey: string) => void;
}

export type StopReason = 'restart' | 'destroy' | 'idle' | 'context-reset' | 'shutdown' | 'unknown';

export class SessionPoolCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`active session limit exceeded (${limit})`);
    this.name = 'SessionPoolCapacityError';
  }
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
  /** 当前 sessionId/运行实例实际使用的引擎。 */
  sessionIdAgent?: AgentKind;
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
  private readonly generations = new Map<string, number>();
  private generationCounter = 0;
  /** 复合生命周期操作的 last-writer-wins token，防 restart/reset 与 destroy 并发后复活旧会话。 */
  private readonly lifecycleTokens = new Map<string, symbol>();
  /** SDK setPermissionMode 存在外部副作，同 key 必须串行，避免旧请求后完成覆盖新状态。 */
  private readonly dangerUpdates = new Map<string, Promise<unknown>>();
  private readonly closing = new Map<string, { keepMeta: boolean; reason: StopReason; promise: Promise<void> }>();
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
    let droppedUnboundResume = 0;
    for (const p of persisted) {
      if (!p.threadKey) continue;
      // 兼容旧的 2 段 threadKey：升级到 3 段 slot=default
      let tk = p.threadKey;
      if (tk.split(':').length < 3) {
        tk = `${tk}:${DEFAULT_SLOT}`;
        migrated += 1;
      }
      const sessionIdAgent = p.sessionIdAgent ?? p.agent;
      if (p.sessionId && !sessionIdAgent) droppedUnboundResume += 1;
      this.meta.set(tk, {
        threadKey: tk,
        ...(p.sessionId && sessionIdAgent ? { sessionId: p.sessionId, sessionIdAgent } : {}),
        cwd: p.cwd,
        ...(p.agent ? { agent: p.agent } : {}),
        ...(p.apiProfile ? { apiProfile: p.apiProfile } : {}),
        ...(p.danger !== undefined ? { danger: p.danger } : {}),
        createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
        lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt) : new Date(),
      });
    }
    // 恢复 activeByUser：同一 scope 若有多个旧 wasActive，按 lastUsedAt 确定唯一最新项。
    const activeCandidates = new Map<string, Array<{ threadKey: string; lastUsedAt: number }>>();
    for (const p of persisted) {
      if (!p.wasActive || !p.threadKey) continue;
      let ptk = p.threadKey;
      if (ptk.split(':').length < 3) ptk = `${ptk}:${DEFAULT_SLOT}`;
      const parsed = parseThreadKey(ptk);
      const userKey = userKeyOf(parsed);
      const items = activeCandidates.get(userKey) ?? [];
      items.push({ threadKey: ptk, lastUsedAt: Date.parse(p.lastUsedAt) || 0 });
      activeCandidates.set(userKey, items);
    }
    let duplicateActiveMarkers = 0;
    for (const [userKey, items] of activeCandidates) {
      items.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.threadKey.localeCompare(b.threadKey));
      this.activeByUser.set(userKey, items[0]!.threadKey);
      duplicateActiveMarkers += Math.max(0, items.length - 1);
    }
    log().info(
      {
        loaded: persisted.length,
        migrated,
        droppedUnboundResume,
        duplicateActiveMarkers,
        activeUsers: this.activeByUser.size,
      },
      'pool 预热完成',
    );
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
        cwd: m?.cwd ?? s.cwd,
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
    if (this.closing.has(key)) return undefined;
    return this.sessions.get(key);
  }

  isClosing(key: string): boolean {
    return this.closing.has(key);
  }

  activeCount(): number {
    return this.sessions.size;
  }

  hasStartCapacity(): boolean {
    const limit = this.deps.maxActiveSessions ?? 0;
    return limit <= 0 || this.sessions.size < limit;
  }

  generationOf(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  getActive(userKey: string): AgentSession | undefined {
    const k = this.activeByUser.get(userKey);
    return k ? this.get(k) : undefined;
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
    if (existing && !this.closing.has(k)) return existing;
    if (this.closing.has(k)) return undefined;
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
    if (!this.meta.has(threadKey)) throw new Error(`cannot activate missing session ${threadKey}`);
    this.activate(userKey, threadKey);
  }

  private activate(userKey: string, threadKey: string): void {
    const previous = this.activeByUser.get(userKey);
    if (previous === threadKey) return;
    this.activeByUser.set(userKey, threadKey);
    this.deps.onActiveChange?.(userKey, previous, threadKey);
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
      this.deps.onMetaChange?.(threadKey);
    }
  }

  /** 清除内存 meta 里的 sessionId（resume 失效自愈后调用，避免再用失效 id） */
  clearSessionId(threadKey: string): void {
    const m = this.meta.get(threadKey);
    if (m) {
      m.sessionId = undefined;
      m.sessionIdAgent = undefined;
      this.deps.onMetaChange?.(threadKey);
    }
  }

  private handleNotice(
    threadKey: string,
    generation: number,
    n: { text: string; staleSessionId?: string },
  ): void {
    if (this.generations.get(threadKey) !== generation) return;
    // resume 失效已自愈：仅清掉旧 ID；当前运行实例的引擎归属仍需保留，供新 init 绑定。
    const m = this.meta.get(threadKey);
    if (m) {
      m.sessionId = undefined;
      this.deps.onMetaChange?.(threadKey);
    }
    this.deps.onNotice?.(threadKey, n);
  }

  start(
    keyInput: ThreadKey,
    cwd: string,
    opts: { agent?: AgentKind; apiProfile?: string; danger?: boolean } = {},
  ): AgentSession {
    const key = threadKey(keyInput);
    if (this.closing.has(key)) {
      throw new Error(`session ${key} is closing`);
    }
    // 话题会话不参与「用户活跃会话」指针 — 路由由 thread_id 确定，无需 active 机制
    const isTopic = isTopicThreadKey(key);
    const userKey = userKeyOf(keyInput);
    const prior = this.meta.get(key);
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key);
      if (!isTopic) this.activate(userKey, key);
      const needRestart =
        existing.cwd !== cwd ||
        (opts.agent !== undefined && opts.agent !== (prior?.sessionIdAgent ?? prior?.agent)) ||
        (opts.apiProfile !== undefined && opts.apiProfile !== prior?.apiProfile) ||
        (opts.danger !== undefined && opts.danger !== prior?.danger);
      if (!needRestart) return existing;
      // opts 变更：start() 是同步接口，无法安全 await oldSession.close()（Codex 需等进程退出）。
      // 调用方应显式 await pool.stop() → pool.start() 或使用下面的 restart()。
      log().warn({ threadKey: key, cwd, currentCwd: existing.cwd, opts, prior: { agent: prior?.agent, apiProfile: prior?.apiProfile, danger: prior?.danger } },
        'opts 变更但 start() 不重启已运行会话——调用方应先 stop/restart');
      return existing;
    }

    const activeLimit = this.deps.maxActiveSessions ?? 0;
    if (activeLimit > 0 && this.sessions.size >= activeLimit) {
      throw new SessionPoolCapacityError(activeLimit);
    }

    // 引擎/API profile：本次显式指定 > 该会话历史覆盖 > 全局默认。
    const agentOverride = opts.agent ?? prior?.agent;
    const agent = agentOverride ?? this.deps.defaultAgent?.() ?? 'claude';
    const apiProfile = opts.apiProfile ?? prior?.apiProfile;
    const danger = opts.danger ?? prior?.danger;
    const resumeId = prior?.sessionId && prior.sessionIdAgent === agent ? prior.sessionId : undefined;
    if (prior?.sessionId && !resumeId) {
      log().warn(
        { threadKey: key, sessionIdAgent: prior.sessionIdAgent, nextAgent: agent },
        '历史 sessionId 与目标引擎不匹配，已丢弃 resume',
      );
    }
    const generation = ++this.generationCounter;
    this.generations.set(key, generation);
    let sess: AgentSession | undefined;
    try {
      sess = this.deps.createSession({
        threadKey: key,
        cwd,
        ...(resumeId ? { resumeId } : {}),
        agent,
        ...(apiProfile ? { apiProfile } : {}),
        ...(danger !== undefined ? { danger } : {}),
        onEvent: (e) => this.handleEvent(key, generation, e),
        onNotice: (n) => this.handleNotice(key, generation, n),
      });
      this.sessions.set(key, sess);
      this.meta.set(key, {
        threadKey: key,
        ...(resumeId ? { sessionId: resumeId } : {}),
        sessionIdAgent: agent,
        cwd,
        ...(agentOverride ? { agent: agentOverride } : {}),
        ...(apiProfile ? { apiProfile } : {}),
        ...(danger !== undefined ? { danger } : {}),
        createdAt: prior?.createdAt ?? new Date(),
        lastUsedAt: new Date(),
      });
      sess.start();
    } catch (err) {
      if (sess && this.sessions.get(key) === sess) this.sessions.delete(key);
      if (this.generations.get(key) === generation) this.generations.delete(key);
      // createSession()/start() 同步失败不能留下一个
      // “看似存在、实际从未启动”的幽灵 meta/generation。
      if (prior) this.meta.set(key, prior);
      else this.meta.delete(key);
      if (sess) {
        void Promise.resolve().then(() => sess!.close()).catch((closeErr) =>
          log().warn({ err: closeErr, threadKey: key }, '启动失败后的 session 清理异常'),
        );
      }
      throw err;
    }
    if (!isTopic) this.activate(userKey, key);
    this.deps.onMetaChange?.(key);
    if (resumeId) log().info({ threadKey: key, resumeId, agent, apiProfile, danger }, '从磁盘恢复会话');
    return sess;
  }

  /**
   * 异步重启会话：先 await stop() 等待旧进程完全退出（含 Codex SIGTERM/SIGKILL），
   * 再 start() 新会话。调用方显式传 opts 覆盖 meta 中的历史选择时使用此路径。
   */
  async restart(
    keyInput: ThreadKey,
    cwd: string,
    opts: { agent?: AgentKind; apiProfile?: string; danger?: boolean } = {},
  ): Promise<AgentSession> {
    const key = threadKey(keyInput);
    const token = this.beginLifecycle(key);
    try {
      await this.stopInternal(key, { keepMeta: true, reason: 'restart' });
      if (!this.isCurrentLifecycle(key, token) || !this.meta.has(key)) {
        throw new Error(`session ${key} restart was superseded`);
      }
      // stop 保留了 meta，start 会用新 opts 覆盖。
      return this.start(keyInput, cwd, opts);
    } finally {
      this.endLifecycle(key, token);
    }
  }

  /**
   * 原子化上下文重置：关闭旧实例、丢弃 resumeId、更新 cwd，再以同一 threadKey 重开。
   * 若期间出现 destroy 或更新的生命周期操作，返回 undefined 且绝不复活旧会话。
   */
  async resetContext(
    key: string,
    cwd: string,
    opts: { agent?: AgentKind; apiProfile?: string; danger?: boolean } = {},
  ): Promise<AgentSession | undefined> {
    const token = this.beginLifecycle(key);
    try {
      if (!this.meta.has(key) && !this.sessions.has(key)) return undefined;
      await this.stopInternal(key, { keepMeta: true, reason: 'context-reset' });
      if (!this.isCurrentLifecycle(key, token)) return undefined;
      const m = this.meta.get(key);
      if (!m) return undefined;
      m.sessionId = undefined;
      m.sessionIdAgent = undefined;
      m.cwd = cwd;
      m.lastUsedAt = new Date();
      this.deps.onMetaChange?.(key);
      return this.start(parseThreadKey(key), cwd, opts);
    } finally {
      this.endLifecycle(key, token);
    }
  }

  /**
   * 设置/清除某会话的 API profile 并重启该会话使之生效（上下文经 resume 保留）。
   * profile 传 undefined 表示清除会话覆盖、回归全局默认。
   * 仅重启目标会话，其他会话不受影响 —— 类比终端里只在当前窗口 ccuse。
   */
  async setSessionApiProfile(key: string, profile: string | undefined): Promise<boolean> {
    const token = this.beginLifecycle(key);
    const m = this.meta.get(key);
    try {
      if (!m) return false;
      if (profile === undefined) delete m.apiProfile;
      else m.apiProfile = profile;
      this.deps.onMetaChange?.(key);

      // 未运行（预热态）：改 meta 即可，下次懒启动自然生效
      if (!this.sessions.get(key)) return true;

      await this.stopInternal(key, { keepMeta: true, reason: 'restart' });
      if (!this.isCurrentLifecycle(key, token) || !this.meta.has(key)) return false;
      this.start(parseThreadKey(key), m.cwd);
      return true;
    } finally {
      this.endLifecycle(key, token);
    }
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
    const previous = this.dangerUpdates.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.applySessionDanger(key, danger, effective));
    this.dangerUpdates.set(key, task);
    try {
      return await task;
    } finally {
      if (this.dangerUpdates.get(key) === task) this.dangerUpdates.delete(key);
    }
  }

  private async applySessionDanger(
    key: string,
    danger: boolean | undefined,
    effective: boolean,
  ): Promise<'inplace' | 'restarted' | 'meta' | 'missing'> {
    const token = this.beginLifecycle(key);
    const m = this.meta.get(key);
    try {
      if (!m) return 'missing';
      if (danger === undefined) delete m.danger;
      else m.danger = danger;
      this.deps.onMetaChange?.(key);

      const s = this.sessions.get(key);
      if (!s) return 'meta';

      if (s.setDanger && (await s.setDanger(effective))) {
        if (
          !this.isCurrentLifecycle(key, token) ||
          this.sessions.get(key) !== s ||
          !this.meta.has(key)
        ) return 'missing';
        log().info({ threadKey: key, danger: effective }, '权限模式已在线切换（未重启会话）');
        return 'inplace';
      }

      if (!this.isCurrentLifecycle(key, token)) return 'missing';
      await this.stopInternal(key, { keepMeta: true, reason: 'restart' });
      if (!this.isCurrentLifecycle(key, token) || !this.meta.has(key)) return 'missing';
      this.start(parseThreadKey(key), m.cwd);
      return 'restarted';
    } finally {
      this.endLifecycle(key, token);
    }
  }

  async stop(
    key: string,
    { keepMeta = true, reason = 'unknown' as StopReason } = {},
  ): Promise<boolean> {
    // 显式 stop/destroy 优先于任何尚未完成的 restart/reset，后者完成 close 后不得再 start。
    this.lifecycleTokens.delete(key);
    return this.stopInternal(key, { keepMeta, reason });
  }

  private async stopInternal(
    key: string,
    { keepMeta = true, reason = 'unknown' as StopReason } = {},
  ): Promise<boolean> {
    const inProgress = this.closing.get(key);
    if (inProgress) {
      // 任一并发调用要求彻底销毁时，最终结果必须升级为 keepMeta=false。
      inProgress.keepMeta = inProgress.keepMeta && keepMeta;
      inProgress.reason = mergeStopReason(inProgress.reason, reason);
      await inProgress.promise;
      return true;
    }

    const s = this.sessions.get(key);
    if (!s && !this.meta.has(key)) return false;

    const state: { keepMeta: boolean; reason: StopReason; promise: Promise<void> } = {
      keepMeta,
      reason,
      promise: Promise.resolve(),
    };
    state.promise = this.finishStop(key, s, state);
    this.closing.set(key, state);
    try {
      await state.promise;
      return true;
    } finally {
      if (this.closing.get(key) === state) this.closing.delete(key);
    }
  }

  private async finishStop(
    key: string,
    s: AgentSession | undefined,
    state: { keepMeta: boolean; reason: StopReason },
  ): Promise<void> {
    // 立即使旧实例的所有异步回调失效；新实例只能在 closing 清除后创建。
    this.generations.delete(key);
    if (s) {
      await s.close().catch((err) => log().warn({ err, threadKey: key }, 'session close 异常（已忽略）'));
      if (this.sessions.get(key) === s) this.sessions.delete(key);
    }

    if (!state.keepMeta) {
      for (const [u, k] of this.activeByUser) {
        if (k === key) {
          this.activeByUser.delete(u);
          this.deps.onActiveChange?.(u, key, undefined);
        }
      }
      this.meta.delete(key);
    } else {
      this.deps.onMetaChange?.(key);
    }

    // closing 仍在 Map 中，onStop 清理期间不会有同 key 新会话插入。
    this.deps.onStop?.(key, state.keepMeta, state.reason);
  }

  /**
   * 重启所有正在运行的会话。
   * 先 stop（keepMeta: true），再 start，令新配置（如 danger mode 切换）立即生效。
   */
  async restartAll(): Promise<void> {
    const entries = [...this.sessions.entries()].map(([k, session]) => {
      const m = this.meta.get(k);
      return { threadKey: k, parsed: parseThreadKey(k), cwd: m?.cwd ?? session.cwd };
    });
    if (entries.length === 0) return;
    log().info({ count: entries.length }, '重启所有活跃会话');
    // 先全部 stop
    await Promise.allSettled(
      entries.map(({ threadKey }) => this.stop(threadKey, { keepMeta: true, reason: 'restart' })),
    );
    // 再全部 start（使用最新 buildConfig）
    for (const { threadKey: key, parsed, cwd } of entries) {
      if (!this.meta.has(key)) continue;
      this.start(parsed, cwd);
    }
  }

  async closeAll(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.generations.clear();
    this.lifecycleTokens.clear();
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

  private async handleEvent(key: string, generation: number, e: EngineEvent): Promise<void> {
    if (this.generations.get(key) !== generation || this.closing.has(key)) return;
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
      if (this.deps.isBusy?.(k)) continue;
      if (now - s.lastUsedAt.getTime() > timeoutMs) victims.push(k);
    }
    for (const k of victims) {
      log().info({ threadKey: k, idleMs: timeoutMs }, '会话空闲超时，自动关闭（保留磁盘 meta）');
      await this.stop(k, { keepMeta: true, reason: 'idle' }).catch((err) =>
        log().error({ err, threadKey: k }, 'idle close 失败'),
      );
    }
  }

  private beginLifecycle(key: string): symbol {
    const token = Symbol(key);
    this.lifecycleTokens.set(key, token);
    return token;
  }

  private isCurrentLifecycle(key: string, token: symbol): boolean {
    return this.lifecycleTokens.get(key) === token;
  }

  private endLifecycle(key: string, token: symbol): void {
    if (this.lifecycleTokens.get(key) === token) this.lifecycleTokens.delete(key);
  }
}

function mergeStopReason(current: StopReason, incoming: StopReason): StopReason {
  const priority: Record<StopReason, number> = {
    unknown: 0,
    idle: 1,
    restart: 1,
    shutdown: 1,
    'context-reset': 2,
    destroy: 3,
  };
  return priority[incoming] > priority[current] ? incoming : current;
}

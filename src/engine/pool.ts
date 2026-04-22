import { log } from '../logger.js';
import type { EngineEvent } from './events.js';
import type { PersistedSession } from './persistence.js';
import { Session, type SessionConfig } from './session.js';

export interface PoolDeps {
  buildConfig: (threadKey: string, cwd: string, resumeId?: string) => SessionConfig;
  onEvent: (threadKey: string, e: EngineEvent) => void | Promise<void>;
  onStop?: (threadKey: string, keepMeta: boolean) => void;
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

export function userKeyOf(k: ThreadKey): string {
  return k.senderId || k.chatId;
}

/** 规范化 slot 名：只保留 URL-friendly 字符 */
export function normalizeSlot(raw: string): string {
  const s = (raw || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-');
  return s || DEFAULT_SLOT;
}

interface ThreadMeta {
  threadKey: string;
  sessionId?: string;
  cwd: string;
  createdAt: Date;
  lastUsedAt: Date;
}

export class SessionPool {
  private readonly sessions = new Map<string, Session>();
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
      const userKey = parsed.senderId || parsed.chatId;
      this.activeByUser.set(userKey, ptk);
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

  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  getActive(userKey: string): Session | undefined {
    const k = this.activeByUser.get(userKey);
    return k ? this.sessions.get(k) : undefined;
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

  start(keyInput: ThreadKey, cwd: string): Session {
    const key = threadKey(keyInput);
    const userKey = keyInput.senderId || keyInput.chatId;
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key, cwd);
      this.activeByUser.set(userKey, key);
      return existing;
    }

    const prior = this.meta.get(key);
    const resumeId = prior?.sessionId;
    const cfg = this.deps.buildConfig(key, cwd, resumeId);
    const sess = new Session({
      ...cfg,
      onEvent: (e) => this.handleEvent(key, e),
    });
    sess.start();

    this.sessions.set(key, sess);
    this.activeByUser.set(userKey, key);
    this.meta.set(key, {
      threadKey: key,
      ...(resumeId ? { sessionId: resumeId } : {}),
      cwd,
      createdAt: prior?.createdAt ?? new Date(),
      lastUsedAt: new Date(),
    });
    if (resumeId) log().info({ threadKey: key, resumeId }, '从磁盘恢复会话');
    return sess;
  }

  async stop(key: string, { keepMeta = true } = {}): Promise<boolean> {
    const s = this.sessions.get(key);
    if (!s && !this.meta.has(key)) return false;
    // 先从池里摘除再等 close；若 close() 因 SDK pump 卡死挂住，后续 start 也能直接新建
    if (s) this.sessions.delete(key);
    for (const [u, k] of this.activeByUser) {
      if (k === key) this.activeByUser.delete(u);
    }
    if (!keepMeta) this.meta.delete(key);
    this.deps.onStop?.(key, keepMeta);
    if (s) {
      await s.close().catch((err) => log().warn({ err, threadKey: key }, 'session close 异常（已忽略）'));
    }
    return true;
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

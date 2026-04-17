import { log } from '../logger.js';
import type { EngineEvent } from './events.js';
import type { PersistedSession } from './persistence.js';
import { Session, type SessionConfig } from './session.js';

export interface PoolDeps {
  buildConfig: (threadKey: string, cwd: string, resumeId?: string) => SessionConfig;
  onEvent: (threadKey: string, e: EngineEvent) => void | Promise<void>;
  /** 空闲多久自动 disconnect（毫秒）；<=0 表示关闭 */
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
}

export interface ThreadKey {
  chatId: string;
  senderId: string;
}

export function threadKey(k: ThreadKey): string {
  return `${k.chatId}:${k.senderId}`;
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
    for (const p of persisted) {
      if (!p.threadKey) continue;
      this.meta.set(p.threadKey, {
        threadKey: p.threadKey,
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        cwd: p.cwd || '.',
        createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
        lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt) : new Date(),
      });
    }
    log().info({ loaded: persisted.length }, 'pool 预热完成');
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
    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(key, cwd);
      this.activeByUser.set(keyInput.senderId, key);
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
    this.activeByUser.set(keyInput.senderId, key);
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
    if (s) {
      await s.close();
      this.sessions.delete(key);
    }
    for (const [u, k] of this.activeByUser) {
      if (k === key) this.activeByUser.delete(u);
    }
    if (!keepMeta) this.meta.delete(key);
    return Boolean(s);
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

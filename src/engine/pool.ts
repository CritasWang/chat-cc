import type { EngineEvent } from './events.js';
import { Session, type SessionConfig } from './session.js';

export interface PoolDeps {
  buildConfig: (threadKey: string, cwd: string) => SessionConfig;
  onEvent: (threadKey: string, e: EngineEvent) => void | Promise<void>;
}

export interface ThreadKey {
  chatId: string;
  senderId: string;
}

export function threadKey(k: ThreadKey): string {
  return `${k.chatId}:${k.senderId}`;
}

export class SessionPool {
  private readonly sessions = new Map<string, Session>();
  private readonly activeByUser = new Map<string, string>();

  constructor(private readonly deps: PoolDeps) {}

  list(): Array<{ threadKey: string; sessionId?: string; cwd?: string; lastUsed: Date }> {
    return [...this.sessions.values()].map((s) => ({
      threadKey: s.threadKey,
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      lastUsed: s.lastUsedAt,
    }));
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

  start(keyInput: ThreadKey, cwd: string): Session {
    const key = threadKey(keyInput);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const cfg = this.deps.buildConfig(key, cwd);
    const sess = new Session({
      ...cfg,
      onEvent: (e) => this.deps.onEvent(key, e),
    });
    sess.start();
    this.sessions.set(key, sess);
    this.activeByUser.set(keyInput.senderId, key);
    return sess;
  }

  async stop(key: string): Promise<boolean> {
    const s = this.sessions.get(key);
    if (!s) return false;
    await s.close();
    this.sessions.delete(key);
    for (const [u, k] of this.activeByUser) {
      if (k === key) this.activeByUser.delete(u);
    }
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    this.activeByUser.clear();
  }
}

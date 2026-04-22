import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageSnapshot } from './events.js';
import { log } from '../logger.js';

export interface PersistedSession {
  threadKey: string;
  sessionId?: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  cost: UsageSnapshot;
  /** 该会话在持久化时是否为用户的活跃会话 */
  wasActive?: boolean;
}

export class Persistence {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  save(s: PersistedSession): void {
    try {
      writeFileSync(this.pathOf(s.threadKey), JSON.stringify(s, null, 2), 'utf8');
    } catch (err) {
      log().error({ err, threadKey: s.threadKey }, 'persist 会话失败');
    }
  }

  loadAll(): PersistedSession[] {
    const out: PersistedSession[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(this.dir, name), 'utf8');
        out.push(JSON.parse(raw) as PersistedSession);
      } catch (err) {
        log().warn({ err, name }, '读取持久化文件失败，跳过');
      }
    }
    return out;
  }

  delete(threadKey: string): void {
    try {
      const p = this.pathOf(threadKey);
      if (existsSync(p)) unlinkSync(p);
    } catch (err) {
      log().warn({ err, threadKey }, '删除持久化文件失败');
    }
  }

  private pathOf(threadKey: string): string {
    const safe = threadKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, safe + '.json');
  }
}

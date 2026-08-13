import { chmodSync, mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { UsageSnapshot } from './events.js';
import { writeFileAtomicSync } from '../platform/atomic-write.js';
import { log } from '../logger.js';

export interface PersistedSession {
  threadKey: string;
  sessionId?: string;
  /** sessionId 所属引擎，防止 Claude/Codex 之间误复用。 */
  sessionIdAgent?: 'claude' | 'codex';
  cwd: string;
  /** 会话级引擎（用户显式指定时记录；缺省跟随全局配置） */
  agent?: 'claude' | 'codex';
  /** 会话级 API profile（用户显式指定时记录；缺省跟随全局当前） */
  apiProfile?: string;
  /** 会话级权限模式覆盖（缺省跟随全局 claude_danger_mode） */
  danger?: boolean;
  /** 会话级模型覆盖（缺省跟随 profile / 全局 claude_model） */
  model?: string;
  createdAt: string;
  lastUsedAt: string;
  cost: UsageSnapshot;
  /** 该会话在持久化时是否为用户的活跃会话 */
  wasActive?: boolean;
}

const UsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cacheReadTokens: z.number().nonnegative().default(0),
  cacheCreationTokens: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().optional(),
  model: z.string().optional(),
});

const PersistedSessionSchema = z.object({
  threadKey: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  sessionIdAgent: z.enum(['claude', 'codex']).optional(),
  cwd: z.string().min(1),
  agent: z.enum(['claude', 'codex']).optional(),
  apiProfile: z.string().min(1).optional(),
  danger: z.boolean().optional(),
  model: z.string().min(1).optional(),
  createdAt: z.string().refine(validDate, 'invalid createdAt'),
  lastUsedAt: z.string().refine(validDate, 'invalid lastUsedAt'),
  cost: UsageSchema.default({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }),
  wasActive: z.boolean().optional(),
});

export class Persistence {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* 尽力而为 */ }
  }

  save(s: PersistedSession): void {
    try {
      writeFileAtomicSync(this.pathOf(s.threadKey), JSON.stringify(s, null, 2));
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
        const parsed = PersistedSessionSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          log().warn({ name, issues: parsed.error.issues }, '持久化文件 schema 无效，跳过');
          continue;
        }
        out.push(parsed.data as PersistedSession);
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
    const safe = Buffer.from(threadKey).toString('hex');
    return join(this.dir, safe + '.json');
  }
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

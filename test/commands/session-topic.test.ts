import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { sessionCommand } from '../../src/commands/session.js';
import { SessionPool, threadKey, topicThreadKey } from '../../src/engine/pool.js';

function makePool(): SessionPool {
  return new SessionPool({
    createSession: ({ threadKey: key, cwd }) => ({
      threadKey: key,
      cwd,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      start() {},
      send() {},
      async interrupt() {},
      async close() {},
    }),
    onEvent: () => {},
  });
}

const meta = {
  messageId: 'om_topic',
  chatId: 'oc_topic',
  chatType: 'group',
  senderId: 'ou_user',
  mentionBot: true,
  threadId: 'omt_topic',
};

describe('/session start in topic', () => {
  it('创建当前话题会话而不是个人 slot，并在话题内回复', async () => {
    const pool = makePool();
    const replyCard = vi.fn(async () => 'om_reply');
    const cfg = parseConfig({
      allow_all_users: true,
      default_cwd: '/tmp',
      allowed_cwd_roots: ['/tmp'],
    });

    await sessionCommand(
      'start /tmp',
      meta,
      { cfg, pool, replier: { replyCard } } as never,
    );

    expect(pool.getMeta(topicThreadKey(meta.chatId, meta.threadId))).toBeDefined();
    expect(pool.getMeta(threadKey({ chatId: meta.chatId, senderId: meta.senderId }))).toBeUndefined();
    expect(replyCard).toHaveBeenCalledWith(
      meta.messageId,
      expect.any(Object),
      { inThread: true },
    );
  });

  it('拒绝不存在的 API profile，而不是静默回落全局默认', async () => {
    const pool = makePool();
    const cfg = parseConfig({
      allow_all_users: true,
      admin_users: [meta.senderId],
      default_cwd: '/tmp',
      allowed_cwd_roots: ['/tmp'],
    });
    const result = await sessionCommand(
      'start /tmp --profile ghost',
      meta,
      {
        cfg,
        pool,
        replier: {},
        apiProfiles: {
          get: () => undefined,
          available: () => true,
          list: () => [{ name: 'valid' }],
        },
      } as never,
    );
    expect(result).toContain('未知 API profile');
    expect(pool.list()).toHaveLength(0);
  });
});

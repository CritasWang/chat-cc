import { describe, expect, it, vi } from 'vitest';
import { buildCardActionHandler } from '../../src/feishu/card-action.js';
import { SessionPoolCapacityError, topicThreadKey } from '../../src/engine/pool.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

describe('话题卡片回调', () => {
  it('审批不依赖 thread_id REST 补查', async () => {
    const approvalResolver = vi.fn(() => 'resolved' as const);
    const resolveThreadId = vi.fn(async () => { throw new Error('network down'); });
    const handler = buildCardActionHandler({
      router: { dispatch: vi.fn() } as never,
      deps: {} as never,
      approvalResolver,
      isAllowed: () => true,
      resolveThreadId,
    });

    const result = await handler({
      event: {
        operator: { open_id: 'ou_x' },
        open_chat_id: 'oc_x',
        open_message_id: 'om_card',
        action: { value: { cmd: '__approve', args: 'req-1', decision: 'allow' } },
      },
    });

    expect(result.toast?.content).toContain('已允许');
    expect(approvalResolver).toHaveBeenCalledOnce();
    expect(resolveThreadId).not.toHaveBeenCalled();
  });

  it('补齐卡片消息 thread_id 后允许关闭当前话题会话', async () => {
    const target = topicThreadKey('oc_x', 'omt_x');
    const stop = vi.fn(async () => true);
    const pool = {
      getMeta: (key: string) => key === target ? { cwd: '/tmp' } : undefined,
      list: () => [{ threadKey: target, cwd: '/tmp', lastUsed: new Date(), active: true }],
      listByScope: () => [],
      stop,
    };
    const handler = buildCardActionHandler({
      router: { dispatch: vi.fn() } as never,
      deps: { pool } as never,
      approvalResolver: () => 'missing',
      isAllowed: () => true,
      resolveThreadId: async () => 'omt_x',
      renderRefreshCard: async () => ({}),
    });

    await handler({
      event: {
        operator: { open_id: 'ou_x' },
        open_chat_id: 'oc_x',
        open_message_id: 'om_card',
        action: { value: { cmd: 'session', args: `stop ${target}`, refresh: 'status' } },
      },
    });

    expect(stop).toHaveBeenCalledWith(target, { keepMeta: false, reason: 'destroy' });
  });

  it('激活预热会话超限时返回可操作提示', async () => {
    const target = 'oc_x:ou_x:default';
    const renderRefreshCard = vi.fn(async () => ({}));
    const pool = {
      getMeta: (key: string) => key === target ? { cwd: '/tmp' } : undefined,
      get: () => undefined,
      list: () => [{ threadKey: target, cwd: '/tmp', lastUsed: new Date(), active: false }],
      listByScope: () => [{ threadKey: target, cwd: '/tmp', lastUsed: new Date(), active: false }],
      start: () => { throw new SessionPoolCapacityError(20); },
    };
    const handler = buildCardActionHandler({
      router: { dispatch: vi.fn() } as never,
      deps: { pool } as never,
      approvalResolver: () => 'missing',
      isAllowed: () => true,
      renderRefreshCard,
    });

    const result = await handler({
      event: {
        operator: { open_id: 'ou_x' },
        open_chat_id: 'oc_x',
        open_message_id: 'om_card',
        action: { value: { cmd: 'session', args: 'switch default', refresh: 'session_list' } },
      },
    });

    expect(result.toast?.content).toContain('活跃会话已达上限');
    expect(renderRefreshCard).not.toHaveBeenCalled();
  });
});

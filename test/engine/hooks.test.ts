import { describe, expect, it, vi } from 'vitest';
import { createApprovalGate } from '../../src/engine/hooks.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

const spec = {
  requestId: 'req-1',
  toolName: 'Bash',
  toolInputPreview: '{}',
  threadKey: 'oc_x:ou_owner:default',
  requesterId: 'ou_owner',
  chatId: 'oc_x',
};

describe('ApprovalGate 身份绑定', () => {
  it('只允许请求发起人或管理员审批', async () => {
    const replier = {
      sendCard: vi.fn(async () => 'om_approval'),
      patchCard: vi.fn(async () => true),
    };
    const gate = createApprovalGate(replier as never);
    const decision = gate.request(spec, 'oc_x', 5_000);
    await Promise.resolve();

    expect(gate.resolve('req-1', 'allow', { senderId: 'ou_other', chatId: 'oc_x' })).toBe('forbidden');
    expect(gate.resolve('req-1', 'allow', { senderId: 'ou_owner', chatId: 'oc_x' })).toBe('resolved');
    await expect(decision).resolves.toBe('allow');
  });

  it('审批卡发送失败立即 deny', async () => {
    const gate = createApprovalGate({
      sendCard: vi.fn(async () => undefined),
      patchCard: vi.fn(async () => true),
    } as never);
    await expect(gate.request({ ...spec, requestId: 'req-2' }, 'oc_x', 5_000)).resolves.toBe('deny');
  });

  it('话题审批卡使用 reply_in_thread 投递', async () => {
    const replier = {
      sendCard: vi.fn(async () => 'om_direct'),
      replyCard: vi.fn(async () => 'om_thread'),
      patchCard: vi.fn(async () => true),
    };
    const gate = createApprovalGate(replier as never);
    const decision = gate.request(
      { ...spec, requestId: 'req-topic' },
      'oc_x',
      5_000,
      { rootMessageId: 'om_root', inThread: true },
    );
    await Promise.resolve();

    expect(replier.replyCard).toHaveBeenCalledWith(
      'om_root',
      expect.any(Object),
      { inThread: true },
    );
    expect(replier.sendCard).not.toHaveBeenCalled();
    expect(gate.resolve('req-topic', 'deny', { senderId: 'ou_owner', chatId: 'oc_x' })).toBe('resolved');
    await expect(decision).resolves.toBe('deny');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { runMessageJob } from '../../src/feishu/client.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

const meta = {
  messageId: 'om_x',
  chatId: 'oc_x',
  chatType: 'group',
  senderId: 'ou_x',
  mentionBot: true,
};

describe('runMessageJob receipt boundary', () => {
  it('进入 Router 前失败会撤销 receipt，允许 WS 重投', async () => {
    const revoke = vi.fn();
    await runMessageJob(
      meta,
      { messageReceipts: { accept: () => true, revoke } },
      'test',
      async () => { throw new Error('resolve failed'); },
    );
    expect(revoke).toHaveBeenCalledWith(meta.messageId);
  });

  it('标记已进入 Router 后失败不撤销，避免重复执行副作用', async () => {
    const revoke = vi.fn();
    await runMessageJob(
      meta,
      { messageReceipts: { accept: () => true, revoke } },
      'test',
      async (markDispatched) => {
        markDispatched();
        throw new Error('reply failed after side effect');
      },
    );
    expect(revoke).not.toHaveBeenCalled();
  });
});

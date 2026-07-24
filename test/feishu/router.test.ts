import { describe, expect, it, vi } from 'vitest';
import { Router } from '../../src/feishu/router.js';

describe('Router topic replies', () => {
  it('命令文本结果显式 reply_in_thread', async () => {
    const replyCard = vi.fn(async () => 'om_reply');
    const router = new Router(
      { replyCard, replyText: vi.fn() } as never,
      {} as never,
    );
    router.register('echo', async () => 'ok');

    await router.dispatch('/echo', {
      messageId: 'om_root',
      chatId: 'oc_x',
      chatType: 'group',
      senderId: 'ou_x',
      mentionBot: true,
      threadId: 'omt_x',
    });

    expect(replyCard).toHaveBeenCalledWith(
      'om_root',
      expect.any(Object),
      { inThread: true },
    );
  });
});

import { describe, expect, it } from 'vitest';
import { stopCommand } from '../../src/commands/stop.js';

const meta = {
  messageId: 'om_x',
  chatId: 'oc_x',
  chatType: 'group',
  senderId: 'ou_x',
  mentionBot: true,
};

describe('/stop ask key', () => {
  it('允许当前用户自己的 /ask 卡片中断键通过鉴权', async () => {
    const result = await stopCommand(
      'ask:oc_x:ou_x:om_ask',
      meta,
      { pool: {} as never, streamer: {} as never } as never,
    );
    expect(result).toBe('该一次性提问已结束或不存在');
  });

  it('拒绝其他用户的 /ask 键', async () => {
    const result = await stopCommand(
      'ask:oc_x:ou_other:om_ask',
      meta,
      { pool: {} as never, streamer: {} as never } as never,
    );
    expect(result).toContain('无权');
  });
});

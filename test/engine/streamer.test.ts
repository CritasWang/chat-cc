import { describe, expect, it, vi } from 'vitest';
import { LiveStreamer, splitByParagraph } from '../../src/engine/streamer.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

function fakeReplier(opts: { failFirstSend?: boolean } = {}) {
  let sends = 0;
  return {
    sendCard: vi.fn(async () => {
      sends += 1;
      if (opts.failFirstSend && sends === 1) throw new Error('send failed');
      return `om_${sends}`;
    }),
    replyCard: vi.fn(async () => 'om_reply'),
    patchCard: vi.fn(async () => true),
    sendText: vi.fn(async () => 'om_text'),
    replyText: vi.fn(async () => 'om_reply_text'),
  };
}

describe('LiveStreamer 生命周期隔离', () => {
  it('discardTurn 会清除尚未消费的旧话题回复锚点', async () => {
    const replier = fakeReplier();
    const streamer = new LiveStreamer({ replier: replier as never, throttleMs: 1 });
    const key = 'oc_x::t-omt_old';
    streamer.setReplyTarget(key, { rootMessageId: 'om_old', inThread: true });
    await streamer.discardTurn(key);

    await streamer.onEvent('oc_x', key, { kind: 'assistant-text', text: 'new' });
    await streamer.onEvent('oc_x', key, { kind: 'result', ok: true, text: 'new', durationMs: 1 });

    expect(replier.replyCard).not.toHaveBeenCalled();
    expect(replier.sendCard).toHaveBeenCalled();
  });

  it('带外通知回到话题且不消费直播卡锚点', async () => {
    const replier = fakeReplier();
    const streamer = new LiveStreamer({ replier: replier as never, throttleMs: 1 });
    const key = 'oc_x::t-omt_x';
    streamer.setReplyTarget(key, { rootMessageId: 'om_root', inThread: true });

    await streamer.sendNoticeCard(key, 'oc_x', {});
    await streamer.onEvent('oc_x', key, { kind: 'result', ok: true, text: 'done', durationMs: 1 });

    expect(replier.replyCard).toHaveBeenNthCalledWith(1, 'om_root', {}, { inThread: true });
    expect(replier.replyCard).toHaveBeenCalledTimes(2);
    expect(replier.sendCard).not.toHaveBeenCalled();
  });

  it('会话重启 discardTurn 会撤销旧一代的中断抑制', async () => {
    const replier = fakeReplier();
    const streamer = new LiveStreamer({ replier: replier as never, throttleMs: 1 });
    const key = 'oc_x:ou_x:default';
    await streamer.markInterrupted(key);
    await streamer.discardTurn(key);

    await streamer.onEvent('oc_x', key, { kind: 'result', ok: false, text: 'new generation error', durationMs: 1 });

    expect(replier.sendCard).toHaveBeenCalled();
  });

  it('idle /stop 未收到终态时，新 prompt 边界会清除中断抑制', async () => {
    const replier = fakeReplier();
    const streamer = new LiveStreamer({ replier: replier as never, throttleMs: 1 });
    const key = 'oc_x:ou_x:default';
    await streamer.markInterrupted(key);

    streamer.beginTurn(key);
    await streamer.onEvent('oc_x', key, { kind: 'result', ok: true, text: 'next turn', durationMs: 1 });

    expect(replier.sendCard).toHaveBeenCalled();
  });

  it('首次发卡异常时仍发送终态降级消息且不向 engine 抛错', async () => {
    const replier = fakeReplier({ failFirstSend: true });
    const streamer = new LiveStreamer({ replier: replier as never, throttleMs: 1 });

    await expect(
      streamer.onEvent('oc_x', 'oc_x:ou_x:default', {
        kind: 'result',
        ok: false,
        text: 'startup failed',
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(replier.sendCard).toHaveBeenCalledTimes(2);
  });
});

describe('splitByParagraph', () => {
  it('空白内容不生成空卡片分片', () => {
    expect(splitByParagraph('', 100)).toEqual([]);
    expect(splitByParagraph('   \n', 100)).toEqual([]);
  });
});

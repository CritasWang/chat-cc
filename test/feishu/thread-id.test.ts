import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildThreadResolver } from '../../src/feishu/thread-id.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

afterEach(() => {
  vi.useRealTimers();
});

describe('ThreadResolver fail-closed', () => {
  it('chat_mode 连续查询失败时抛错，不按普通群降级', async () => {
    vi.useFakeTimers();
    const getChat = vi.fn(async () => { throw new Error('network down'); });
    const resolver = buildThreadResolver({
      im: { v1: { chat: { get: getChat }, message: { get: vi.fn() } } },
    } as never);

    const resolving = resolver.resolve('oc_x', 'om_x');
    const assertion = expect(resolving).rejects.toThrow('network down');
    await vi.runAllTimersAsync();
    await assertion;
    expect(getChat).toHaveBeenCalledTimes(3);
  });

  it('已确认普通群时不补查 message.thread_id', async () => {
    const getMessage = vi.fn();
    const resolver = buildThreadResolver({
      im: {
        v1: {
          chat: { get: vi.fn(async () => ({ data: { chat_mode: 'group' } })) },
          message: { get: getMessage },
        },
      },
    } as never);

    await expect(resolver.resolve('oc_x', 'om_x')).resolves.toBeUndefined();
    expect(getMessage).not.toHaveBeenCalled();
  });
});

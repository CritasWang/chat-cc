import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { Replier } from '../../src/feishu/replier.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Replier 幂等重试', () => {
  it('sendText 瞬时失败重试时复用同一个 uuid', async () => {
    const calls: Array<{ data: { uuid?: string } }> = [];
    const client = {
      im: {
        v1: {
          message: {
            create: async (payload: { data: { uuid?: string } }) => {
              calls.push(payload);
              if (calls.length === 1) throw Object.assign(new Error('temporary'), { status: 503 });
              return { data: { message_id: 'om_ok' } };
            },
          },
        },
      },
    } as unknown as Lark.Client;

    const pending = new Replier(client).sendText('oc_x', 'hello', 1);
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe('om_ok');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.data.uuid).toBeTruthy();
    expect(calls[1]!.data.uuid).toBe(calls[0]!.data.uuid);
  });
});

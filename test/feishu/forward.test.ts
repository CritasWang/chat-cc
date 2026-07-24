import { describe, it, expect } from 'vitest';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { fetchForwardTranscript } from '../../src/feishu/forward.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

function fakeClient(items: unknown[]): Lark.Client {
  return {
    im: {
      v1: {
        message: {
          get: async () => ({ data: { items } }),
        },
      },
    },
  } as unknown as Lark.Client;
}

describe('fetchForwardTranscript', () => {
  it('解析 text 子消息并按时间排序', async () => {
    const client = fakeClient([
      { message_id: 'parent', msg_type: 'merge_forward', create_time: '3' },
      {
        message_id: 'm2',
        msg_type: 'text',
        create_time: '2',
        sender: { id: 'ou_bbbbbb' },
        body: { content: JSON.stringify({ text: '第二条' }) },
      },
      {
        message_id: 'm1',
        msg_type: 'text',
        create_time: '1',
        sender: { id: 'ou_aaaaaa' },
        body: { content: JSON.stringify({ text: '第一条' }) },
      },
    ]);
    const out = await fetchForwardTranscript(client, 'parent');
    expect(out).toBe('用户(…aaaaaa): 第一条\n用户(…bbbbbb): 第二条');
  });

  it('post 富文本提取标题与文本节点', async () => {
    const post = {
      title: '周报',
      content: [
        [
          { tag: 'text', text: '本周完成 ' },
          { tag: 'a', text: '链接', href: 'https://x.y' },
        ],
      ],
    };
    const client = fakeClient([
      { message_id: 'parent', msg_type: 'merge_forward' },
      {
        message_id: 'm1',
        msg_type: 'post',
        create_time: '1',
        sender: { id: 'ou_x' },
        body: { content: JSON.stringify(post) },
      },
    ]);
    const out = await fetchForwardTranscript(client, 'parent');
    expect(out).toContain('周报');
    expect(out).toContain('本周完成 链接(https://x.y)');
  });

  it('interactive 卡片提取文本，媒体类型用占位符', async () => {
    const card = { header: { title: { tag: 'plain_text', content: '部署完成' } }, body: {} };
    const client = fakeClient([
      { message_id: 'parent', msg_type: 'merge_forward' },
      {
        message_id: 'm1',
        msg_type: 'interactive',
        create_time: '1',
        sender: { id: 'ou_x' },
        body: { content: JSON.stringify(card) },
      },
      { message_id: 'm2', msg_type: 'image', create_time: '2', sender: { id: 'ou_x' }, body: {} },
    ]);
    const out = await fetchForwardTranscript(client, 'parent');
    expect(out).toContain('[卡片] 部署完成');
    expect(out).toContain('[图片]');
  });

  it('无子消息返回 undefined', async () => {
    const client = fakeClient([{ message_id: 'parent', msg_type: 'merge_forward' }]);
    expect(await fetchForwardTranscript(client, 'parent')).toBeUndefined();
  });

  it('API 异常返回 undefined', async () => {
    const client = {
      im: { v1: { message: { get: async () => { throw new Error('403'); } } } },
    } as unknown as Lark.Client;
    expect(await fetchForwardTranscript(client, 'parent')).toBeUndefined();
  });
});

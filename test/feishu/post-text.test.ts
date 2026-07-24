import { describe, expect, it } from 'vitest';
import { extractPostText } from '../../src/feishu/client.js';

describe('extractPostText', () => {
  it('提取多段落富文本（用户用列表格式触发 text→post 升级的真实场景）', () => {
    const raw = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'text', text: '1. ', style: [] },
          { tag: 'text', text: '建立成任务', style: [] },
        ],
        [
          { tag: 'text', text: '2. ', style: [] },
          { tag: 'text', text: '逐个处理', style: [] },
        ],
      ],
    });
    expect(extractPostText(raw)).toBe('1. 建立成任务\n2. 逐个处理');
  });

  it('带标题时标题作为首行', () => {
    const raw = JSON.stringify({
      title: '需求',
      content: [[{ tag: 'text', text: '正文' }]],
    });
    expect(extractPostText(raw)).toBe('需求\n正文');
  });

  it('链接展开为 text (href)，@提及与图片忽略', () => {
    const raw = JSON.stringify({
      content: [
        [
          { tag: 'at', user_id: 'ou_x', text: '@bot' },
          { tag: 'text', text: '看下 ' },
          { tag: 'a', text: '文档', href: 'https://example.com' },
          { tag: 'img', image_key: 'img_x' },
        ],
      ],
    });
    expect(extractPostText(raw)).toBe('看下 文档 (https://example.com)');
  });

  it('code_block 保留内容', () => {
    const raw = JSON.stringify({
      content: [[{ tag: 'code_block', text: 'const a = 1;' }]],
    });
    expect(extractPostText(raw)).toBe('const a = 1;');
  });

  it('非法 JSON 返回空串', () => {
    expect(extractPostText('not-json')).toBe('');
  });

  it('空 content 返回空串', () => {
    expect(extractPostText(JSON.stringify({ content: [] }))).toBe('');
  });
});

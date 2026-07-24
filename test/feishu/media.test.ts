import { describe, expect, it } from 'vitest';
import { resolveResourceSpec, mediaPrompt } from '../../src/feishu/media.js';

describe('resolveResourceSpec', () => {
  it('image 消息取 image_key，生成 .png 名', () => {
    const spec = resolveResourceSpec('image', JSON.stringify({ image_key: 'img_v3_abc123' }));
    expect(spec).toEqual({ type: 'image', key: 'img_v3_abc123', name: 'img_v3_abc123.png' });
  });

  it('file 消息保留原始文件名', () => {
    const spec = resolveResourceSpec('file', JSON.stringify({ file_key: 'file_x', file_name: 'report.xlsx' }));
    expect(spec).toEqual({ type: 'file', key: 'file_x', name: 'report.xlsx' });
  });

  it('file_name 带路径分隔符时防穿越（只留 basename）', () => {
    const spec = resolveResourceSpec('file', JSON.stringify({ file_key: 'file_x', file_name: '../../etc/passwd' }));
    expect(spec?.name).toBe('passwd.bin');
  });

  it('file 无扩展名时补 .bin', () => {
    const spec = resolveResourceSpec('file', JSON.stringify({ file_key: 'file_x', file_name: 'README' }));
    expect(spec?.name).toBe('README.bin');
  });

  it('缺 key / 非法 JSON / 不支持类型返回 undefined', () => {
    expect(resolveResourceSpec('image', JSON.stringify({}))).toBeUndefined();
    expect(resolveResourceSpec('image', 'not-json')).toBeUndefined();
    expect(resolveResourceSpec('sticker', JSON.stringify({ file_key: 'x' }))).toBeUndefined();
  });
});

describe('mediaPrompt', () => {
  it('图片与文件分别生成含路径的 prompt', () => {
    expect(mediaPrompt({ kind: 'image', path: '/tmp/a.png', name: 'a.png' })).toContain('/tmp/a.png');
    const p = mediaPrompt({ kind: 'file', path: '/tmp/r.xlsx', name: 'r.xlsx' });
    expect(p).toContain('r.xlsx');
    expect(p).toContain('/tmp/r.xlsx');
  });
});

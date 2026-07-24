import { describe, it, expect } from 'vitest';
import {
  threadKey,
  parseThreadKey,
  topicThreadKey,
  isTopicThreadKey,
  normalizeSlot,
  DEFAULT_SLOT,
} from '../../src/engine/pool.js';

describe('threadKey 编解码', () => {
  it('3 段往返', () => {
    const tk = threadKey({ chatId: 'oc_1', senderId: 'ou_2', slot: 'work' });
    expect(tk).toBe('oc_1:ou_2:work');
    expect(parseThreadKey(tk)).toEqual({ chatId: 'oc_1', senderId: 'ou_2', slot: 'work' });
  });

  it('旧 2 段兼容为 default slot', () => {
    expect(parseThreadKey('oc_1:ou_2')).toEqual({ chatId: 'oc_1', senderId: 'ou_2', slot: DEFAULT_SLOT });
  });
});

describe('topicThreadKey 话题会话', () => {
  it('senderId 为空（话题内共享会话），slot 带 t- 前缀', () => {
    const tk = topicThreadKey('oc_1', 'omt_abc123');
    expect(tk).toBe('oc_1::t-omt_abc123');
    const parsed = parseThreadKey(tk);
    expect(parsed.chatId).toBe('oc_1');
    expect(parsed.senderId).toBe('');
    expect(parsed.slot).toBe('t-omt_abc123');
  });

  it('isTopicThreadKey 识别', () => {
    expect(isTopicThreadKey(topicThreadKey('oc_1', 'omt_x'))).toBe(true);
    expect(isTopicThreadKey('oc_1:ou_2:default')).toBe(false);
    expect(isTopicThreadKey('oc_1:ou_2:work')).toBe(false);
  });

  it('同一话题幂等生成同一 key', () => {
    expect(topicThreadKey('oc_1', 'omt_x')).toBe(topicThreadKey('oc_1', 'omt_x'));
  });

  it('threadId 特殊字符被规范化', () => {
    const tk = topicThreadKey('oc_1', 'omt/we?ird');
    expect(parseThreadKey(tk).slot).toBe('t-omt-we-ird');
  });
});

describe('normalizeSlot', () => {
  it('清理非法字符并折叠连字符', () => {
    expect(normalizeSlot('a b//c')).toBe('a-b-c');
    expect(normalizeSlot('')).toBe(DEFAULT_SLOT);
  });
});

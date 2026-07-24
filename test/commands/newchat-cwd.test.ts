import { describe, expect, it, vi } from 'vitest';
import { extractCwdTarget, newCommand } from '../../src/commands/newchat.js';
import { parseConfig } from '../../src/config.js';
import { SessionPoolCapacityError } from '../../src/engine/pool.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

describe('extractCwdTarget', () => {
  it('提取 @别名', () => {
    expect(extractCwdTarget('@chatcc-v3')).toEqual({ rest: '', target: '@chatcc-v3' });
  });

  it('提取绝对路径', () => {
    expect(extractCwdTarget('/Volumes/data/sources/tech-stack')).toEqual({
      rest: '',
      target: '/Volumes/data/sources/tech-stack',
    });
  });

  it('提取 ~/ 路径', () => {
    expect(extractCwdTarget('~/work/foo')).toEqual({ rest: '', target: '~/work/foo' });
  });

  it('群名 + 别名共存，群名保留', () => {
    expect(extractCwdTarget('我的任务 @alias')).toEqual({ rest: '我的任务', target: '@alias' });
    expect(extractCwdTarget('@alias 我的任务')).toEqual({ rest: '我的任务', target: '@alias' });
  });

  it('群名 + 路径共存，群名保留', () => {
    expect(extractCwdTarget('紧急修复 /tmp/proj')).toEqual({ rest: '紧急修复', target: '/tmp/proj' });
  });

  it('纯群名不误判', () => {
    expect(extractCwdTarget('日常讨论群')).toEqual({ rest: '日常讨论群' });
    expect(extractCwdTarget('')).toEqual({ rest: '' });
  });

  it('词中间的 @ 或 / 不误判', () => {
    expect(extractCwdTarget('a@b')).toEqual({ rest: 'a@b' });
    expect(extractCwdTarget('7/17 复盘')).toEqual({ rest: '7/17 复盘' });
  });
});

describe('/new chat 会话容量', () => {
  const meta = {
    messageId: 'om_x',
    chatId: 'oc_source',
    chatType: 'group',
    senderId: 'ou_admin',
    mentionBot: true,
  };
  const cfg = parseConfig({
    allow_all_users: true,
    admin_users: [meta.senderId],
    default_cwd: '/tmp',
    allowed_cwd_roots: ['/tmp'],
    max_active_sessions: 20,
  });

  it('已达容量上限时不创建空群', async () => {
    const createChat = vi.fn(async () => 'oc_new');
    const result = await newCommand('chat 测试群', meta, {
      cfg,
      pool: {
        activeThreadKeyOf: () => undefined,
        getMeta: () => undefined,
        hasStartCapacity: () => false,
      },
      replier: { createChat },
    } as never);

    expect(result).toContain('活跃会话已达上限');
    expect(createChat).not.toHaveBeenCalled();
  });

  it('建群期间容量被占满时明确标记新群未启动', async () => {
    const sendCard = vi.fn(async () => 'om_notice');
    const result = await newCommand('chat 竞态群', meta, {
      cfg,
      pool: {
        activeThreadKeyOf: () => undefined,
        getMeta: () => undefined,
        hasStartCapacity: () => true,
        start: () => { throw new SessionPoolCapacityError(20); },
      },
      replier: {
        createChat: vi.fn(async () => 'oc_new'),
        sendCard,
      },
    } as never);

    expect(result).toContain('会话尚未启动');
    expect(sendCard).toHaveBeenCalledWith('oc_new', expect.any(Object));
  });
});

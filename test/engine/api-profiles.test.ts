import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiProfileStore, parseProfilesZsh, maskToken } from '../../src/engine/api-profiles.js';
import { initLogger } from '../../src/logger.js';

initLogger('error');

const SAMPLE = `# Claude Code API 多配置切换器
typeset -gA CC_PROFILES
CC_PROFILES=(
  bytecat "sk-Lq7pmAAA|https://api.bytecat.example"
  timecho "sk-SUeMvBBB|https://coding.example.com"
  # foo   "sk-xxxxxxxx|https://api.foo.com"
  4router 'sk-Z3XIzCCC|https://4router.example'
)

CC_DEFAULT_PROFILE=timecho

ccuse() { ... }
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'api-profiles-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseProfilesZsh', () => {
  it('解析 profiles、跳过注释、识别默认项', () => {
    const { profiles, defaultName } = parseProfilesZsh(SAMPLE);
    expect([...profiles.keys()].sort()).toEqual(['4router', 'bytecat', 'timecho']);
    expect(profiles.get('bytecat')).toEqual({
      name: 'bytecat',
      token: 'sk-Lq7pmAAA',
      baseUrl: 'https://api.bytecat.example',
    });
    expect(defaultName).toBe('timecho');
  });

  it('空内容 / 无 CC_PROFILES 块返回空', () => {
    expect(parseProfilesZsh('').profiles.size).toBe(0);
    expect(parseProfilesZsh('export FOO=1').profiles.size).toBe(0);
  });

  it('默认项不存在时忽略', () => {
    const { defaultName } = parseProfilesZsh('CC_PROFILES=(\n a "t|u"\n)\nCC_DEFAULT_PROFILE=ghost');
    expect(defaultName).toBeUndefined();
  });
});

describe('ApiProfileStore', () => {
  function makeStore(): ApiProfileStore {
    const src = join(dir, 'cc-profiles.zsh');
    writeFileSync(src, SAMPLE);
    return new ApiProfileStore(src, join(dir, 'state.json'));
  }

  it('数据源不存在时 available=false，envOverrides 为空（零配置兼容）', () => {
    const store = new ApiProfileStore(join(dir, 'missing.zsh'), join(dir, 'state.json'));
    expect(store.available()).toBe(false);
    expect(store.current()).toBeUndefined();
    expect(store.envOverrides()).toEqual({});
    expect(store.use('any')).toBe(false);
  });

  it('默认使用 CC_DEFAULT_PROFILE', () => {
    const store = makeStore();
    expect(store.available()).toBe(true);
    expect(store.current()?.name).toBe('timecho');
    expect(store.envOverrides()).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-SUeMvBBB',
      ANTHROPIC_BASE_URL: 'https://coding.example.com',
    });
  });

  it('use 切换并持久化，新实例恢复选择', () => {
    const store = makeStore();
    expect(store.use('bytecat')).toBe(true);
    expect(store.current()?.name).toBe('bytecat');
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual({ name: 'bytecat' });

    const store2 = new ApiProfileStore(join(dir, 'cc-profiles.zsh'), join(dir, 'state.json'));
    expect(store2.current()?.name).toBe('bytecat');
  });

  it('use 未知名称返回 false 不改变当前', () => {
    const store = makeStore();
    expect(store.use('ghost')).toBe(false);
    expect(store.current()?.name).toBe('timecho');
  });

  it('reload 重新读数据源', () => {
    const src = join(dir, 'cc-profiles.zsh');
    writeFileSync(src, SAMPLE);
    const store = new ApiProfileStore(src, join(dir, 'state.json'));
    expect(store.list()).toHaveLength(3);
    writeFileSync(src, 'CC_PROFILES=(\n only "sk-1|https://only.example"\n)\n');
    store.reload();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.name).toBe('only');
  });
});

describe('maskToken', () => {
  it('只留前缀', () => {
    expect(maskToken('sk-1234567890abcdef')).toBe('sk-1234567…');
    expect(maskToken('short')).toBe('shor…');
  });
});

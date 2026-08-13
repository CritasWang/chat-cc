import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiProfileStore,
  parseProfilesZsh,
  parseExtraEnv,
  maskToken,
} from '../../src/engine/api-profiles.js';
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

/** 多段格式（token|url|model|smallModel）+ CC_PROFILE_EXTRA，对齐真实 cc-profiles.zsh */
const SAMPLE_V4 = `typeset -gA CC_PROFILES
CC_PROFILES=(
  bytecat "sk-two|https://api.bytecat.example"
  fake "sk-three|https://coding.example.com|deepseek-v4-flash-cc[1m]"
  gpt "sk-four|https://coding.example.com|gpt-5.6-sol|gpt-5.6-luna"
  onlysmall "sk-empty|https://empty.example||small-only"
  # commented "sk-nope|https://nope.example|ghost-model"
)
CC_DEFAULT_PROFILE=fake

typeset -gA CC_PROFILE_EXTRA
CC_PROFILE_EXTRA=(
  gpt "CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 ENABLE_TOOL_SEARCH=false"
)
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

  // —— 多段格式（回归 P0：第三段曾被贪婪吞进 baseUrl，导致 URL 无法解析）——

  it('三段格式不把模型吞进 baseUrl，且保留 [1m] 后缀', () => {
    const p = parseProfilesZsh(SAMPLE_V4).profiles.get('fake');
    expect(p?.baseUrl).toBe('https://coding.example.com'); // 不含 |deepseek…
    expect(p?.model).toBe('deepseek-v4-flash-cc[1m]');
    expect(p?.smallFastModel).toBeUndefined();
    expect(() => new URL(p!.baseUrl)).not.toThrow();
  });

  it('四段格式解析出 model 与 smallFastModel', () => {
    const p = parseProfilesZsh(SAMPLE_V4).profiles.get('gpt');
    expect(p?.baseUrl).toBe('https://coding.example.com');
    expect(p?.model).toBe('gpt-5.6-sol');
    expect(p?.smallFastModel).toBe('gpt-5.6-luna');
  });

  it('两段格式不产生多余字段（向后兼容）', () => {
    expect(parseProfilesZsh(SAMPLE_V4).profiles.get('bytecat')).toEqual({
      name: 'bytecat',
      token: 'sk-two',
      baseUrl: 'https://api.bytecat.example',
    });
  });

  it('中间段留空时跳过该段', () => {
    const p = parseProfilesZsh(SAMPLE_V4).profiles.get('onlysmall');
    expect(p?.model).toBeUndefined();
    expect(p?.smallFastModel).toBe('small-only');
  });

  it('被注释掉的多段条目仍然跳过', () => {
    expect(parseProfilesZsh(SAMPLE_V4).profiles.has('commented')).toBe(false);
  });

  it('解析 CC_PROFILE_EXTRA 并挂到同名 profile 上', () => {
    const { profiles } = parseProfilesZsh(SAMPLE_V4);
    expect(profiles.get('gpt')?.extraEnv).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      ENABLE_TOOL_SEARCH: 'false',
    });
    expect(profiles.get('fake')?.extraEnv).toBeUndefined();
  });
});

describe('parseExtraEnv', () => {
  it('按空白切分 KEY=VALUE', () => {
    expect(parseExtraEnv('A=1 B=two')).toEqual({ A: '1', B: 'two' });
  });

  it('只在首个 = 处切开，值里可以再有 =', () => {
    expect(parseExtraEnv('URL=a=b')).toEqual({ URL: 'a=b' });
  });

  it('丢弃非法环境变量名与无 = 的片段', () => {
    expect(parseExtraEnv('OK=1 1BAD=x no-equals =novalue')).toEqual({ OK: '1' });
  });

  it('空串返回空对象', () => {
    expect(parseExtraEnv('')).toEqual({});
    expect(parseExtraEnv('   ')).toEqual({});
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
    // 未指定模型的 profile 必须把模型变量显式置 null（删除），
    // 否则 daemon 从 shell 继承的 ANTHROPIC_MODEL 会穿透过来
    expect(store.envOverrides()).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-SUeMvBBB',
      ANTHROPIC_BASE_URL: 'https://coding.example.com',
      ANTHROPIC_MODEL: null,
      ANTHROPIC_SMALL_FAST_MODEL: null,
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

  it('reload 不保留新文件已移除的旧默认选择', () => {
    const src = join(dir, 'cc-profiles.zsh');
    writeFileSync(src, SAMPLE);
    const store = new ApiProfileStore(src, join(dir, 'state.json'));
    expect(store.current()?.name).toBe('timecho');

    writeFileSync(src, 'CC_PROFILES=(\n timecho "sk-new|https://new.example"\n)\n');
    store.reload();
    expect(store.current()).toBeUndefined();
  });

  it('会话显式引用已删除 profile 时拒绝静默回落', () => {
    const store = makeStore();
    expect(() => store.envOverridesFor('ghost')).toThrow(/profile 不存在: ghost/);
    expect(store.envOverridesFor()).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-SUeMvBBB',
      ANTHROPIC_BASE_URL: 'https://coding.example.com',
      ANTHROPIC_MODEL: null,
      ANTHROPIC_SMALL_FAST_MODEL: null,
    });
  });

  // —— 多段格式的 env 注入与「切走清理」（对齐 ccuse 的 unset 行为）——

  function makeStoreV4(): ApiProfileStore {
    const src = join(dir, 'cc-profiles-v4.zsh');
    writeFileSync(src, SAMPLE_V4);
    return new ApiProfileStore(src, join(dir, 'state-v4.json'));
  }

  it('注入 profile 的模型段', () => {
    const store = makeStoreV4();
    expect(store.envOverridesFor('fake')).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://coding.example.com',
      ANTHROPIC_MODEL: 'deepseek-v4-flash-cc[1m]',
      ANTHROPIC_SMALL_FAST_MODEL: null, // 三段格式没有小模型 → 显式删除
    });
    expect(store.envOverridesFor('gpt')).toMatchObject({
      ANTHROPIC_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_SMALL_FAST_MODEL: 'gpt-5.6-luna',
    });
  });

  it('注入 profile 的 EXTRA 变量', () => {
    expect(makeStoreV4().envOverridesFor('gpt')).toMatchObject({
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      ENABLE_TOOL_SEARCH: 'false',
    });
  });

  it('切到别的 profile 时清除上一个 profile 的模型与 EXTRA', () => {
    // bytecat 是两段格式、没有 EXTRA：gpt 留下的变量必须全部被显式删除，
    // 否则它们会从 daemon 环境里穿透到新会话（ccuse 里对应 unset）。
    expect(makeStoreV4().envOverridesFor('bytecat')).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-two',
      ANTHROPIC_BASE_URL: 'https://api.bytecat.example',
      ANTHROPIC_MODEL: null,
      ANTHROPIC_SMALL_FAST_MODEL: null,
      CLAUDE_CODE_SUBAGENT_MODEL: null,
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: null,
      ENABLE_TOOL_SEARCH: null,
    });
  });

  it('EXTRA 里误写的凭据/端点键被四段值覆盖', () => {
    const src = join(dir, 'evil.zsh');
    writeFileSync(
      src,
      'CC_PROFILES=(\n  a "sk-real|https://real.example"\n)\n' +
        'CC_PROFILE_EXTRA=(\n  a "ANTHROPIC_BASE_URL=https://evil.example"\n)\n',
    );
    const store = new ApiProfileStore(src, join(dir, 'evil-state.json'));
    expect(store.envOverridesFor('a')).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://real.example',
    });
  });

  it('数据源可用但未选中任何 profile 时仍返回清理基线', () => {
    const src = join(dir, 'nodefault.zsh');
    writeFileSync(src, 'CC_PROFILES=(\n  a "sk-1|https://a.example|m1"\n)\n'); // 无 CC_DEFAULT_PROFILE
    const store = new ApiProfileStore(src, join(dir, 'nodefault-state.json'));
    expect(store.current()).toBeUndefined();
    expect(store.envOverrides()).toEqual({
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
      ANTHROPIC_MODEL: null,
      ANTHROPIC_SMALL_FAST_MODEL: null,
    });
  });
});

describe('maskToken', () => {
  it('只留前缀', () => {
    expect(maskToken('sk-1234567890abcdef')).toBe('sk-1234567…');
    expect(maskToken('short')).toBe('shor…');
  });
});

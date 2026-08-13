import { describe, expect, it } from 'vitest';
import { buildAgentEnv, buildClaudeEnv, resolveSessionModel } from '../../src/agent/env.js';

describe('buildAgentEnv', () => {
  it('继承完整环境，API profile auth token 会移除冲突的 ANTHROPIC_API_KEY', () => {
    const env = buildAgentEnv(
      {
        ANTHROPIC_AUTH_TOKEN: 'profile-token',
        ANTHROPIC_BASE_URL: 'https://profile.example',
      },
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'old-key',
        AWS_PROFILE: 'production',
        GITHUB_TOKEN: 'github-token',
      },
    );

    expect(env).toEqual({
      PATH: '/bin',
      AWS_PROFILE: 'production',
      GITHUB_TOKEN: 'github-token',
      ANTHROPIC_AUTH_TOKEN: 'profile-token',
      ANTHROPIC_BASE_URL: 'https://profile.example',
    });
  });

  it('null 表示删除继承来的变量', () => {
    const env = buildAgentEnv(
      { ANTHROPIC_MODEL: null, CLAUDE_CODE_SUBAGENT_MODEL: null },
      { PATH: '/bin', ANTHROPIC_MODEL: '继承值', CLAUDE_CODE_SUBAGENT_MODEL: 'x' },
    );
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('删除不存在的 key 不报错', () => {
    expect(buildAgentEnv({ NOPE: null }, { PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('空串是「设为空」而非删除', () => {
    expect(buildAgentEnv({ FOO: '' }, { FOO: 'old' })).toEqual({ FOO: '' });
  });

  it('token 被置 null 时不误删 ANTHROPIC_API_KEY', () => {
    // 无 profile（全 null 基线）的场景：不应牵连用户自己配的 API key
    const env = buildAgentEnv(
      { ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_BASE_URL: null },
      { ANTHROPIC_API_KEY: 'user-key', ANTHROPIC_AUTH_TOKEN: 'stale' },
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'user-key' });
  });
});

describe('resolveSessionModel', () => {
  const all = {
    sessionModel: 's',
    profileModel: 'p',
    globalModel: 'g',
    bootModel: 'b',
  };

  it('会话级优先级最高', () => {
    expect(resolveSessionModel(all)).toEqual({ value: 's', source: 'session' });
  });

  it('逐层回落：profile → global → boot → default', () => {
    const { sessionModel: _s, ...noSession } = all;
    expect(resolveSessionModel(noSession)).toEqual({ value: 'p', source: 'profile' });

    const { profileModel: _p, ...noProfile } = noSession;
    expect(resolveSessionModel(noProfile)).toEqual({ value: 'g', source: 'global' });

    const { globalModel: _g, ...noGlobal } = noProfile;
    expect(resolveSessionModel(noGlobal)).toEqual({ value: 'b', source: 'boot' });

    expect(resolveSessionModel({})).toEqual({ source: 'default' });
  });

  it('纯空白视为未设置', () => {
    expect(resolveSessionModel({ sessionModel: '   ', globalModel: 'g' })).toEqual({
      value: 'g',
      source: 'global',
    });
  });

  it('保留模型名里的 [1m] 后缀', () => {
    expect(resolveSessionModel({ profileModel: 'deepseek-v4-flash-cc[1m]' })).toEqual({
      value: 'deepseek-v4-flash-cc[1m]',
      source: 'profile',
    });
  });
});

describe('buildClaudeEnv', () => {
  it('profile 指定模型时覆盖 daemon 继承值', () => {
    const { env, model } = buildClaudeEnv({
      profileOverrides: { ANTHROPIC_MODEL: 'profile-model' },
      globalModel: 'global-model',
      bootModel: 'boot-model',
      source: { ANTHROPIC_MODEL: 'daemon 启动时继承的残留值' },
    });
    expect(env['ANTHROPIC_MODEL']).toBe('profile-model');
    expect(model).toEqual({ value: 'profile-model', source: 'profile' });
  });

  it('profile 未指定模型时回落到全局配置，而不是会话/daemon 的残留值', () => {
    const { env, model } = buildClaudeEnv({
      profileOverrides: { ANTHROPIC_MODEL: null }, // 基线：profile 没有第三段
      globalModel: 'global-model',
      bootModel: 'boot-model',
      source: { ANTHROPIC_MODEL: 'daemon 启动时继承的残留值' },
    });
    expect(env['ANTHROPIC_MODEL']).toBe('global-model');
    expect(model.source).toBe('global');
  });

  it('全都没配时回落 daemon 启动快照（老部署行为不变）', () => {
    const { env, model } = buildClaudeEnv({
      profileOverrides: { ANTHROPIC_MODEL: null },
      globalModel: '',
      bootModel: 'boot-model',
      source: { ANTHROPIC_MODEL: 'stale' },
    });
    expect(env['ANTHROPIC_MODEL']).toBe('boot-model');
    expect(model.source).toBe('boot');
  });

  it('连启动快照都没有时，从子进程环境里彻底删掉 ANTHROPIC_MODEL', () => {
    // 这是「切了 profile 但模型没变」的根因回归：绝不能让继承值穿透。
    const { env, model } = buildClaudeEnv({
      profileOverrides: { ANTHROPIC_MODEL: null },
      globalModel: '',
      bootModel: '',
      source: { PATH: '/bin', ANTHROPIC_MODEL: 'daemon 启动时继承的残留值' },
    });
    expect(env).toEqual({ PATH: '/bin' });
    expect(model).toEqual({ source: 'default' });
  });

  it('profile 的 EXTRA 与小模型一并注入', () => {
    const { env } = buildClaudeEnv({
      profileOverrides: {
        ANTHROPIC_MODEL: 'gpt-5.6-sol',
        ANTHROPIC_SMALL_FAST_MODEL: 'gpt-5.6-luna',
        CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol',
      },
      source: { PATH: '/bin' },
    });
    expect(env).toEqual({
      PATH: '/bin',
      ANTHROPIC_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_SMALL_FAST_MODEL: 'gpt-5.6-luna',
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol',
    });
  });
});

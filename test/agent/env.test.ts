import { describe, expect, it } from 'vitest';
import { buildAgentEnv } from '../../src/agent/env.js';

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
});

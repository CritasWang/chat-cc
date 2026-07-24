import { describe, expect, it } from 'vitest';
import { buildAgentEnv } from '../../src/agent/env.js';

describe('buildAgentEnv', () => {
  it('API profile auth token 会移除继承的 ANTHROPIC_API_KEY', () => {
    const env = buildAgentEnv(
      ['PATH', 'ANTHROPIC_API_KEY'],
      {
        ANTHROPIC_AUTH_TOKEN: 'profile-token',
        ANTHROPIC_BASE_URL: 'https://profile.example',
      },
      { PATH: '/bin', ANTHROPIC_API_KEY: 'old-key' },
    );

    expect(env).toEqual({
      PATH: '/bin',
      ANTHROPIC_AUTH_TOKEN: 'profile-token',
      ANTHROPIC_BASE_URL: 'https://profile.example',
    });
  });
});

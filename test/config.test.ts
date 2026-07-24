import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('config migration', () => {
  it('兼容忽略已移除的历史字段', () => {
    const cfg = parseConfig({
      agent_env_allowlist: ['PATH', 'AWS_PROFILE'],
      claude_bin: '/legacy/claude',
      hook_port: 8765,
    });
    expect('agent_env_allowlist' in cfg).toBe(false);
    expect('claude_bin' in cfg).toBe(false);
    expect('hook_port' in cfg).toBe(false);
  });

  it('其他未知键仍 fail-fast', () => {
    expect(() => parseConfig({ unexpected_option: true })).toThrow();
  });
});

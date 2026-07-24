/**
 * 为 Agent 子进程构造最小环境，避免把飞书密钥、云凭据等 daemon 环境整体暴露给工具调用。
 * API profile 等显式覆盖始终保留；其余变量只有在 allowlist 中才会透传。
 */
export function buildAgentEnv(
  allowlist: readonly string[],
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  // cc-profiles 使用 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL。若同时继承了
  // ANTHROPIC_API_KEY，Claude Code 可能优先使用旧 key，导致“切了 profile 但仍走原端点”。
  if (Object.prototype.hasOwnProperty.call(overrides, 'ANTHROPIC_AUTH_TOKEN')) {
    delete env['ANTHROPIC_API_KEY'];
  }
  return { ...env, ...overrides };
}

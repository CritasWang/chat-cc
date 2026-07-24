/** 为 Agent 子进程继承 daemon 完整环境，并叠加会话级 API profile 覆盖。 */
export function buildAgentEnv(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  // cc-profiles 使用 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL。若同时继承了
  // ANTHROPIC_API_KEY，Claude Code 可能优先使用旧 key，导致“切了 profile 但仍走原端点”。
  if (Object.prototype.hasOwnProperty.call(overrides, 'ANTHROPIC_AUTH_TOKEN')) {
    delete env['ANTHROPIC_API_KEY'];
  }
  return { ...env, ...overrides };
}

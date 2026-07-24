/**
 * Codex CLI 参数构建（借鉴 lark-bridge agent/codex/argv.ts）。
 *
 * - `codex exec --json … -`：prompt 走 stdin（`-`），避免 argv 特殊字符问题
 * - resume：`codex exec … resume --json <threadId> -`
 * - `approval_policy="never"`：无人值守（桥接场景没有终端可交互审批）
 * - `--skip-git-repo-check`：允许在非 git 目录运行
 */

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: CodexSandboxMode;
  threadId?: string;
  /** 转发给 `codex exec --model`；缺省用 Codex 默认模型 */
  model?: string;
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${String(input.sandbox)}`);
  }

  const globalFlags = [
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  if (input.threadId) {
    return ['exec', ...globalFlags, 'resume', '--json', input.threadId, '-'];
  }
  return ['exec', '--json', ...globalFlags, '-'];
}

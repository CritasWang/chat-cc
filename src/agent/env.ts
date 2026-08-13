/**
 * Agent 子进程的环境构造。
 *
 * SDK 的 `Options.env` 会**整体替换**子进程环境（不与 process.env 合并），
 * 所以这里必须自带一份完整快照 —— 也正因如此，「删掉某个继承来的变量」
 * 只需要不把它拷进结果，不需要额外的 unset 机制。
 */

/** `null` 表示**删除**该变量（而非设置为空串）。 */
export type EnvOverrides = Record<string, string | null>;

/**
 * daemon 启动那一刻的 ANTHROPIC_MODEL 快照，作为模型优先级链的兜底层。
 *
 * 取快照而不是每次读 process.env，是为了让「全局默认模型」有确定语义：
 * 它只取决于 daemon 起来那一刻的环境，不随后续任何 profile 切换漂移。
 */
export const BOOT_ANTHROPIC_MODEL = process.env['ANTHROPIC_MODEL']?.trim() || undefined;

/** 为 Agent 子进程继承 daemon 完整环境，并叠加会话级覆盖（null = 删除）。 */
export function buildAgentEnv(
  overrides: EnvOverrides = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  // cc-profiles 使用 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL。若同时继承了
  // ANTHROPIC_API_KEY，Claude Code 可能优先使用旧 key，导致“切了 profile 但仍走原端点”。
  // 仅当确实注入了 token 时才删 —— token 被显式置 null（无 profile）时不动它。
  if (typeof overrides['ANTHROPIC_AUTH_TOKEN'] === 'string') {
    delete env['ANTHROPIC_API_KEY'];
  }
  for (const [key, value] of Object.entries(overrides)) {
    // 严格判 null：'' 是「设置为空串」，不是删除。
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

export type ModelSource = 'session' | 'profile' | 'global' | 'boot' | 'default';

export interface ResolvedModel {
  /** undefined = 不指定模型，交给 Claude Code 用内置默认 */
  value?: string;
  source: ModelSource;
}

/**
 * 模型优先级链 —— 全项目唯一定义，四条 Agent 路径共用：
 *
 *   会话级覆盖 > profile 第三段 > config claude_model > daemon 启动快照 > 不指定
 */
export function resolveSessionModel(opts: {
  sessionModel?: string;
  profileModel?: string;
  globalModel?: string;
  bootModel?: string;
}): ResolvedModel {
  const chain: Array<[ModelSource, string | undefined]> = [
    ['session', opts.sessionModel],
    ['profile', opts.profileModel],
    ['global', opts.globalModel],
    ['boot', opts.bootModel],
  ];
  for (const [source, raw] of chain) {
    const value = raw?.trim();
    if (value) return { value, source };
  }
  return { source: 'default' };
}

/**
 * Claude 侧统一的环境构造入口（会话池 / /ask / 文档评论共用）。
 *
 * 关键点：模型层**永远显式给出** ANTHROPIC_MODEL（具体值或 null），绝不留给
 * “继承 daemon 环境”。否则 daemon 从用户 shell 继承的 ANTHROPIC_MODEL 会
 * 穿透所有 profile，导致“切了 profile 但模型没变”。
 */
export function buildClaudeEnv(opts: {
  profileOverrides?: EnvOverrides;
  sessionModel?: string;
  globalModel?: string;
  /** 显式传入可覆盖启动快照（测试用）；不传则用 BOOT_ANTHROPIC_MODEL */
  bootModel?: string;
  source?: NodeJS.ProcessEnv;
}): { env: Record<string, string>; model: ResolvedModel } {
  const profileOverrides = opts.profileOverrides ?? {};
  const profileModel = profileOverrides['ANTHROPIC_MODEL'];
  const model = resolveSessionModel({
    sessionModel: opts.sessionModel,
    // profile 未指定模型时这里是 null（基线删除标记），不参与优先级
    profileModel: typeof profileModel === 'string' ? profileModel : undefined,
    globalModel: opts.globalModel,
    bootModel: opts.bootModel === undefined ? BOOT_ANTHROPIC_MODEL : opts.bootModel,
  });
  const env = buildAgentEnv(
    { ...profileOverrides, ANTHROPIC_MODEL: model.value ?? null },
    opts.source ?? process.env,
  );
  return { env, model };
}

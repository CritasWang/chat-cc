import type { Config } from '../config.js';
import type { SessionPool } from '../engine/pool.js';
import type { ApiProfileStore } from '../engine/api-profiles.js';
import { BOOT_ANTHROPIC_MODEL, resolveSessionModel, type ResolvedModel } from '../agent/env.js';

export interface ModelDeps {
  cfg: Config;
  pool: SessionPool;
  apiProfiles?: ApiProfileStore;
}

/**
 * 某个会话最终生效的模型。必须与 main.ts 会话工厂里 buildClaudeEnv 的解析一致：
 * 会话覆盖 > profile 第三段 > cfg.claude_model > daemon 启动快照 > 内置默认。
 *
 * @param sessionModelOverride 预演用：传 `{ value: x }` 计算“改成 x 之后”的结果，
 *        传 `{ value: undefined }` 计算“清除会话覆盖之后”的结果；不传则读 meta 现值。
 */
export function effectiveModelOf(
  threadKey: string,
  deps: ModelDeps,
  sessionModelOverride?: { value?: string },
): ResolvedModel {
  const m = deps.pool.getMeta(threadKey);
  const sessionModel = sessionModelOverride ? sessionModelOverride.value : m?.model;
  // Codex 有独立的模型链：profile 的 ANTHROPIC_MODEL 对 `codex exec` 没有意义
  const engine = m?.agent ?? deps.cfg.agent;
  if (engine === 'codex') {
    return resolveSessionModel({ sessionModel, globalModel: deps.cfg.codex_model });
  }
  const profile = m?.apiProfile ? deps.apiProfiles?.get(m.apiProfile) : deps.apiProfiles?.current();
  return resolveSessionModel({
    sessionModel,
    profileModel: profile?.model,
    globalModel: deps.cfg.claude_model,
    bootModel: BOOT_ANTHROPIC_MODEL,
  });
}

/** 不含任何会话级覆盖时的全局默认模型（Claude 侧） */
export function globalModelOf(deps: { cfg: Config; apiProfiles?: ApiProfileStore }): ResolvedModel {
  return resolveSessionModel({
    profileModel: deps.apiProfiles?.current()?.model,
    globalModel: deps.cfg.claude_model,
    bootModel: BOOT_ANTHROPIC_MODEL,
  });
}

const SOURCE_LABEL: Record<ResolvedModel['source'], string> = {
  session: '会话级',
  profile: 'profile',
  global: '全局配置',
  boot: 'daemon 启动环境',
  default: '内置默认',
};

/** 渲染成飞书卡片里的一段可读文本 */
export function describeModel(r: ResolvedModel, opts: { withSource?: boolean } = {}): string {
  if (!r.value) return '（未指定 → Claude Code 内置默认）';
  return `\`${r.value}\`` + (opts.withSource === false ? '' : `（来源：${SOURCE_LABEL[r.source]}）`);
}

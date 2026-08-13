import { type CommandFn } from './types.js';
import { isPrivileged } from '../policy/owner.js';
import { currentSessionKey } from './session-context.js';
import { describeModel, effectiveModelOf, globalModelOf } from './model-context.js';
import { saveRuntimeOverride } from '../engine/runtime-overrides.js';
import { log } from '../logger.js';

const DENY_MSG = '⛔ 模型查看与切换仅管理员可用（config `admin_users` 可配置）';

const USAGE =
  '`/model <名字>` 只切当前会话 · 加 `--global` 切全局默认 · ' +
  '`/model clear` 回归默认 · `/model list` 看可选';

/**
 * /model [<name>|clear|list|use <name>] [--global]
 *
 * 三层语义（与 /profile、/danger 一致）：
 * - `<name>`            → 只切**当前会话**；优先在线切换（不打断运行中的任务），
 *                         引擎不支持或失败时回退重启（上下文经 resume 保留）
 * - `<name> --global`   → 写 config `claude_model` 并持久化，随后更新所有
 *                         「跟随全局」的会话；有会话级覆盖、或 profile 自带模型的不动
 * - `clear`             → 清除当前会话覆盖，回归 profile/全局
 * - `clear --global`    → 清空全局默认，回归 profile/启动环境/内置默认
 *
 * 模型优先级：会话覆盖 > profile 第三段 > claude_model > daemon 启动快照 > 内置默认。
 * 注意小模型（ANTHROPIC_SMALL_FAST_MODEL）只由 profile 第四段决定，本命令不改它。
 */
export const modelCommand: CommandFn = async (args, meta, { cfg, pool, apiProfiles }) => {
  if (!isPrivileged(cfg, meta.senderId)) {
    log().warn({ senderId: meta.senderId }, '/model 权限拒绝');
    return DENY_MSG;
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const isGlobal = tokens.some((t) => t.toLowerCase() === '--global');
  const parts = tokens.filter((t) => t.toLowerCase() !== '--global');
  // 模型 id 大小写敏感 —— 只对首个 token 做 lowercase 用来识别关键词，值一律原样保留
  const head = (parts[0] ?? '').toLowerCase();
  const keyword = head === 'list' || head === 'clear' || head === 'use' ? head : undefined;
  const sub = parts.length === 0 ? 'status' : (keyword ?? 'set');
  // `use` 是转义写法，供模型名恰好叫 list/clear 时使用
  const name = sub === 'use' ? parts[1] : sub === 'set' ? parts[0] : undefined;

  const deps = { cfg, pool, apiProfiles };
  const activeTk = currentSessionKey(meta, pool);
  const sessionOverride = activeTk ? pool.getMeta(activeTk)?.model : undefined;

  /** 全局默认变更后，更新所有「跟随全局」的活跃会话 */
  const applyToFollowers = async (before: Map<string, string | undefined>): Promise<string> => {
    let inplace = 0;
    let restarted = 0;
    let failed = 0;
    let skipped = 0;
    for (const s of pool.list()) {
      if (!s.active) continue; // 预热态：下次懒恢复时自然生效
      const m = pool.getMeta(s.threadKey);
      if (!m) continue;
      if (m.model) {
        skipped += 1; // 有会话级覆盖，不受全局影响
        continue;
      }
      const after = effectiveModelOf(s.threadKey, deps);
      if (after.value === before.get(s.threadKey)) {
        skipped += 1; // profile 自带模型，优先级更高 → 实际没变
        continue;
      }
      try {
        const how = await pool.setSessionModel(s.threadKey, undefined, after.value);
        if (how === 'inplace') inplace += 1;
        else if (how === 'restarted') restarted += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        log().warn({ err, threadKey: s.threadKey }, '全局模型切换时会话更新失败');
      }
    }
    return (
      `已更新会话：在线生效 ${inplace} · 重启生效 ${restarted}` +
      (skipped > 0 ? ` · 未受影响 ${skipped}（有会话级覆盖或 profile 已指定模型）` : '') +
      (failed > 0 ? ` · ${failed} 个更新失败` : '')
    );
  };

  /** 改全局默认前先记录各会话的实际生效值，才能判断谁真的受影响 */
  const snapshotBefore = (): Map<string, string | undefined> => {
    const before = new Map<string, string | undefined>();
    for (const s of pool.list()) {
      if (!s.active) continue;
      before.set(s.threadKey, effectiveModelOf(s.threadKey, deps).value);
    }
    return before;
  };

  const howNote = (how: 'inplace' | 'restarted' | 'meta' | 'missing'): string =>
    how === 'inplace'
      ? '，在线生效（运行中的任务不受影响）'
      : how === 'restarted'
        ? '，重启生效（此前运行中的任务已被中断，上下文保留）'
        : how === 'meta'
          ? '，会话当前未运行，下次唤醒时生效'
          : '';

  switch (sub) {
    case 'status': {
      const global = globalModelOf({ cfg, apiProfiles });
      const eff = activeTk ? effectiveModelOf(activeTk, deps) : undefined;
      return (
        '**模型**\n' +
        `🌐 全局默认: ${describeModel(global)}\n` +
        `📍 当前会话: ${sessionOverride ? `\`${sessionOverride}\`` : '（跟随全局）'}\n` +
        (eff ? `✅ 实际生效: ${describeModel(eff)}\n` : '') +
        `\n${USAGE}`
      );
    }

    case 'list': {
      const lines = [`🌐 全局默认: ${describeModel(globalModelOf({ cfg, apiProfiles }))}`];
      if (activeTk) lines.push(`📍 当前会话: ${describeModel(effectiveModelOf(activeTk, deps))}`);

      const withModel = (apiProfiles?.list() ?? []).filter((p) => p.model || p.smallFastModel);
      if (withModel.length > 0) {
        lines.push('', '**各 profile 指定的模型**');
        for (const p of withModel) {
          lines.push(
            `· **${p.name}** → \`${p.model ?? '(未指定)'}\`` +
              (p.smallFastModel ? ` · 小模型 \`${p.smallFastModel}\`` : ''),
          );
        }
      }
      if (cfg.codex_model) lines.push('', `Codex 会话默认: \`${cfg.codex_model}\``);
      lines.push(
        '',
        '模型名以当前 API 端点支持的为准（第三方端点各不相同），直接 `/model <名字>` 切换。',
      );
      return lines.join('\n');
    }

    case 'clear': {
      if (isGlobal) {
        const before = snapshotBefore();
        (cfg as { claude_model: string }).claude_model = '';
        saveRuntimeOverride('claude_model', '');
        const applied = await applyToFollowers(before);
        return (
          `✅ 全局默认模型已清除 → ${describeModel(globalModelOf({ cfg, apiProfiles }))}\n` +
          applied
        );
      }
      if (!activeTk) return '当前无活跃会话。清除全局默认请用 `/model clear --global`';
      if (sessionOverride === undefined) {
        return '当前会话没有模型覆盖（本就跟随 profile/全局）';
      }
      const next = effectiveModelOf(activeTk, deps, { value: undefined });
      const how = await pool.setSessionModel(activeTk, undefined, next.value);
      if (how === 'missing') return '❌ 会话在切换期间已被关闭';
      return `✅ 当前会话已回归默认 → ${describeModel(next)}${howNote(how)}`;
    }

    case 'use':
    case 'set': {
      if (!name) return `用法: ${USAGE}`;

      if (isGlobal) {
        const before = snapshotBefore();
        (cfg as { claude_model: string }).claude_model = name;
        saveRuntimeOverride('claude_model', name); // 落盘，daemon 重启后仍生效
        const applied = await applyToFollowers(before);
        return `✅ **全局**默认模型已设为 \`${name}\`\n${applied}`;
      }

      if (!activeTk) {
        return (
          `当前无活跃会话。切全局默认请用 \`/model ${name} --global\`，` +
          '或先 `/session start` 开一个会话'
        );
      }
      const how = await pool.setSessionModel(activeTk, name, name);
      if (how === 'missing') return '❌ 会话在切换期间已被关闭';
      return (
        `✅ **当前会话**模型已切到 \`${name}\`${howNote(how)}\n` +
        '其他会话不受影响 · `/model clear` 可回归默认'
      );
    }

    default:
      return `用法: ${USAGE}`;
  }
};

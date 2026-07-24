import { loadConfig, resolveConfigPath } from '../config.js';
import { saveRuntimeOverride } from '../engine/runtime-overrides.js';
import { applyFeedTag, removeFeedTag } from '../feishu/feed-tag.js';
import { isPrivileged } from '../policy/owner.js';
import { log } from '../logger.js';
import { type CommandFn } from './types.js';
import { currentSessionKey } from './session-context.js';

const DENY_MSG = '⛔ 该命令仅管理员可用（config `admin_users` 可配置管理员）';

/**
 * /danger [on|off|toggle|clear] [--global]
 *
 * 两层语义（与 /profile 一致）：
 * - `on|off|toggle`            → 只切**当前会话**的权限模式（仅重启该会话）
 * - `on|off|toggle --global`   → 切全局默认，重启所有未设会话级覆盖的会话
 * - `clear`                    → 清除当前会话的覆盖，回归全局默认
 * 会话级选择随会话持久化。
 */
export const dangerCommand: CommandFn = async (args, meta, { cfg, pool }) => {
  if (!isPrivileged(cfg, meta.senderId)) {
    log().warn({ senderId: meta.senderId }, '/danger 权限拒绝');
    return DENY_MSG;
  }
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const isGlobal = tokens.includes('--global');
  const sub = tokens.filter((t) => t !== '--global')[0] ?? '';
  const activeTk = currentSessionKey(meta, pool);
  const sessionOverride = activeTk ? pool.getMeta(activeTk)?.danger : undefined;

  // —— 状态查询 ——
  if (!sub) {
    const globalStr = cfg.claude_danger_mode ? '⚠️ 开启' : '🔒 关闭';
    const sessionStr =
      sessionOverride === undefined
        ? '（跟随全局）'
        : sessionOverride
          ? '⚠️ 开启（会话覆盖）'
          : '🔒 关闭（会话覆盖）';
    return (
      `**Danger 模式**\n全局默认: ${globalStr}\n当前会话: ${sessionStr}\n\n` +
      '用法: `/danger on|off|toggle` 只切当前会话 · 加 `--global` 切全局 · `/danger clear` 会话回归全局'
    );
  }

  // —— 清除会话覆盖 ——
  if (sub === 'clear') {
    if (!activeTk) return '当前无活跃会话';
    if (sessionOverride === undefined) return '当前会话没有权限模式覆盖（本就跟随全局）';
    const how = await pool.setSessionDanger(activeTk, undefined, cfg.claude_danger_mode);
    if (how === 'missing') return '❌ 会话在切换期间已被关闭';
    if (cfg.danger_tag && !cfg.claude_danger_mode) {
      void removeFeedTag(cfg.lark_cli_bin, cfg.danger_tag, meta.chatId);
    }
    const note = how === 'restarted' ? '（重启生效，此前运行中的任务已被中断）' : '';
    return `✅ 当前会话已回归全局默认（${cfg.claude_danger_mode ? '⚠️ Danger 开启' : '🔒 审批模式'}），上下文保留${note}`;
  }

  if (sub !== 'on' && sub !== 'off' && sub !== 'toggle') {
    return '用法: /danger [on|off|toggle|clear] [--global]';
  }

  // —— 全局切换 ——
  if (isGlobal) {
    const next = sub === 'toggle' ? !cfg.claude_danger_mode : sub === 'on';
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = next;
    saveRuntimeOverride('claude_danger_mode', next); // 落盘，daemon 重启后仍生效
    log().warn({ dangerMode: next }, 'danger mode 全局切换');
    // 对所有跟随全局的会话生效：优先在线切换（不打断运行中的任务），失败回退重启；
    // 带会话级覆盖的不动
    let inplace = 0;
    let restarted = 0;
    let failed = 0;
    for (const s of pool.list()) {
      if (!s.active) continue;
      if (pool.getMeta(s.threadKey)?.danger !== undefined) continue;
      try {
        const how = await pool.setSessionDanger(s.threadKey, undefined, next);
        if (how === 'inplace') inplace += 1;
        else if (how === 'restarted') restarted += 1;
        else if (how === 'missing') failed += 1;
      } catch (err) {
        failed += 1;
        log().warn({ err, threadKey: s.threadKey, dangerMode: next }, '全局 danger 切换时会话更新失败');
      }
    }
    const summary =
      `在线生效 ${inplace} 个${restarted > 0 ? ` · 重启生效 ${restarted} 个（其运行中任务已被中断）` : ''}` +
      (failed > 0 ? ` · ${failed} 个会话状态已变化，未能当场更新` : '');
    return next
      ? `⚠️ **全局** Danger 模式已开启（跟随全局的会话：${summary}）\n带会话级覆盖的会话不受影响 · \`/danger off --global\` 关闭`
      : `🔒 **全局** Danger 模式已关闭（恢复审批流；跟随全局的会话：${summary}）`;
  }

  // —— 会话级切换 ——
  if (!activeTk) {
    return `当前无活跃会话。切全局请用 \`/danger ${sub} --global\`，或先 /session start 开会话`;
  }
  const effective = sessionOverride ?? cfg.claude_danger_mode;
  const next = sub === 'toggle' ? !effective : sub === 'on';
  const how = await pool.setSessionDanger(activeTk, next, next);
  if (how === 'missing') return '❌ 会话在切换期间已被关闭';
  log().warn({ threadKey: activeTk, danger: next, how }, 'danger mode 会话级切换');
  // 群标签联动（best-effort，异步不阻塞回复）：on → 打 Danger 标签，off → 移除
  if (cfg.danger_tag) {
    void (next
      ? applyFeedTag(cfg.lark_cli_bin, cfg.danger_tag, meta.chatId)
      : removeFeedTag(cfg.lark_cli_bin, cfg.danger_tag, meta.chatId));
  }
  const note =
    how === 'inplace'
      ? '，在线生效（运行中的任务不受影响）'
      : how === 'restarted'
        ? '，重启生效（此前运行中的任务已被中断）'
        : '';
  return next
    ? `⚠️ **当前会话** Danger 模式已开启（跳过审批），上下文保留${note}\n其他会话不受影响 · \`/danger clear\` 回归全局`
    : `🔒 **当前会话** Danger 模式已关闭（恢复审批流），上下文保留${note}\n其他会话不受影响 · \`/danger clear\` 回归全局`;
};

export const reloadCommand: CommandFn = async (_args, meta, { cfg, requestRestart }) => {
  if (!isPrivileged(cfg, meta.senderId)) {
    log().warn({ senderId: meta.senderId }, '/reload 权限拒绝');
    return DENY_MSG;
  }
  const cfgPath = resolveConfigPath();
  try {
    loadConfig(cfgPath); // 严格 schema + 正则等完整校验；通过后再重启，不修改当前对象。
    const scheduled = requestRestart?.() ?? false;
    if (scheduled) {
      log().info({ path: cfgPath }, '配置校验通过，已安排 daemon 完整重启');
      return `♻️ 配置校验通过，daemon 即将完整重启\n来源: \`${cfgPath}\`\n\n所有组件会统一加载新配置。`;
    }
    log().info({ path: cfgPath }, '配置校验通过；当前为前台/开发模式，需手动重启');
    return `✅ 配置校验通过\n来源: \`${cfgPath}\`\n\n当前不是后台 daemon，请手动重启进程使配置生效。`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log().error({ err }, '配置重载失败');
    return `❌ 配置重载失败: ${msg}`;
  }
};

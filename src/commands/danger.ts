import { loadConfig, resolveConfigPath } from '../config.js';
import { saveRuntimeOverride } from '../engine/runtime-overrides.js';
import { applyFeedTag, removeFeedTag } from '../feishu/feed-tag.js';
import { isPrivileged } from '../policy/owner.js';
import { log } from '../logger.js';
import { senderKey, type CommandFn } from './types.js';

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
  const userKey = senderKey(meta);

  const activeTk = pool.activeThreadKeyOf(userKey);
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
    for (const s of pool.list()) {
      if (!s.active) continue;
      if (pool.getMeta(s.threadKey)?.danger !== undefined) continue;
      const sess = pool.get(s.threadKey);
      if (sess?.setDanger && (await sess.setDanger(next))) {
        inplace += 1;
        continue;
      }
      await pool.stop(s.threadKey, { keepMeta: true });
      const m = pool.getMeta(s.threadKey);
      pool.start(parseKey(s.threadKey), m?.cwd ?? '.');
      restarted += 1;
    }
    const summary =
      `在线生效 ${inplace} 个${restarted > 0 ? ` · 重启生效 ${restarted} 个（其运行中任务已被中断）` : ''}`;
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

/** threadKey 字符串 → ThreadKey 对象 */
function parseKey(tk: string): { chatId: string; senderId: string; slot: string } {
  const parts = tk.split(':');
  return {
    chatId: parts[0] ?? '',
    senderId: parts[1] ?? '',
    slot: parts.slice(2).join(':') || 'default',
  };
}

export const reloadCommand: CommandFn = async (_args, meta, { cfg }) => {
  if (!isPrivileged(cfg, meta.senderId)) {
    log().warn({ senderId: meta.senderId }, '/reload 权限拒绝');
    return DENY_MSG;
  }
  const cfgPath = resolveConfigPath();
  try {
    const { config: newCfg } = loadConfig(cfgPath);
    Object.assign(cfg, newCfg);
    log().info({ path: cfgPath }, '配置已重载');
    return `♻️ 配置已重载\n来源: \`${cfgPath}\`\n\n新配置对后续新建会话生效（已有会话不受影响）`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log().error({ err }, '配置重载失败');
    return `❌ 配置重载失败: ${msg}`;
  }
};

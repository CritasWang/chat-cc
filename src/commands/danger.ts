import { loadConfig, resolveConfigPath } from '../config.js';
import { log } from '../logger.js';
import type { CommandFn } from './types.js';

export const dangerCommand: CommandFn = async (args, _meta, { cfg, pool }) => {
  const sub = args.trim().toLowerCase();

  if (sub === 'on') {
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = true;
    log().warn('danger mode 已开启（运行时切换）');
    // 重启所有正在运行的会话，使其以 danger 模式重建
    await pool.restartAll();
    return '⚠️ Danger 模式：**已开启**\n跳过所有权限检查，所有会话已自动重启\n下条消息将在 Danger 模式下重新连接\n\n使用 `/danger off` 关闭';
  }

  if (sub === 'off') {
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = false;
    log().info('danger mode 已关闭（运行时切换）');
    // 重启所有正在运行的会话，使其以审批模式重建
    await pool.restartAll();
    return '🔒 Danger 模式：**已关闭**\n恢复工具审批流，所有会话已自动重启\n下条消息将在审批模式下重新连接';
  }

  if (sub === 'toggle') {
    const next = !cfg.claude_danger_mode;
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = next;
    log().info({ dangerMode: next }, 'danger mode toggled');
    // 重启所有正在运行的会话以确保新模式立即生效
    await pool.restartAll();
    return next
      ? '⚠️ Danger 模式：**已开启**\n所有会话已自动重启，下条消息在 Danger 模式下重连'
      : '🔒 Danger 模式：**已关闭**\n所有会话已自动重启，下条消息在审批模式下重连';
  }

  const status = cfg.claude_danger_mode
    ? '⚠️ 当前 Danger 模式：**开启**'
    : '🔒 当前 Danger 模式：**关闭**';
  return `${status}\n\n用法: /danger <on|off|toggle>`;
};

export const reloadCommand: CommandFn = async (_args, _meta, { cfg }) => {
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

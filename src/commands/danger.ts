import { loadConfig } from '../config.js';
import { existsSync } from 'node:fs';
import { log } from '../logger.js';
import type { CommandFn } from './types.js';

export const dangerCommand: CommandFn = async (args, meta, { cfg, pool }) => {
  const sub = args.trim().toLowerCase();

  if (sub === 'on') {
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = true;
    log().warn('danger mode 已开启（运行时切换）');
    // 断开当前活跃会话，下条消息会以 danger 模式创建新会话（保留 sessionId 可恢复上下文）
    const userKey = meta.senderId || meta.chatId;
    const active = pool.getActive(userKey);
    if (active) {
      await pool.stop(active.threadKey, { keepMeta: true });
    }
    return '⚠️ Danger 模式：**已开启**\n跳过所有权限检查，当前会话已自动断开\n下条消息将在 Danger 模式下重新连接\n\n使用 `/danger off` 关闭';
  }

  if (sub === 'off') {
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = false;
    log().info('danger mode 已关闭（运行时切换）');
    // 断开当前活跃会话，下条消息会以正常审批流创建新会话
    const userKey = meta.senderId || meta.chatId;
    const active = pool.getActive(userKey);
    if (active) {
      await pool.stop(active.threadKey, { keepMeta: true });
    }
    return '🔒 Danger 模式：**已关闭**\n恢复工具审批流，当前会话已自动断开\n下条消息将在审批模式下重新连接';
  }

  if (sub === 'toggle') {
    const next = !cfg.claude_danger_mode;
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = next;
    log().info({ dangerMode: next }, 'danger mode toggled');
    // 断开当前活跃会话以确保新模式立即生效
    const userKey = meta.senderId || meta.chatId;
    const active = pool.getActive(userKey);
    if (active) {
      await pool.stop(active.threadKey, { keepMeta: true });
    }
    return next
      ? '⚠️ Danger 模式：**已开启**\n当前会话已自动断开，下条消息在 Danger 模式下重连'
      : '🔒 Danger 模式：**已关闭**\n当前会话已自动断开，下条消息在审批模式下重连';
  }

  const status = cfg.claude_danger_mode
    ? '⚠️ 当前 Danger 模式：**开启**'
    : '🔒 当前 Danger 模式：**关闭**';
  return `${status}\n\n用法: /danger <on|off|toggle>`;
};

export const reloadCommand: CommandFn = async (_args, _meta, { cfg }) => {
  const cfgPath =
    process.env['CHATCC_CONFIG'] ??
    (existsSync('./config.local.yaml') ? './config.local.yaml' : './config.yaml');
  try {
    const newCfg = loadConfig(cfgPath);
    Object.assign(cfg, newCfg);
    log().info({ path: cfgPath }, '配置已重载');
    return `♻️ 配置已重载\n来源: \`${cfgPath}\`\n\n新配置对后续新建会话生效（已有会话不受影响）`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log().error({ err }, '配置重载失败');
    return `❌ 配置重载失败: ${msg}`;
  }
};

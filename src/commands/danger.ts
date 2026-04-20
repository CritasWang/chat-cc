import { loadConfig } from '../config.js';
import { existsSync } from 'node:fs';
import { log } from '../logger.js';
import type { CommandFn } from './types.js';

export const dangerCommand: CommandFn = async (args, _meta, { cfg }) => {
  const sub = args.trim().toLowerCase();

  if (sub === 'on') {
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = true;
    log().warn('danger mode 已开启（运行时切换）');
    return '⚠️ Danger 模式：**已开启**\n跳过所有权限检查，新会话生效\n\n使用 `/danger off` 关闭';
  }

  if (sub === 'off') {
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = false;
    log().info('danger mode 已关闭（运行时切换）');
    return '🔒 Danger 模式：**已关闭**\n恢复工具审批流，新会话生效';
  }

  if (sub === 'toggle') {
    const next = !cfg.claude_danger_mode;
    (cfg as { claude_danger_mode: boolean }).claude_danger_mode = next;
    log().info({ dangerMode: next }, 'danger mode toggled');
    return next
      ? '⚠️ Danger 模式：**已开启**\n新会话生效'
      : '🔒 Danger 模式：**已关闭**\n新会话生效';
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

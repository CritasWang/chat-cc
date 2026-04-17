import { execSync } from 'node:child_process';
import type { Config } from '../../config.js';
import type { SessionPool } from '../../engine/pool.js';
import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, cmdBtnRefresh, hr, md } from './base.js';

export function renderStatusCard(cfg: Config, pool: SessionPool): InteractiveCard {
  const sessions = pool.list();
  const activeCount = sessions.filter((s) => s.active).length;

  const sysLines: string[] = [];
  sysLines.push(`OS: \`${process.platform}/${process.arch}\``);
  try {
    const uptime = execSync('uptime', { encoding: 'utf8' }).trim();
    sysLines.push(`Uptime: \`${uptime}\``);
  } catch { /* ignore */ }
  sysLines.push(`默认目录: \`${cfg.default_cwd}\``);

  let sessionMd = '*(无活跃会话)*';
  if (sessions.length > 0) {
    const lines = sessions.map((s) => {
      const marker = s.active ? '🟢' : '⚪';
      const sid = s.sessionId ? s.sessionId.slice(0, 8) : '-';
      return `${marker} \`${s.threadKey}\` · sid \`${sid}\` · cwd \`${s.cwd}\``;
    });
    sessionMd = lines.join('\n');
  }

  let claudeVersion = '未安装或不在 PATH 中';
  try {
    claudeVersion = execSync('claude --version', { encoding: 'utf8' }).trim();
  } catch { /* ignore */ }

  const dangerStatus = cfg.claude_danger_mode
    ? '⚠️ Danger 模式：**开启**'
    : '🔒 Danger 模式：**关闭**';

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return card(cardHeader('📊 系统状态', 'indigo'), [
    md(`**🖥 系统**\n${sysLines.join('  ·  ')}`),
    hr(),
    md(`**🔄 会话 (${activeCount} 活跃 / ${sessions.length} 总)**\n${sessionMd}`),
    hr(),
    md(`**🔧 Claude Code 版本**  \`${claudeVersion}\``),
    hr(),
    md(dangerStatus),
    hr(),
    btnRow([
      cmdBtnRefresh('🔄 刷新', 'status', '', 'status', 'primary'),
      cmdBtn('📋 会话列表', 'session', 'list'),
      cmdBtn('❓ 帮助', 'help', ''),
    ]),
    md(`*⏱️ ${now}*`),
  ]);
}

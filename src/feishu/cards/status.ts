import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../config.js';
import type { SessionPool } from '../../engine/pool.js';
import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, cmdBtnRefresh, hr, md } from './base.js';

function getVersionInfo(): { version: string; commit: string; sdkVersion: string } {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(__dirname, '..', '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string;
      dependencies?: Record<string, string>;
    };
    let commit = 'unknown';
    try {
      commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 3000 }).trim();
    } catch { /* not a git repo or git not available */ }
    return {
      version: pkg.version ?? 'unknown',
      commit,
      sdkVersion: pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? 'unknown',
    };
  } catch {
    return { version: 'unknown', commit: 'unknown', sdkVersion: 'unknown' };
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}时`);
  if (m > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join('');
}

export function renderStatusCard(cfg: Config, pool: SessionPool, configPath?: string): InteractiveCard {
  const sessions = pool.list();
  const activeCount = sessions.filter((s) => s.active).length;
  const vi = getVersionInfo();

  const sysLines: string[] = [];
  sysLines.push(`**chat-cc** v${vi.version} (${vi.commit})`);
  sysLines.push(`SDK \`${vi.sdkVersion}\` · Node \`${process.version}\``);
  sysLines.push(`进程运行: \`${formatUptime(process.uptime())}\``);
  if (configPath) sysLines.push(`配置: \`${configPath}\``);
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

  const dangerStatus = cfg.claude_danger_mode
    ? '⚠️ Danger 模式：**开启**'
    : '🔒 Danger 模式：**关闭**';

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return card(cardHeader('📊 系统状态', 'indigo'), [
    md(sysLines.join('\n')),
    hr(),
    md(`**🔄 会话 (${activeCount} 活跃 / ${sessions.length} 总)**\n${sessionMd}`),
    hr(),
    md(dangerStatus),
    hr(),
    btnRow([
      cmdBtnRefresh('🔄 刷新', 'status', '', 'status', 'primary'),
      cmdBtn('📋 会话列表', 'session', 'list'),
    ]),
    btnRow([
      cmdBtn('❓ 帮助', 'help', ''),
      cmdBtn('📂 项目', 'project', ''),
    ]),
    md(`*⏱️ ${now}*`),
  ]);
}

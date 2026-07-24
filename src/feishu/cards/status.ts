import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../config.js';
import { parseThreadKey, type SessionPool } from '../../engine/pool.js';
import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, cmdBtnRefresh, hr, md } from './base.js';

function getVersionInfo(): { version: string; commit: string; sdkVersion: string } {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(__dirname, '..', '..', '..');
  const pkgPath = resolve(packageRoot, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string;
      dependencies?: Record<string, string>;
    };
    let commit = 'unknown';
    try {
      commit = execSync('git rev-parse --short HEAD', {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
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

export const MAX_STATUS_SESSIONS = 20;

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

export function renderStatusCard(
  cfg: Config,
  pool: SessionPool,
  configPath?: string,
  apiProfile?: { name: string; baseUrl: string },
  /** chatId → 群名（异步预解析后传入；缺省回落显示 threadKey） */
  chatNames?: Map<string, string>,
  /** 已在命令层完成鉴权过滤的会话；缺省仅供内部管理场景使用全量。 */
  visibleSessions?: ReturnType<SessionPool['list']>,
): InteractiveCard {
  const sessions = visibleSessions ?? pool.list();
  const activeCount = sessions.filter((s) => s.active).length;
  const vi = getVersionInfo();

  const sysLines: string[] = [];
  sysLines.push(`**chat-cc** v${vi.version} (${vi.commit})`);
  sysLines.push(`SDK \`${vi.sdkVersion}\` · Node \`${process.version}\``);
  sysLines.push(`进程运行: \`${formatUptime(process.uptime())}\``);
  if (configPath) sysLines.push(`配置: \`${configPath}\``);
  sysLines.push(`默认目录: \`${cfg.default_cwd}\``);
  if (apiProfile) sysLines.push(`API profile: **${apiProfile.name}** · \`${apiProfile.baseUrl}\``);

  // 会话区：群名 + slot + 项目 + 引擎，一行一会话，附关闭按钮
  const sessionElems: unknown[] = [];
  if (sessions.length === 0) {
    sessionElems.push(md('*(无会话)*'));
  } else {
    const shown = sessions.slice(0, MAX_STATUS_SESSIONS);
    for (const s of shown) {
      const parsed = parseThreadKey(s.threadKey);
      const m = pool.getMeta(s.threadKey);
      const marker = s.active ? '🟢' : '⚪';
      const chatName = chatNames?.get(parsed.chatId) ?? `…${parsed.chatId.slice(-6)}`;
      const slotSuffix = parsed.slot === 'default' ? '' : ` · \`${parsed.slot}\``;
      const project = s.cwd.split('/').filter(Boolean).pop() ?? s.cwd;
      const engine = m?.agent ?? cfg.agent;
      const dangerMark = (m?.danger ?? cfg.claude_danger_mode) ? ' · ⚠️danger' : '';
      sessionElems.push(
        md(`${marker} **${chatName}**${slotSuffix}\n　📁 ${project} · ${engine}${dangerMark} · \`${s.cwd}\``),
      );
      sessionElems.push(
        btnRow([
          cmdBtnRefresh('⏹ 关闭该会话', 'session', `stop ${s.threadKey}`, 'status', 'danger'),
        ]),
      );
    }
    if (sessions.length > shown.length) {
      sessionElems.push(md(`*…另有 ${sessions.length - shown.length} 个会话未展开，可按 slot 名管理*`));
    }
  }

  const dangerStatus = cfg.claude_danger_mode
    ? '⚠️ Danger 模式：**开启**'
    : '🔒 Danger 模式：**关闭**';

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return card(cardHeader('📊 系统状态', 'indigo'), [
    md(sysLines.join('\n')),
    hr(),
    md(`**🔄 会话 (${activeCount} 活跃 / ${sessions.length} 总)**`),
    ...sessionElems,
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

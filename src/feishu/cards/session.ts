import type { SessionPool } from '../../engine/pool.js';
import type { InteractiveCard } from '../replier.js';
import { btnRow, card, cardHeader, cmdBtn, cmdBtnRefresh, hr, md, toastBtn } from './base.js';

export function renderSessionListCard(pool: SessionPool, userKey: string): InteractiveCard {
  const sessions = pool.list();
  const activeKey = pool.getActive(userKey)?.threadKey;

  if (sessions.length === 0) {
    return card(cardHeader('📋 会话列表', 'blue'), [
      md('**当前没有任何会话**\n\n💡 启动新会话后可以直接发送消息与 Claude Code 交互'),
      hr(),
      btnRow([
        toastBtn('➕ 启动会话', '请发送：/session start 或 /session start @项目别名', 'primary'),
      ]),
    ]);
  }

  const elements: unknown[] = [];
  elements.push(md(`共 **${sessions.length}** 个会话 · ▸ 标记为当前活跃`));
  elements.push(hr());

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const marker = s.threadKey === activeKey ? '▸ ' : '  ';
    const statusIcon = s.active ? '🟢' : '⚪';
    const sid = s.sessionId ? s.sessionId.slice(0, 8) : '-';
    const elapsed = timeSince(s.lastUsed);

    elements.push(
      md(`${marker}**${i + 1}. ${statusIcon}** \`${s.threadKey}\`\n📁 \`${s.cwd}\` · sid \`${sid}\` · ⏱ ${elapsed}`),
    );
    elements.push(
      btnRow([
        cmdBtnRefresh('⛔ 关闭', 'session', `stop ${s.threadKey}`, 'session_list', 'danger'),
      ]),
    );
    elements.push(hr());
  }

  elements.push(
    btnRow([
      toastBtn('➕ 新建会话', '请发送：/session start @项目别名', 'primary'),
      cmdBtn('📊 状态', 'status', ''),
    ]),
  );

  return card(cardHeader('📋 会话列表', 'blue'), elements);
}

function timeSince(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  if (remMin > 0) return `${hrs}小时${remMin}分钟`;
  return `${hrs}小时`;
}

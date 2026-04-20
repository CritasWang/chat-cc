import { resolveCwd } from '../config.js';
import { threadKey } from '../engine/pool.js';
import { renderSessionListCard } from '../feishu/cards/session.js';
import { card, cardHeader, md, hr, btnRow, cmdBtn, toastBtn, cmdBtnRefresh } from '../feishu/cards/base.js';
import { senderKey, type CommandFn } from './types.js';

export const sessionCommand: CommandFn = async (args, meta, { cfg, pool, replier }) => {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'list').toLowerCase();
  const rest = parts.slice(1).join(' ');

  const key = threadKey({ chatId: meta.chatId, senderId: meta.senderId });

  if (sub === 'start') {
    const cwd = rest ? resolveCwd(cfg, rest) : cfg.default_cwd;
    const existing = pool.get(key);
    if (existing) {
      pool.setActive(senderKey(meta), key);
      await replier.replyCard(meta.messageId, card(cardHeader('💬 会话已存在', 'wathet'), [
        md(`**工作目录**: \`${existing.cwd}\``),
        hr(),
        btnRow([
          toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
          cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
        ]),
        md('*直接发消息即可对话*'),
      ]));
      return;
    }
    pool.start({ chatId: meta.chatId, senderId: meta.senderId }, cwd);
    const alias = rest || '默认';
    await replier.replyCard(meta.messageId, card(cardHeader('✅ 会话已启动', 'green'), [
      md(`**项目**: \`${alias}\`\n**工作目录**: \`${cwd}\``),
      hr(),
      btnRow([
        toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
        cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
      ]),
      md('*直接发消息即可对话，或使用 `/s <消息>` 显式发送*'),
    ]));
    return;
  }

  if (sub === 'stop') {
    const target = rest || pool.getActive(senderKey(meta))?.threadKey || key;
    const ok = await pool.stop(target, { keepMeta: false });
    return ok ? `🛑 已停止会话` : `会话不存在`;
  }

  if (sub === 'list') {
    await replier.replyCard(meta.messageId, renderSessionListCard(pool, senderKey(meta)));
    return;
  }

  return '用法: /session <start|stop|list> [args]';
};

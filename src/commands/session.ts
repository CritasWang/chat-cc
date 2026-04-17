import { resolveCwd } from '../config.js';
import { threadKey } from '../engine/pool.js';
import { senderKey, type CommandFn } from './types.js';

/**
 * /session start [@alias|path]   — 起一个新会话（复用当前 thread 的 key）
 * /session stop [threadKey]      — 停止一个会话（默认停活跃）
 * /session list                  — 列出所有会话
 */
export const sessionCommand: CommandFn = async (args, meta, { cfg, pool }) => {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'list').toLowerCase();
  const rest = parts.slice(1).join(' ');

  const key = threadKey({ chatId: meta.chatId, senderId: meta.senderId });

  if (sub === 'start') {
    const cwd = rest ? resolveCwd(cfg, rest) : cfg.default_cwd;
    const existing = pool.get(key);
    if (existing) {
      pool.setActive(senderKey(meta), key);
      return `会话已存在 · ${key}\ncwd: ${existing.cwd}\n直接用 /s <消息> 或 直接发消息`;
    }
    pool.start({ chatId: meta.chatId, senderId: meta.senderId }, cwd);
    return `🚀 会话已启动 · ${key}\ncwd: ${cwd}\n发送消息使用 /s <消息>（或直接发文本）`;
  }

  if (sub === 'stop') {
    const target = rest || pool.getActive(senderKey(meta))?.threadKey || key;
    const ok = await pool.stop(target);
    return ok ? `🛑 已停止 · ${target}` : `会话不存在 · ${target}`;
  }

  if (sub === 'list') {
    const items = pool.list();
    if (items.length === 0) return '当前无活跃会话，使用 /session start 开启';
    const active = pool.getActive(senderKey(meta))?.threadKey;
    const lines = items.map((it) => {
      const marker = it.threadKey === active ? '● ' : '  ';
      const sid = it.sessionId ? it.sessionId.slice(0, 8) : '-';
      return `${marker}${it.threadKey}  (sid ${sid}, ${it.lastUsed.toISOString()})`;
    });
    return '会话列表:\n' + lines.join('\n');
  }

  return '用法: /session <start|stop|list> [args]';
};

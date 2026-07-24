import { existsSync } from 'node:fs';
import { resolveCwd } from '../config.js';
import { parseThreadKey } from '../engine/pool.js';
import { senderKey, type CommandFn } from './types.js';

/**
 * /cd <@别名|路径>
 *
 * 切换当前活跃会话的工作目录（借鉴 lark-bridge 的 /cd）：
 * 同一个 threadKey 原地换 cwd —— 因换目录后旧对话上下文通常不再适用，
 * 会重置 SDK 会话（丢弃 resumeId 重开）；引擎/profile/danger 等
 * 会话级设置保留。适合 /new chat 建群后再决定干哪个项目的场景。
 *
 * chat-cc 自建的群（描述以「chat-cc 会话群」开头）切换目录后会自动
 * 把群名改成「项目名 · 引擎」，一眼看出这个群在干哪个项目。
 */
export const cdCommand: CommandFn = async (args, meta, { cfg, pool, replier }) => {
  const target = args.trim();
  if (!target) {
    const activeTk = pool.activeThreadKeyOf(senderKey(meta));
    const cwd = activeTk ? pool.getMeta(activeTk)?.cwd : undefined;
    return `当前工作目录: \`${cwd ?? '（无活跃会话）'}\`\n\n用法: /cd <@项目别名|绝对路径>`;
  }

  const cwd = resolveCwd(cfg, target);
  if (!existsSync(cwd)) {
    return `❌ 路径不存在: \`${cwd}\`\n请检查路径或项目别名（/project 查看别名）`;
  }

  const activeTk = pool.activeThreadKeyOf(senderKey(meta));
  if (!activeTk) {
    return '当前无活跃会话，直接用 `/session start ' + target + '` 开新会话即可';
  }

  const m = pool.getMeta(activeTk);
  if (m?.cwd === cwd) return `已经在 \`${cwd}\` 了`;

  // 换目录 = 换项目上下文：停掉旧会话（清 sessionId），同 threadKey 原地重开
  await pool.stop(activeTk, { keepMeta: true });
  pool.clearSessionId(activeTk);
  const meta2 = pool.getMeta(activeTk);
  if (meta2) meta2.cwd = cwd;
  pool.start(parseThreadKey(activeTk), cwd);

  // chat-cc 自建的群：群名/描述随项目更新（best-effort）
  let renameNote = '';
  const info = await replier.getChatInfo(meta.chatId);
  if (info?.description?.startsWith('chat-cc 会话群')) {
    const engine = pool.getMeta(activeTk)?.agent ?? cfg.agent;
    const engineName = engine === 'codex' ? 'Codex' : 'Claude';
    const project = cwd.split('/').filter(Boolean).pop() ?? cwd;
    const newName = `${project} · ${engineName}`;
    const ok = await replier.updateChat(meta.chatId, {
      name: newName,
      description: `chat-cc 会话群 · ${engine} · ${cwd}`,
    });
    if (ok) renameNote = `\n群名已更新: **${newName}**`;
  }

  return `✅ 工作目录已切换: \`${cwd}\`${renameNote}\n（新目录开新对话，引擎/profile 等会话设置保留）`;
};

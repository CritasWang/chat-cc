import { existsSync } from 'node:fs';
import {
  DEFAULT_SLOT,
  normalizeSlot,
  parseThreadKey,
  threadKey,
  type SessionPool,
} from '../engine/pool.js';
import { renderSessionListCard } from '../feishu/cards/session.js';
import { card, cardHeader, md, hr, btnRow, cmdBtn, toastBtn, cmdBtnRefresh } from '../feishu/cards/base.js';
import { senderKey, type CommandFn } from './types.js';
import type { MessageMeta } from '../feishu/router.js';
import type { Config } from '../config.js';

/** 解析 start 参数 -> { cwd, slot, label } */
function parseStartArgs(rest: string, cfg: Config): { cwd: string; slot: string; label: string } {
  // 支持 --name=xxx 覆盖 slot
  const nameMatch = rest.match(/--name=(\S+)/);
  const nameOverride = nameMatch ? normalizeSlot(nameMatch[1]!) : undefined;
  const target = nameMatch ? rest.replace(/--name=\S+/, '').trim() : rest.trim();

  if (!target) {
    return { cwd: cfg.default_cwd, slot: nameOverride ?? DEFAULT_SLOT, label: '默认' };
  }
  if (target.startsWith('@')) {
    const alias = target.slice(1);
    const cwd = cfg.projects[alias] ?? target;
    return { cwd, slot: nameOverride ?? normalizeSlot(alias), label: target };
  }
  // 纯路径：slot 取 basename
  const basename = target.split('/').filter(Boolean).pop() ?? DEFAULT_SLOT;
  return { cwd: target, slot: nameOverride ?? normalizeSlot(basename), label: target };
}

/** 在用户作用域内按 slot名/序号/threadKey 解析目标 */
function resolveTarget(
  pool: SessionPool,
  meta: MessageMeta,
  raw: string,
): { threadKey: string; slot: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const scoped = pool.listByScope(meta.chatId, meta.senderId);

  // 序号（1-based）
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= scoped.length) {
    const hit = scoped[asNum - 1]!;
    return { threadKey: hit.threadKey, slot: parseThreadKey(hit.threadKey).slot };
  }

  // 完整 threadKey（包含冒号）
  if (trimmed.includes(':') && pool.getMeta(trimmed)) {
    return { threadKey: trimmed, slot: parseThreadKey(trimmed).slot };
  }

  // slot 名
  const slot = normalizeSlot(trimmed);
  const hit = scoped.find((s) => parseThreadKey(s.threadKey).slot === slot);
  return hit ? { threadKey: hit.threadKey, slot } : undefined;
}

/** slot 冲突时自增编号 */
function uniqueSlot(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) return wanted;
  let i = 2;
  while (taken.has(`${wanted}-${i}`)) i += 1;
  return `${wanted}-${i}`;
}

export const sessionCommand: CommandFn = async (args, meta, { cfg, pool, replier }) => {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'list').toLowerCase();
  const rest = parts.slice(1).join(' ');
  const userKey = senderKey(meta);

  if (sub === 'start') {
    const { cwd, slot: wanted, label } = parseStartArgs(rest, cfg);

    // 校验工作目录是否存在
    if (!existsSync(cwd)) {
      await replier.replyCard(
        meta.messageId,
        card(cardHeader('❌ 路径不存在', 'red'), [
          md(`指定的工作目录不存在：\n\`${cwd}\`\n\n请检查路径是否正确，或在 config.yaml 的 projects 中配置别名。`),
          hr(),
          btnRow([
            cmdBtn('📂 查看项目', 'project', ''),
            cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
          ]),
        ]),
      );
      return;
    }

    const scoped = pool.listByScope(meta.chatId, meta.senderId);
    const taken = new Set(scoped.map((s) => parseThreadKey(s.threadKey).slot));

    // 同 slot 已存在：cwd 相同 → 激活；cwd 不同 → 自增编号新建
    const sameSlotKey = threadKey({ chatId: meta.chatId, senderId: meta.senderId, slot: wanted });
    const existingMeta = pool.getMeta(sameSlotKey);
    let finalSlot = wanted;
    if (existingMeta) {
      if (existingMeta.cwd === cwd) {
        // 直接激活 + 懒启动（如果已关闭）
        pool.start({ chatId: meta.chatId, senderId: meta.senderId, slot: wanted }, cwd);
        await replier.replyCard(
          meta.messageId,
          card(cardHeader('💬 已激活已有会话', 'wathet'), [
            md(`**slot**: \`${wanted}\`\n**cwd**: \`${cwd}\``),
            hr(),
            btnRow([
              toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
              cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
            ]),
          ]),
        );
        return;
      }
      finalSlot = uniqueSlot(wanted, taken);
    }

    pool.start({ chatId: meta.chatId, senderId: meta.senderId, slot: finalSlot }, cwd);
    await replier.replyCard(
      meta.messageId,
      card(cardHeader('✅ 会话已启动', 'green'), [
        md(
          `**项目**: \`${label}\`\n` +
            `**slot**: \`${finalSlot}\`${finalSlot !== wanted ? `（原 \`${wanted}\` 已被占用，自动追加编号）` : ''}\n` +
            `**cwd**: \`${cwd}\``,
        ),
        hr(),
        btnRow([
          toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
          cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
        ]),
        md('*直接发消息即可对话，或使用 `/s <消息>` 显式发送*'),
      ]),
    );
    return;
  }

  if (sub === 'switch' || sub === 'use') {
    if (!rest) return '用法: /session switch <slot名|序号>';
    const target = resolveTarget(pool, meta, rest);
    if (!target) return `未找到会话: \`${rest}\`（用 /session list 查看可选）`;

    // 懒启动：若目标只有 meta 没有活跃 Session，加载并激活
    const tm = pool.getMeta(target.threadKey);
    if (tm && !pool.get(target.threadKey)) {
      const parsed = parseThreadKey(target.threadKey);
      pool.start(
        { chatId: parsed.chatId, senderId: parsed.senderId, slot: parsed.slot },
        tm.cwd,
      );
    } else {
      pool.setActive(userKey, target.threadKey);
    }

    await replier.replyCard(
      meta.messageId,
      card(cardHeader('🔄 已切换当前会话', 'green'), [
        md(
          `**slot**: \`${target.slot}\`\n` +
            `**cwd**: \`${tm?.cwd ?? '-'}\`\n\n` +
            `*其他会话仍在后台，互不干扰*`,
        ),
        hr(),
        btnRow([
          toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
          cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
        ]),
      ]),
    );
    return;
  }

  if (sub === 'stop') {
    const target = rest
      ? resolveTarget(pool, meta, rest)
      : (() => {
          const act = pool.getOrResumeActive(userKey);
          return act
            ? { threadKey: act.threadKey, slot: parseThreadKey(act.threadKey).slot }
            : undefined;
        })();
    if (!target) return '未指定且无当前会话';
    const ok = await pool.stop(target.threadKey, { keepMeta: false });
    return ok ? `🛑 已停止会话 \`${target.slot}\`` : `会话不存在`;
  }

  if (sub === 'list') {
    await replier.replyCard(meta.messageId, renderSessionListCard(pool, meta, userKey));
    return;
  }

  if (sub === 'current') {
    const sess = pool.getOrResumeActive(userKey);
    if (!sess) {
      await replier.replyCard(
        meta.messageId,
        card(cardHeader('📭 当前无活跃会话', 'grey'), [
          md('使用 `/session start [@别名]` 启动一个会话'),
          hr(),
          btnRow([
            cmdBtn('📂 查看项目', 'project', ''),
            cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
          ]),
        ]),
      );
      return;
    }
    const m = pool.getMeta(sess.threadKey);
    const { slot } = parseThreadKey(sess.threadKey);
    const sid = sess.sessionId ? sess.sessionId.slice(0, 8) : '-';
    await replier.replyCard(
      meta.messageId,
      card(cardHeader('🟢 当前活跃会话', 'green'), [
        md(
          `**slot**: \`${slot}\`\n` +
            `**cwd**: \`${m?.cwd ?? sess.cwd}\`\n` +
            `**sid**: \`${sid}\``,
        ),
        hr(),
        btnRow([
          toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
          cmdBtn('🛑 停止当前', 'session', 'stop', 'danger'),
          cmdBtnRefresh('📋 全部会话', 'session', 'list', 'session_list'),
        ]),
      ]),
    );
    return;
  }

  return '用法: /session <start|switch|stop|list|current> [args]';
};

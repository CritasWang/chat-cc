import {
  DEFAULT_SLOT,
  normalizeSlot,
  parseThreadKey,
  threadKey,
  isTopicThreadKey,
  topicThreadKey,
  SessionPoolCapacityError,
  type SessionPool,
} from '../engine/pool.js';
import { renderSessionListCard } from '../feishu/cards/session.js';
import { card, cardHeader, md, hr, btnRow, cmdBtn, toastBtn, cmdBtnRefresh } from '../feishu/cards/base.js';
import { senderKey, type CommandFn } from './types.js';
import type { MessageMeta } from '../feishu/router.js';
import { replyOptions } from '../feishu/router.js';
import { validateCwd, type Config } from '../config.js';
import type { AgentKind } from '../agent/types.js';
import { isPrivileged } from '../policy/owner.js';
import { canAccessSession, currentSessionKey, listAccessibleSessions } from './session-context.js';
import { describeModel, effectiveModelOf } from './model-context.js';

/** 从参数中摘出 --codex / --claude 引擎标记 */
export function extractAgentFlag(raw: string): { rest: string; agent?: AgentKind } {
  let agent: AgentKind | undefined;
  const rest = raw
    .replace(/(^|\s)--(codex|claude)(?=\s|$)/g, (_m, _pre, name: string) => {
      agent = name as AgentKind;
      return ' ';
    })
    .trim();
  return { rest, ...(agent ? { agent } : {}) };
}

/** 从参数中摘出 --profile <name> / --profile=<name> API profile 标记 */
export function extractProfileFlag(raw: string): { rest: string; profile?: string } {
  let profile: string | undefined;
  const rest = raw
    .replace(/(^|\s)--profile[= ]([A-Za-z0-9_.-]+)(?=\s|$)/g, (_m, _pre, name: string) => {
      profile = name;
      return ' ';
    })
    .trim();
  return { rest, ...(profile ? { profile } : {}) };
}

/**
 * 从参数中摘出 --model <name> / --model=<name>。
 * 字符集要容纳第三方模型 id：`[1m]` 之类的上下文窗口后缀、以及 `:@/` 分隔符。
 */
export function extractModelFlag(raw: string): { rest: string; model?: string } {
  let model: string | undefined;
  const rest = raw
    .replace(/(^|\s)--model[= ]([A-Za-z0-9_.:@/[\]-]+)(?=\s|$)/g, (_m, _pre, name: string) => {
      model = name;
      return ' ';
    })
    .trim();
  return { rest, ...(model ? { model } : {}) };
}

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
  const scoped = listAccessibleSessions(meta, pool);

  // 序号（1-based）
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= scoped.length) {
    const hit = scoped[asNum - 1]!;
    return { threadKey: hit.threadKey, slot: parseThreadKey(hit.threadKey).slot };
  }

  // 完整 threadKey（包含冒号）
  if (trimmed.includes(':') && pool.getMeta(trimmed) && canAccessSession(meta, trimmed)) {
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

export const sessionCommand: CommandFn = async (args, meta, { cfg, pool, replier, apiProfiles }) => {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'list').toLowerCase();
  const rest = parts.slice(1).join(' ');
  const userKey = senderKey(meta);

  if (sub === 'start') {
    try {
    const { rest: noAgent, agent } = extractAgentFlag(rest);
    const { rest: noProfile, profile } = extractProfileFlag(noAgent);
    const { rest: cleaned, model } = extractModelFlag(noProfile);
    const parsedStart = parseStartArgs(cleaned, cfg);
    const checkedCwd = validateCwd(cfg, parsedStart.cwd);
    if (!checkedCwd.ok) {
      const reason = checkedCwd.reason === 'outside-allowed-roots'
        ? '路径不在允许的工作目录根范围内'
        : checkedCwd.reason === 'not-directory'
          ? '目标不是目录'
          : '路径不存在';
      await replier.replyCard(
        meta.messageId,
        card(cardHeader('❌ 工作目录不可用', 'red'), [
          md(`${reason}：\n\`${checkedCwd.cwd}\`\n\n请使用 default_cwd、projects 或 allowed_cwd_roots 下的目录。`),
        ]),
        replyOptions(meta),
      );
      return;
    }
    const cwd = checkedCwd.cwd;
    const { slot: wanted, label } = parsedStart;
    const engineLabel = agent ?? cfg.agent;
    if (agent === 'codex' && !isPrivileged(cfg, meta.senderId)) {
      return '⛔ 显式切换 Codex 仅管理员可用';
    }
    if (profile && !isPrivileged(cfg, meta.senderId)) {
      return '⛔ 指定 API profile 仅管理员可用';
    }
    if (profile && !apiProfiles?.get(profile)) {
      const available = apiProfiles?.available()
        ? `\n可用: ${apiProfiles.list().map((p) => p.name).join(', ')}`
        : '（当前未配置 cc-profiles.zsh）';
      return `❌ 未知 API profile: ${profile}${available}`;
    }
    if (profile && engineLabel === 'codex') {
      return '❌ API profile 仅适用于 Claude 引擎，Codex 会话不支持 --profile';
    }
    if (model && !isPrivileged(cfg, meta.senderId)) {
      return '⛔ 指定模型仅管理员可用';
    }
    const startOpts = {
      ...(agent ? { agent } : {}),
      ...(profile ? { apiProfile: profile } : {}),
      ...(model ? { model } : {}),
    };

    // 话题群固定“一话题一会话”。/session start 必须操作当前 topic key，不能创建一个
    // 后续普通消息永远不会命中的个人 slot 会话。
    if (meta.threadId) {
      if (/(^|\s)--name=\S+/.test(cleaned)) {
        return '话题会话固定绑定当前话题，不支持 `--name` 多槽位';
      }
      const topicKey = topicThreadKey(meta.chatId, meta.threadId);
      const existingMeta = pool.getMeta(topicKey);
      const running = pool.get(topicKey);
      const optsChanged = Boolean(
        running && existingMeta &&
        ((startOpts.agent !== undefined &&
          startOpts.agent !== (existingMeta.sessionIdAgent ?? existingMeta.agent ?? cfg.agent)) ||
         (startOpts.apiProfile !== undefined && startOpts.apiProfile !== existingMeta.apiProfile) ||
         (startOpts.model !== undefined && startOpts.model !== existingMeta.model)),
      );

      let resetForCwd = false;
      if (existingMeta?.cwd !== undefined && existingMeta.cwd !== cwd) {
        resetForCwd = true;
        const restarted = await pool.resetContext(topicKey, cwd, startOpts);
        if (!restarted) return '❌ 话题会话在重建期间已被关闭，请重试';
      } else if (optsChanged) {
        await pool.restart(parseThreadKey(topicKey), cwd, startOpts);
      } else {
        pool.start(parseThreadKey(topicKey), cwd, startOpts);
      }

      await replier.replyCard(
        meta.messageId,
        card(cardHeader(existingMeta ? '💬 话题会话已更新' : '✅ 话题会话已启动', 'green'), [
          md(
            `**范围**: 当前话题\n` +
              `**项目**: \`${label}\`\n` +
              `**cwd**: \`${cwd}\`\n` +
              `**引擎**: \`${engineLabel}\`${profile ? `\n**API profile**: \`${profile}\`` : ''}${model ? `\n**模型**: \`${model}\`` : ''}` +
              (resetForCwd ? '\n\n*工作目录已变化，旧对话上下文已清空*' : ''),
          ),
          hr(),
          btnRow([
            toastBtn('💬 发消息', '直接在当前话题发送文字即可', 'primary'),
            cmdBtnRefresh('📋 会话状态', 'session', 'list', 'session_list'),
          ]),
        ]),
        replyOptions(meta),
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
        // 直接激活 + 懒启动（如果已关闭）；本次指定的引擎/profile 会覆盖历史选择
        const sess = pool.get(sameSlotKey);
        const optsChanged = sess &&
          ((startOpts.agent !== undefined &&
            startOpts.agent !== (existingMeta.sessionIdAgent ?? existingMeta.agent ?? cfg.agent)) ||
           (startOpts.apiProfile !== undefined && startOpts.apiProfile !== existingMeta.apiProfile) ||
           (startOpts.model !== undefined && startOpts.model !== existingMeta.model));
        if (optsChanged) {
          // 值与当前 meta 不同且会话正在运行：需先关闭旧进程再重启（Codex 需等 SIGTERM/SIGKILL）
          await pool.restart(
            { chatId: meta.chatId, senderId: meta.senderId, slot: wanted },
            cwd,
            startOpts,
          );
        } else {
          pool.start(
            { chatId: meta.chatId, senderId: meta.senderId, slot: wanted },
            cwd,
            startOpts,
          );
        }
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
          replyOptions(meta),
        );
        return;
      }
      finalSlot = uniqueSlot(wanted, taken);
    }

    pool.start(
      { chatId: meta.chatId, senderId: meta.senderId, slot: finalSlot },
      cwd,
      startOpts,
    );
    await replier.replyCard(
      meta.messageId,
      card(cardHeader('✅ 会话已启动', 'green'), [
        md(
          `**项目**: \`${label}\`\n` +
            `**slot**: \`${finalSlot}\`${finalSlot !== wanted ? `（原 \`${wanted}\` 已被占用，自动追加编号）` : ''}\n` +
            `**cwd**: \`${cwd}\`\n` +
            `**引擎**: \`${engineLabel}\`${profile ? `\n**API profile**: \`${profile}\`` : ''}${model ? `\n**模型**: \`${model}\`` : ''}`,
        ),
        hr(),
        btnRow([
          toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
          cmdBtnRefresh('📋 会话列表', 'session', 'list', 'session_list'),
        ]),
        md('*直接发消息即可对话，或使用 `/s <消息>` 显式发送*'),
      ]),
      replyOptions(meta),
    );
      return;
    } catch (err) {
      if (err instanceof SessionPoolCapacityError) {
        return `⏳ 活跃会话已达上限（${err.limit}），请先关闭不用的会话或等待空闲回收`;
      }
      throw err;
    }
  }

  if (sub === 'switch' || sub === 'use') {
    if (!rest) return '用法: /session switch <slot名|序号>';
    const target = resolveTarget(pool, meta, rest);
    if (!target) return `未找到会话: \`${rest}\`（用 /session list 查看可选）`;

    // 懒启动：若目标只有 meta 没有活跃 Session，加载并激活
    const tm = pool.getMeta(target.threadKey);
    if (tm && !pool.get(target.threadKey)) {
      const parsed = parseThreadKey(target.threadKey);
      try {
        pool.start(
          { chatId: parsed.chatId, senderId: parsed.senderId, slot: parsed.slot },
          tm.cwd,
        );
      } catch (err) {
        if (err instanceof SessionPoolCapacityError) {
          return `⏳ 活跃会话已达上限（${err.limit}），请先关闭不用的会话或等待空闲回收`;
        }
        throw err;
      }
    } else {
      if (!isTopicThreadKey(target.threadKey)) pool.setActive(userKey, target.threadKey);
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
      replyOptions(meta),
    );
    return;
  }

  if (sub === 'stop') {
    const target = rest
      ? resolveTarget(pool, meta, rest)
      : (() => {
          const key = currentSessionKey(meta, pool);
          return key ? { threadKey: key, slot: parseThreadKey(key).slot } : undefined;
        })();
    if (!target) return '未指定且无当前会话';
    const ok = await pool.stop(target.threadKey, { keepMeta: false, reason: 'destroy' });
    return ok ? `🛑 已停止会话 \`${target.slot}\`` : `会话不存在`;
  }

  if (sub === 'list') {
    await replier.replyCard(meta.messageId, renderSessionListCard(pool, meta, userKey), replyOptions(meta));
    return;
  }

  if (sub === 'current') {
    const currentKey = currentSessionKey(meta, pool);
    let sess = currentKey ? pool.get(currentKey) : undefined;
    if (currentKey && !sess) {
      const m = pool.getMeta(currentKey);
      if (m) {
        try {
          sess = pool.start(parseThreadKey(currentKey), m.cwd);
        } catch (err) {
          if (err instanceof SessionPoolCapacityError) {
            return `⏳ 活跃会话已达上限（${err.limit}），请先关闭不用的会话或等待空闲回收`;
          }
          throw err;
        }
      }
    }
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
        replyOptions(meta),
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
            `**引擎**: \`${m?.agent ?? cfg.agent}\`\n` +
            `**API profile**: \`${m?.apiProfile ?? '（跟随全局）'}\`\n` +
            `**模型**: ${describeModel(effectiveModelOf(sess.threadKey, { cfg, pool, apiProfiles }))}\n` +
            `**权限**: \`${m?.danger === undefined ? '（跟随全局）' : m.danger ? 'danger' : '审批'}\`\n` +
            `**sid**: \`${sid}\``,
        ),
        hr(),
        btnRow([
          toastBtn('💬 发消息', '直接发送文字即可投递到当前会话', 'primary'),
          cmdBtn('🛑 停止当前', 'session', 'stop', 'danger'),
          cmdBtnRefresh('📋 全部会话', 'session', 'list', 'session_list'),
        ]),
      ]),
      replyOptions(meta),
    );
    return;
  }

  return '用法: /session <start|switch|stop|list|current> [args]';
};

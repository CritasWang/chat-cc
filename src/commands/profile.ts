import { senderKey, type CommandFn } from './types.js';
import { maskToken } from '../engine/api-profiles.js';
import { isPrivileged } from '../policy/owner.js';

/**
 * /profile [list|use <name> [--global]|clear|reload]
 *
 * API profile 切换（可选功能）：数据源是本机 ~/.claude/cc-profiles.zsh。
 * 未配置该文件的用户看到友好提示，其余功能完全不受影响。
 *
 * 两层语义（类比终端：每个窗口可以各自 ccuse，也有全局默认）：
 * - `use <name>`           → 只切**当前会话**（有活跃会话时）；仅重启该会话，
 *                            其他会话不受影响。无活跃会话时提示改用 --global
 * - `use <name> --global`  → 切全局默认，重启所有**未设置会话级覆盖**的会话
 * - `clear`                → 清除当前会话的覆盖，回归全局默认
 *
 * 会话级选择随会话持久化（重启/懒恢复后保持）。
 */
export const profileCommand: CommandFn = async (args, meta, { cfg, pool, apiProfiles }) => {
  if (!apiProfiles?.available()) {
    return (
      '当前未配置 API profile（可选功能）。\n' +
      '如需多 API 切换，在服务器上创建 `~/.claude/cc-profiles.zsh`，格式:\n' +
      '```\nCC_PROFILES=(\n  name1 "sk-xxx|https://api.example.com"\n)\nCC_DEFAULT_PROFILE=name1\n```'
    );
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const isGlobal = tokens.includes('--global');
  const parts = tokens.filter((t) => t !== '--global');
  const sub = (parts[0] ?? 'list').toLowerCase();
  const userKey = senderKey(meta);

  switch (sub) {
    case 'list': {
      const cur = apiProfiles.current();
      const activeTk = pool.activeThreadKeyOf(userKey);
      const sessionOverride = activeTk ? pool.getMeta(activeTk)?.apiProfile : undefined;
      const lines = apiProfiles.list().map((p) => {
        const marks = [
          p.name === cur?.name ? '🌐' : '',
          p.name === sessionOverride ? '📍' : '',
        ].join('');
        return `${marks || '⚪'} **${p.name}** · ${p.baseUrl} · \`${maskToken(p.token)}\``;
      });
      return (
        `**API Profiles**\n` +
        `全局默认 🌐: ${cur?.name ?? '未选择（使用进程环境）'}\n` +
        `当前会话 📍: ${sessionOverride ?? '（跟随全局）'}\n\n` +
        lines.join('\n') +
        '\n\n`/profile use <name>` 只切当前会话 · `--global` 切全局默认 · `/profile clear` 会话回归全局'
      );
    }

    case 'use': {
      if (!isPrivileged(cfg, meta.senderId)) {
        return '⛔ 切换 API profile 仅管理员可用（config `admin_users` 可配置）';
      }
      const name = parts[1];
      if (!name) return '用法: /profile use <name> [--global]';
      if (!apiProfiles.get(name)) {
        return `❌ 未知 profile: ${name}\n可用: ${apiProfiles.list().map((p) => p.name).join(', ')}`;
      }

      // —— 全局切换：更新默认，重启所有未设会话级覆盖的会话 ——
      if (isGlobal) {
        apiProfiles.use(name);
        const p = apiProfiles.current()!;
        let restarted = 0;
        for (const s of pool.list()) {
          if (!s.active) continue; // 预热态下次懒恢复自然生效
          if (pool.getMeta(s.threadKey)?.apiProfile) continue; // 有会话级覆盖的不动
          await pool.stop(s.threadKey, { keepMeta: true });
          pool.start(parseKey(s.threadKey), pool.getMeta(s.threadKey)?.cwd ?? '.');
          restarted += 1;
        }
        return (
          `✅ 全局默认已切到 **${p.name}** → ${p.baseUrl}\n` +
          `已重建 ${restarted} 个跟随全局的会话（上下文保留）；带会话级覆盖的会话不受影响`
        );
      }

      // —— 会话级切换：只动当前会话 ——
      const activeTk = pool.activeThreadKeyOf(userKey);
      if (!activeTk) {
        return '当前无活跃会话。切全局默认请用 `/profile use ' + name + ' --global`，或先 `/session start` 开会话';
      }
      const ok = await pool.setSessionApiProfile(activeTk, name);
      if (!ok) return '❌ 会话状态异常，切换失败';
      const p = apiProfiles.get(name)!;
      return (
        `✅ **当前会话**已切到 **${p.name}** → ${p.baseUrl}（上下文保留）\n` +
        `其他会话不受影响 · \`/profile clear\` 可回归全局默认`
      );
    }

    case 'clear': {
      if (!isPrivileged(cfg, meta.senderId)) {
        return '⛔ 切换 API profile 仅管理员可用（config `admin_users` 可配置）';
      }
      const activeTk = pool.activeThreadKeyOf(userKey);
      if (!activeTk) return '当前无活跃会话';
      const m = pool.getMeta(activeTk);
      if (!m?.apiProfile) return '当前会话没有设置 profile 覆盖（本就跟随全局）';
      await pool.setSessionApiProfile(activeTk, undefined);
      return `✅ 当前会话已回归全局默认（${apiProfiles.current()?.name ?? '进程环境'}），上下文保留`;
    }

    case 'reload': {
      apiProfiles.reload();
      return `✅ 已重新读取 cc-profiles.zsh（${apiProfiles.list().length} 个 profile）`;
    }

    default:
      return '用法: /profile [list|use <name> [--global]|clear|reload]';
  }
};

/** threadKey 字符串 → ThreadKey 对象（避免循环依赖，这里就地解析） */
function parseKey(tk: string): { chatId: string; senderId: string; slot: string } {
  const parts = tk.split(':');
  return {
    chatId: parts[0] ?? '',
    senderId: parts[1] ?? '',
    slot: parts.slice(2).join(':') || 'default',
  };
}

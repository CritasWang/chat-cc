import { homedir } from 'node:os';
import { resolveCwd, validateCwd } from '../config.js';
import { senderKey, type CommandFn } from './types.js';
import { extractAgentFlag, extractProfileFlag, extractModelFlag } from './session.js';
import { applyFeedTags } from '../feishu/feed-tag.js';
import { card, cardHeader, md } from '../feishu/cards/base.js';
import { isPrivileged } from '../policy/owner.js';
import { SessionPoolCapacityError } from '../engine/pool.js';
import { log } from '../logger.js';

/**
 * /new [chat] [名字] [--codex|--claude] [--profile <name>]
 *
 * - `/new chat [名字]`：自动创建一个新群（拉发送者 + bot），继承发送者当前
 *   活跃会话的 cwd 并在新群里开好会话 — 借鉴 lark-coding-agent-bridge 的
 *   「一个群 = 一个 project」体验，无需手动拉群
 * - `--codex` / `--claude`：本会话使用指定引擎（缺省跟随全局 `agent` 配置）
 * - `--profile <name>`：本会话使用指定 API profile（缺省跟随全局当前）
 * - `@别名` 或 `/绝对路径`：指定新群的项目目录（缺省继承发送者当前活跃会话的 cwd）
 * - `--topic`：建成话题群（一个话题 = 一个独立会话，适合一群里并行多任务）
 * - `/new`（无参数）：等价于清空当前会话重新开始（提示用 /session start）
 */
export const newCommand: CommandFn = async (args, meta, { cfg, pool, replier, apiProfiles }) => {
  if (!isPrivileged(cfg, meta.senderId)) {
    return '⛔ 创建新群仅管理员可用（config `admin_users`）';
  }
  const { rest: noAgent, agent } = extractAgentFlag(args.trim());
  const { rest: noProfile, profile } = extractProfileFlag(noAgent);
  const { rest: noModel, model } = extractModelFlag(noProfile);
  let isTopic = false;
  const cleanedArgs = noModel.replace(/(^|\s)--topic(?=\s|$)/g, () => {
    isTopic = true;
    return ' ';
  });
  const trimmed = cleanedArgs.trim();
  if (!trimmed.toLowerCase().startsWith('chat')) {
    return '用法: `/new chat [群名字] [@别名|/绝对路径] [--codex|--claude] [--profile <name>]` — 自动建一个新群并开好会话\n（清空当前会话请用 `/session stop` + `/session start`）';
  }

  if (!meta.senderId) return '❌ 无法识别发送者，无法拉你进群';
  if (profile && !apiProfiles?.get(profile)) {
    return `❌ 未知 API profile: ${profile}${apiProfiles?.available() ? `\n可用: ${apiProfiles.list().map((p) => p.name).join(', ')}` : '（未配置 cc-profiles.zsh）'}`;
  }

  let topic = trimmed.slice(4).trim();
  const engine = agent ?? cfg.agent;
  if (profile && engine === 'codex') {
    return '❌ API profile 仅适用于 Claude 引擎，Codex 会话不支持 --profile';
  }

  // @别名 或 直接路径 显式指定项目目录（从群名参数里摘出）
  let explicitCwd: string | undefined;
  const { rest: topicRest, target: cwdToken } = extractCwdTarget(topic);
  if (cwdToken) {
    const resolved = resolveCwd(cfg, cwdToken.startsWith('~/') ? cwdToken.replace('~', homedir()) : cwdToken);
    const checked = validateCwd(cfg, resolved);
    if (!checked.ok) {
      const reason = checked.reason === 'outside-allowed-roots'
        ? '项目路径不在允许根目录内'
        : checked.reason === 'not-directory' ? '目标不是目录' : '项目路径不存在';
      return `❌ ${reason}: \`${checked.cwd}\`（/project 查看可用别名）`;
    }
    explicitCwd = checked.cwd;
    topic = topicRest;
  }

  // cwd 优先级：@别名/路径显式指定 > 继承发送者当前活跃会话 > default_cwd
  const activeTk = pool.activeThreadKeyOf(senderKey(meta));
  const inheritedCwd = activeTk ? pool.getMeta(activeTk)?.cwd : undefined;
  const inherited = explicitCwd ?? inheritedCwd ?? cfg.default_cwd;
  const checkedCwd = validateCwd(cfg, inherited);
  if (!checkedCwd.ok) return `❌ 工作目录不可用: \`${checkedCwd.cwd}\``;
  const cwd = checkedCwd.cwd;
  const cwdSource = explicitCwd ? '指定' : inheritedCwd ? '继承自当前活跃会话' : '默认目录';

  // 群名：显式名字 > 显式指定了目录时用「项目名 · 引擎」（与 /cd 重命名格式一致）> 「引擎 · 时间」
  const engineName = engine === 'codex' ? 'Codex' : 'Claude';
  const project = cwd.split('/').filter(Boolean).pop() ?? '';
  const name = topic || (explicitCwd && project ? `${project} · ${engineName}` : defaultChatName(engineName));

  // 建群是外部副作用，先做容量预检，避免已知无法启动会话时仍留下空群。
  // createChat() 期间容量仍可能被其他请求占用，因此 start() 后还需再捕获一次。
  if (!pool.hasStartCapacity()) {
    return `⏳ 活跃会话已达上限（${cfg.max_active_sessions}），请先关闭不用的会话再建群`;
  }

  const chatId = await replier.createChat({
    name,
    inviteOpenIds: [meta.senderId],
    description: `chat-cc 会话群 · ${engine} · ${cwd}`,
    ...(isTopic ? { chatMode: 'topic' as const } : {}),
  });
  if (!chatId) return '❌ 建群失败（请确认应用有「创建群」im:chat 权限）';

  // 预开 default 会话：普通群直接用；话题群里它是「设置锚点」——
  // 每个话题的新会话从它继承 cwd/引擎/profile（话题消息不会路由进它）
  try {
    pool.start(
      { chatId, senderId: meta.senderId, slot: 'default' },
      cwd,
      {
        ...(agent ? { agent } : {}),
        ...(profile ? { apiProfile: profile } : {}),
        ...(model ? { model } : {}),
      },
    );
  } catch (err) {
    const capacity = err instanceof SessionPoolCapacityError;
    log().error({ err, chatId, cwd, engine }, '新群已创建但会话启动失败');
    await replier.sendCard(
      chatId,
      card(cardHeader('⚠️ 会话尚未启动', 'orange'), [
        md(
          capacity
            ? `活跃会话已达上限（${err.limit}）。请先关闭不用的会话，再在本群执行 \`/session start\`。`
            : '群已创建，但 Agent 会话启动失败。请检查 `chat-cc logs`，修复后在本群执行 `/session start`。',
        ),
      ]),
    );
    return capacity
      ? `⚠️ 群「${name}」已创建，但容量在建群期间已被占满（上限 ${err.limit}），会话尚未启动`
      : `⚠️ 群「${name}」已创建，但会话启动失败，请查看 chat-cc 日志`;
  }

  // 自动打会话标签（feed 标签：ai + cc / ai + codex 两个独立标签）— best-effort，失败不影响建群
  const tagNames = engine === 'codex' ? cfg.new_chat_tags_codex : cfg.new_chat_tags_claude;
  let tagNote = '';
  if (tagNames.length > 0) {
    const tag = await applyFeedTags(cfg.lark_cli_bin, tagNames, chatId);
    tagNote = tag.ok
      ? `\n标签：\`${tag.detail}\``
      : `\n标签：未打上（${tag.detail}）`;
  }
  const profileNote = profile ? `\nAPI profile：\`${profile}\`` : '';

  // 新群欢迎卡片
  await replier.sendCard(
    chatId,
    card(cardHeader('👋 群已建好', 'green'), [
      md(`引擎：\`${engine}\`${profileNote}\n工作目录：\`${cwd}\`（${cwdSource}，可用 /cd 切换）${tagNote}\n${isTopic ? '这是**话题群**：每开一个话题就是一个独立会话，互不串上下文。' : '直接发消息即可开始对话。'}`),
    ]),
  );

  return `✅ 已创建${isTopic ? '**话题群**' : '群'}「${name}」（引擎: \`${engine}\`${profile ? ` · profile: \`${profile}\`` : ''} · cwd: \`${cwd}\`）${tagNote}，请到新群继续对话`;
};

function defaultChatName(agentName = 'Claude'): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${agentName} · ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 从 `/new chat` 参数里摘出项目目录 token（`@别名`、`/绝对路径` 或 `~/路径`），剩余部分作为群名 */
export function extractCwdTarget(topic: string): { rest: string; target?: string } {
  const target = topic.match(/(^|\s)(@\S+|\/\S+|~\/\S+)(?=\s|$)/)?.[2];
  if (!target) return { rest: topic };
  return { rest: topic.replace(target, ' ').replace(/\s+/g, ' ').trim(), target };
}

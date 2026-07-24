import { loadConfig, resolveConfigPath } from './config.js';
import { initLogger, log } from './logger.js';
import { logPath, callbackNoncesPath } from './paths.js';
import { buildClient, startWsController } from './feishu/client.js';
import { fetchMessageMedia, mediaPrompt, startMediaSweeper } from './feishu/media.js';
import { startKeepalive } from './feishu/keepalive.js';
import { Replier } from './feishu/replier.js';
import { Router } from './feishu/router.js';
import { SessionPool, parseThreadKey } from './engine/pool.js';
import { Session } from './engine/session.js';
import { CodexSession } from './agent/codex-session.js';
import { PendingQueue } from './engine/pending-queue.js';
import { ApiProfileStore } from './engine/api-profiles.js';
import type { EngineEvent } from './engine/events.js';
import { LiveStreamer } from './engine/streamer.js';
import { CostAggregator } from './engine/cost.js';
import { Persistence, type PersistedSession } from './engine/persistence.js';
import { createApprovalGate, buildCanUseTool } from './engine/hooks.js';
import { buildFeishuMcpServer } from './mcp/feishu-server.js';
import { buildCardActionHandler } from './feishu/card-action.js';
import { CallbackStore } from './feishu/callback-store.js';
import { ChatNameCache } from './feishu/chat-names.js';
import { buildThreadResolver } from './feishu/thread-id.js';
import { fetchForwardTranscript } from './feishu/forward.js';
import { buildCommentHandler } from './feishu/comments.js';
import { renderStatusCard } from './feishu/cards/status.js';
import { renderSessionListCard } from './feishu/cards/session.js';
import { renderHelpCard } from './feishu/cards/help.js';
import { card, cardHeader, md } from './feishu/cards/base.js';
import { askCommand } from './commands/ask.js';
import { sessionCommand } from './commands/session.js';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import { helpCommand } from './commands/help.js';
import { stopCommand } from './commands/stop.js';
import { makeUsageCommand } from './commands/usage.js';
import { projectCommand } from './commands/project.js';
import { cdCommand } from './commands/cd.js';
import { clearCommand } from './commands/clear.js';
import { newCommand } from './commands/newchat.js';
import { dangerCommand, reloadCommand } from './commands/danger.js';
import { profileCommand } from './commands/profile.js';
import { isAllowed } from './auth.js';

export async function main(opts?: { foreground?: boolean }): Promise<void> {
  const cfgPath = resolveConfigPath();
  const { config: cfg, meta: configMeta } = loadConfig(cfgPath);

  const foreground = opts?.foreground ?? process.stdout.isTTY;
  const logger = initLogger({
    level: cfg.log_level,
    filePath: foreground ? undefined : logPath(),
  });

  if (configMeta.usedLegacy) {
    logger.warn({ path: configMeta.path }, '正在使用旧路径配置文件，建议迁移到 ~/.chat-cc/config.yaml（运行 chat-cc init）');
  }

  if (!cfg.app_id || !cfg.app_secret) {
    logger.fatal('未配置 app_id / app_secret（config.yaml 或环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）');
    process.exit(1);
  }

  const client = buildClient(cfg);
  const replier = new Replier(client);
  const cost = new CostAggregator();
  const persistence = new Persistence(cfg.persistence_dir);
  const gate = createApprovalGate(replier);
  const apiProfiles = new ApiProfileStore();
  const chatNames = new ChatNameCache(replier);
  if (apiProfiles.available()) {
    logger.info(
      { profiles: apiProfiles.list().map((p) => p.name), current: apiProfiles.current()?.name },
      '检测到 cc-profiles.zsh，API profile 切换已启用（/profile）',
    );
  }

  const persistSession = (tk: string, wasActive?: boolean): void => {
    const meta = pool.getMeta(tk);
    if (!meta) return;
    const payload: PersistedSession = {
      threadKey: tk,
      cwd: meta.cwd,
      ...(meta.agent ? { agent: meta.agent } : {}),
      ...(meta.apiProfile ? { apiProfile: meta.apiProfile } : {}),
      ...(meta.danger !== undefined ? { danger: meta.danger } : {}),
      createdAt: meta.createdAt.toISOString(),
      lastUsedAt: new Date().toISOString(),
      cost: cost.get(tk),
    };
    if (meta.sessionId) payload.sessionId = meta.sessionId;
    if (wasActive) payload.wasActive = true;
    persistence.save(payload);
  };

  // 每个群最近一次用户消息时间：用于判断会话是否「前台」（用户正盯着看，不必推完成通知）
  const lastUserMsgAt = new Map<string, number>();

  const streamer = new LiveStreamer({
    replier,
    throttleMs: cfg.stream_throttle_ms,
    onResult: async (threadKey, usage, durationMs, ctx) => {
      if (usage) cost.add(threadKey, usage);
      const { chatId: srcChatId } = parseThreadKey(threadKey);
      // 「前台」= 用户刚在源群里发过消息（< notify_quiet_minutes），还盯着屏幕，无需任何提醒
      const last = lastUserMsgAt.get(srcChatId) ?? 0;
      const foreground =
        cfg.notify_quiet_minutes > 0 && Date.now() - last < cfg.notify_quiet_minutes * 60_000;
      if (foreground) return;
      const dur = durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : '';

      // 源群红点：卡片 PATCH 不产生未读提醒，后台会话完成时补发一条新消息（话题会话回到 thread）
      if (cfg.notify_done_ping && ctx) {
        await ctx.sendFollowUp(ctx.ok ? `✅ 处理完成${dur}` : `❌ 本轮失败${dur}，详见上方卡片`);
      }

      // 完成通知：聚合推送到 notify_chat_id（用项目名替代 threadKey）；通知群自己的 turn 不推
      if (cfg.notify_chat_id && usage && srcChatId !== cfg.notify_chat_id) {
        const cwd = pool.getMeta(threadKey)?.cwd;
        const project = cwd ? cwd.split('/').filter(Boolean).pop() ?? '' : '';
        const label = project || threadKey;
        await replier.sendText(
          cfg.notify_chat_id,
          `${ctx?.ok === false ? '✗' : '✓'} ${label} · in ${usage.inputTokens} · out ${usage.outputTokens}${dur}`,
        );
      }
    },
  });

  const pool = new SessionPool({
    idleTimeoutMs: cfg.idle_timeout_minutes * 60_000,
    idleCheckIntervalMs: cfg.idle_check_seconds * 1000,

    onNotice: (threadKey, n) => {
      const { chatId } = parseThreadKey(threadKey);
      void replier.sendCard(
        chatId,
        card(cardHeader('⚠️ 会话已重置', 'orange'), [
          md(`${n.text}（此前对话历史未能恢复）。\n\n直接继续发消息即可，新会话会正常累积上下文。`),
        ]),
      );
      // meta.sessionId 已被 pool 清空，落盘覆盖以清掉磁盘上的失效 id（防重启后再用旧 id resume）
      persistSession(threadKey);
    },

    createSession: (input) => {
      // 引擎：会话级显式选择 > 全局 config `agent`
      const engine = input.agent ?? cfg.agent;
      // 权限模式：会话级覆盖 > 全局 claude_danger_mode
      const danger = input.danger ?? cfg.claude_danger_mode;
      // —— Codex 引擎：codex exec 子进程（无 MCP/审批钩子，靠沙箱模式约束）——
      if (engine === 'codex') {
        return new CodexSession({
          threadKey: input.threadKey,
          cwd: input.cwd,
          codexBin: cfg.codex_bin,
          sandbox: danger ? 'danger-full-access' : cfg.codex_sandbox,
          ...(cfg.codex_model ? { model: cfg.codex_model } : {}),
          ...(input.resumeId ? { resumeId: input.resumeId } : {}),
          turnTimeoutMs: cfg.claude_session_timeout_min * 60_000,
          onEvent: input.onEvent,
          onNotice: input.onNotice,
        });
      }

      // —— Claude 引擎（默认）：Agent SDK streaming query ——
      const { threadKey, cwd, resumeId } = input;
      const { chatId } = parseThreadKey(threadKey);

      const currentAutoApprove = cfg.auto_approve_tools.map((s) => new RegExp(s));
      const currentMcpServer = buildFeishuMcpServer({
        replier,
        defaultChatId: cfg.notify_chat_id,
        allowedChats: cfg.allowed_chats,
        perChatRateLimitMs: cfg.mcp_feishu_rate_limit_ms,
      });

      const extra: Record<string, unknown> = {
        mcpServers: { feishu: currentMcpServer },
        thinking: { type: 'adaptive' },
        settings: { autoCompactEnabled: true },
      };
      // API profile：会话级覆盖 > 全局当前（可选功能）
      // SDK 的 env 是整体替换而非合并，必须 spread process.env
      const envOverrides = apiProfiles.envOverridesFor(input.apiProfile);
      if (Object.keys(envOverrides).length > 0) {
        extra['env'] = { ...process.env, ...envOverrides };
      }
      // canUseTool 始终安装、allowDangerouslySkipPermissions 始终开启：
      // 让 /danger 能通过 SDK setPermissionMode 在线双向切换（default ↔ bypassPermissions），
      // 免重启、不打断运行中的任务（见 Session.setDanger / pool.setSessionDanger）。
      // bypass 模式下 SDK 不会调用 canUseTool，行为与之前完全一致；
      // allowDangerouslySkipPermissions 仅是「允许使用 bypass 模式」的门控，不改变审批模式行为。
      // 已知无害副作用：danger 会话启动时 SDK 会 emitWarning 一条
      // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED（提示 bypass 下 canUseTool 不生效），可忽略。
      extra['allowDangerouslySkipPermissions'] = true;
      extra['canUseTool'] = buildCanUseTool({
        threadKey,
        chatId,
        gate,
        autoApprovePatterns: currentAutoApprove,
        timeoutMs: cfg.approval_timeout_ms,
      });
      return new Session({
        threadKey,
        cwd,
        allowedTools: cfg.claude_allowed_tools,
        ...(resumeId ? { resumeId } : {}),
        ...(danger ? { permissionMode: 'bypassPermissions' as const } : {}),
        extraOptions: extra as never,
        onEvent: input.onEvent,
        onNotice: input.onNotice,
      });
    },

    onStop: (threadKey, keepMeta) => {
      if (!keepMeta) persistence.delete(threadKey);
      // 会话被停止（/danger、/profile 重启、idle 回收、/session stop 等）时，
      // 被杀的 in-flight run 不会再产出 result/error 事件 —— 必须在此解锁 pending scope，
      // 否则该 threadKey 后续消息被静默吞掉（blocked 永不释放，只剩 60min 兜底）。
      // unblock 幂等；若停止期间有积压消息，会在静默窗口后正常 flush（重启场景投递给新会话）。
      pending.unblock(threadKey);
    },

    onEvent: async (threadKey, ev: EngineEvent) => {
      const { chatId } = parseThreadKey(threadKey);
      if (ev.kind === 'init') {
        persistSession(threadKey);
      }
      if (ev.kind === 'result') {
        const lvl = ev.ok ? 'info' : 'error';
        log()[lvl](
          { threadKey, ok: ev.ok, usage: ev.usage, durationMs: ev.durationMs, ...ev.detail },
          ev.ok ? 'SDK turn 完成' : `SDK turn 失败: ${ev.detail?.terminalReason ?? ev.text?.slice(0, 120)}`,
        );
      }
      if (ev.kind === 'error') {
        log().error({ threadKey, message: ev.message }, 'SDK 错误事件');
      }
      const tMeta = pool.getMeta(threadKey);
      await streamer.onEvent(chatId, threadKey, ev, tMeta?.cwd, tMeta?.agent ?? cfg.agent);
      if (ev.kind === 'result') {
        persistSession(threadKey, pool.isActiveForAnyUser(threadKey));
      }
      // run 结束：解锁 pending queue，把运行期间累积的消息带入下一轮
      if (ev.kind === 'result' || ev.kind === 'error') {
        pending.unblock(threadKey);
      }
    },
  });

  // 消息静默窗口队列：flush 时锁定 scope（同会话同时最多一个 run），
  // 合并消息投递给 Session；run 结束（result/error 事件）后 unblock
  const pending = new PendingQueue(cfg.message_debounce_ms, (threadKey, messages) => {
    pending.block(threadKey);
    const sess =
      pool.get(threadKey) ??
      (() => {
        const m = pool.getMeta(threadKey);
        return m ? pool.start(parseThreadKey(threadKey), m.cwd) : undefined;
      })();
    if (!sess) {
      log().warn({ threadKey }, 'pending flush 时会话不存在，丢弃消息');
      pending.unblock(threadKey);
      return;
    }
    sess.send(messages.join('\n\n'));
  });

  const priorSessions = persistence.loadAll();
  pool.prewarm(priorSessions);
  for (const s of priorSessions) {
    if (s.cost) cost.add(s.threadKey, s.cost);
  }

  const deps = { cfg, pool, replier, streamer, gate, configPath: cfgPath, pending, apiProfiles, chatNames };
  const router = new Router(replier, deps);
  router.register('ping', async () => `pong · chatcc v3 · ${new Date().toISOString()}`);
  router.register('help', helpCommand, ['h']);
  router.register('status', statusCommand);
  router.register('ask', askCommand);
  router.register('session', sessionCommand, ['ses']);
  router.register('s', sendCommand);
  router.register('stop', stopCommand);
  router.register('project', projectCommand, ['proj']);
  router.register('new', newCommand);
  router.register('cd', cdCommand);
  router.register('clear', clearCommand, ['reset']);
  router.register('danger', dangerCommand);
  router.register('profile', profileCommand);
  router.register('reload', reloadCommand);
  router.register(
    'usage',
    makeUsageCommand({
      getReport: async () => ({
        totals: cost.total(),
        byThread: cost.entries(),
        estimatedUsd: cost.estimateUsd(cost.total()),
      }),
    }),
  );

  const cardHandler = buildCardActionHandler({
    router,
    deps,
    callbackStore: new CallbackStore(callbackNoncesPath()),
    approvalResolver: (requestId: string, decision: 'allow' | 'deny') =>
      gate.resolve(requestId, decision),
    isAllowed: (senderId: string, chatId: string) => isAllowed(cfg, senderId, chatId),
    renderRefreshCard: (refresh, chatId, senderId) => {
      const userKey = `${chatId}|${senderId || chatId}`;
      switch (refresh) {
        case 'status': {
          const cur = apiProfiles.current();
          const ids = pool.list().map((s) => parseThreadKey(s.threadKey).chatId);
          return chatNames
            .resolveAll(ids)
            .then((names) =>
              renderStatusCard(cfg, pool, cfgPath, cur ? { name: cur.name, baseUrl: cur.baseUrl } : undefined, names),
            );
        }
        case 'session_list':
        case 'sessions':
          return renderSessionListCard(
            pool,
            { messageId: '', chatId, chatType: '', senderId, mentionBot: false },
            userKey,
          );
        case 'help':
          return renderHelpCard();
        default:
          return undefined;
      }
    },
  });

  const wsController = startWsController(cfg, router, {
    cardAction: cardHandler,
    threadResolver: buildThreadResolver(client),
    forwardResolver: (messageId) => fetchForwardTranscript(client, messageId),
    mediaResolver: async (messageId, msgType, rawContent) => {
      const media = await fetchMessageMedia(client, messageId, msgType, rawContent);
      return media ? mediaPrompt(media) : undefined;
    },
    commentHandler: buildCommentHandler({ client, cfg, apiProfiles }),
    onUserMessage: (meta) => lastUserMsgAt.set(meta.chatId, Date.now()),
  });
  const keepalive = startKeepalive({
    getState: () => wsController.getState(),
    forceReconnect: () => wsController.forceReconnect(),
  });
  // 媒体落盘定期清理：启动即清一次，此后每天一次（media_retention_days=0 关闭）
  const stopMediaSweeper = startMediaSweeper(cfg.media_retention_days);

  const shutdown = async (sig: string) => {
    log().info({ sig }, '收到信号，关闭');
    keepalive.stop();
    stopMediaSweeper();
    gate.clear();
    for (const item of pool.list()) {
      if (item.active) persistSession(item.threadKey, pool.isActiveForAnyUser(item.threadKey));
    }
    await pool.closeAll().catch((err) => log().error({ err }, 'closeAll 失败'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}


if (process.env['CHAT_CC_DAEMON'] === '1' || !process.argv[1]?.includes('cli')) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}

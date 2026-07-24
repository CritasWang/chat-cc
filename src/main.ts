import { loadConfig, resolveConfigPath, validateCwd } from './config.js';
import { initLogger, log } from './logger.js';
import { logPath, callbackNoncesPath, messageReceiptsPath } from './paths.js';
import { buildClient, startWsController } from './feishu/client.js';
import { fetchMessageMedia, mediaPrompt, startMediaSweeper } from './feishu/media.js';
import { startKeepalive } from './feishu/keepalive.js';
import { Replier } from './feishu/replier.js';
import { Router, type MessageMeta } from './feishu/router.js';
import { SessionPool, parseThreadKey } from './engine/pool.js';
import { Session } from './engine/session.js';
import { CodexSession } from './agent/codex-session.js';
import { PendingQueue } from './engine/pending-queue.js';
import { ApiProfileStore } from './engine/api-profiles.js';
import type { EngineEvent, UsageSnapshot } from './engine/events.js';
import { LiveStreamer } from './engine/streamer.js';
import { CostAggregator } from './engine/cost.js';
import { Persistence, type PersistedSession } from './engine/persistence.js';
import { createApprovalGate, buildCanUseTool } from './engine/hooks.js';
import { buildFeishuMcpServer, FeishuRateLimiter } from './mcp/feishu-server.js';
import { buildCardActionHandler } from './feishu/card-action.js';
import { CallbackStore } from './feishu/callback-store.js';
import { ChatNameCache } from './feishu/chat-names.js';
import { buildThreadResolver } from './feishu/thread-id.js';
import { fetchForwardTranscript } from './feishu/forward.js';
import { buildCommentHandler } from './feishu/comments.js';
import { MAX_STATUS_SESSIONS, renderStatusCard } from './feishu/cards/status.js';
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
import { buildAgentEnv } from './agent/env.js';
import { canAccessSession, listAccessibleSessions } from './commands/session-context.js';
import { isPrivileged } from './policy/owner.js';
import { MessageReceiptStore } from './feishu/message-receipts.js';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RECENT_CHAT_ACTIVITY = 1_000;

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
    throw new Error('未配置 app_id / app_secret');
  }
  if (!cfg.allow_all_users && cfg.allowed_users.length === 0 && cfg.allowed_chats.length === 0) {
    logger.fatal(
      '未配置访问白名单：请设置 allowed_users/allowed_chats，或明确设置 allow_all_users=true',
    );
    throw new Error('未配置访问白名单');
  }
  if (cfg.admin_users.length === 0) {
    logger.warn('admin_users 为空：danger/reload/profile 切换等敏感命令将全部拒绝');
  }
  const defaultCwd = validateCwd(cfg, cfg.default_cwd);
  if (!defaultCwd.ok) {
    logger.fatal({ cwd: defaultCwd.cwd, reason: defaultCwd.reason }, 'default_cwd 不可用');
    throw new Error(`default_cwd 不可用: ${defaultCwd.cwd}`);
  }
  cfg.default_cwd = defaultCwd.cwd;

  const client = buildClient(cfg);
  const replier = new Replier(client);
  const cost = new CostAggregator();
  const persistence = new Persistence(cfg.persistence_dir);
  const gate = createApprovalGate(replier);
  const apiProfiles = new ApiProfileStore();
  const chatNames = new ChatNameCache(replier);
  const threadResolver = buildThreadResolver(client);
  // 仅记录“当前正在执行的批次”发起者。排队中的后续消息不得提前覆盖它，
  // 否则话题群里后到用户可能误获前一批工具审批/AskUser 的操作权。
  const requesterByThread = new Map<string, string>();
  const feishuMcpRateLimiter = new FeishuRateLimiter();
  const messageReceipts = new MessageReceiptStore(messageReceiptsPath());
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
      ...(meta.sessionIdAgent ? { sessionIdAgent: meta.sessionIdAgent } : {}),
      ...(meta.apiProfile ? { apiProfile: meta.apiProfile } : {}),
      ...(meta.danger !== undefined ? { danger: meta.danger } : {}),
      createdAt: meta.createdAt.toISOString(),
      lastUsedAt: meta.lastUsedAt.toISOString(),
      cost: cost.get(tk),
    };
    if (meta.sessionId) payload.sessionId = meta.sessionId;
    if (wasActive !== undefined) payload.wasActive = wasActive;
    persistence.save(payload);
  };

  // 每个群最近一次用户消息时间：用于判断会话是否「前台」（用户正盯着看，不必推完成通知）
  const lastUserMsgAt = new Map<string, number>();

  const streamer = new LiveStreamer({
    replier,
    throttleMs: cfg.stream_throttle_ms,
    maxChunkSize: cfg.max_chunk_size,
    getInteractionContext: (threadKey) => ({
      requesterId: requesterByThread.get(threadKey) ?? parseThreadKey(threadKey).senderId,
      chatId: parseThreadKey(threadKey).chatId,
      generation: pool.generationOf(threadKey),
    }),
    onResult: async (threadKey, usage, durationMs, ctx) => {
      if (ctx?.interrupted) return;
      const { chatId: srcChatId } = parseThreadKey(threadKey);
      // 「前台」= 用户刚在源群里发过消息（< notify_quiet_minutes），还盯着屏幕，无需任何提醒
      const last = lastUserMsgAt.get(srcChatId) ?? 0;
      const foreground =
        cfg.notify_quiet_minutes > 0 && Date.now() - last < cfg.notify_quiet_minutes * 60_000;
      if (last > 0 && !foreground) lastUserMsgAt.delete(srcChatId);
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
    defaultAgent: () => cfg.agent,
    onMetaChange: (threadKey) => persistSession(threadKey, pool.isActiveForAnyUser(threadKey)),
    onActiveChange: (_userKey, previous, next) => {
      if (previous) persistSession(previous, false);
      if (next) persistSession(next, true);
    },
    idleTimeoutMs: cfg.idle_timeout_minutes * 60_000,
    idleCheckIntervalMs: cfg.idle_check_seconds * 1000,
    maxActiveSessions: cfg.max_active_sessions,
    isBusy: (threadKey) => pending.isBlocked(threadKey),

    onNotice: (threadKey, n) => {
      const { chatId } = parseThreadKey(threadKey);
      void streamer.sendNoticeCard(
        threadKey,
        chatId,
        card(cardHeader('⚠️ 会话已重置', 'orange'), [
          md(`${n.text}（此前对话历史未能恢复）。\n\n直接继续发消息即可，新会话会正常累积上下文。`),
        ]),
      );
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
          env: buildAgentEnv(),
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
        // MCP 反向发送默认只能回当前源群；额外目标必须显式进入 allowed_chats。
        allowedChats: [...new Set([chatId, cfg.notify_chat_id, ...cfg.allowed_chats].filter(Boolean))],
        perChatRateLimitMs: cfg.mcp_feishu_rate_limit_ms,
        rateLimiter: feishuMcpRateLimiter,
      });

      const extra: Record<string, unknown> = {
        mcpServers: { feishu: currentMcpServer },
        thinking: { type: 'adaptive' },
        settings: { autoCompactEnabled: true },
      };
      // API profile：会话级覆盖 > 全局当前（可选功能）
      const envOverrides = apiProfiles.envOverridesFor(input.apiProfile);
      extra['env'] = buildAgentEnv(envOverrides);
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
        getRequesterId: () => requesterByThread.get(threadKey) ?? parseThreadKey(threadKey).senderId,
        getReplyTarget: () => streamer.replyTargetOf(threadKey),
        autoApprovePatterns: currentAutoApprove,
        timeoutMs: cfg.approval_timeout_ms,
      });
      return new Session({
        threadKey,
        cwd,
        allowedTools: cfg.claude_allowed_tools,
        ...(resumeId ? { resumeId } : {}),
        ...(danger ? { permissionMode: 'bypassPermissions' as const } : {}),
        turnTimeoutMs: cfg.claude_session_timeout_min * 60_000,
        extraOptions: extra as never,
        onEvent: input.onEvent,
        onNotice: input.onNotice,
      });
    },

    onStop: (threadKey, keepMeta, reason) => {
      if (!keepMeta) {
        persistence.delete(threadKey);
        // destroy 后若保留内存 cost，同 key 重建会把已删除会话的旧成本重新写回磁盘。
        cost.reset(threadKey);
      }
      requesterByThread.delete(threadKey);
      // 清理直播 Turn：/clear、/cd、danger/profile 重启或 idle sweep 停止会话时，
      // 若旧 turn 未清除，同 threadKey 重启后 ensureTurn 会找到旧 turn 复用，造成
      // 旧 messageId/state 与新会话事件错配。markInterrupted 幂等（无可清时 no-op）。
      void streamer.discardTurn(threadKey);
      // 上下文重置/彻底销毁时，旧语义下积压的消息绝不能进入新 cwd/新上下文。
      if (reason === 'context-reset' || reason === 'destroy') {
        pending.clear(threadKey);
        return;
      }
      // 会话被临时停止（/danger、/profile 重启、idle 回收等）时，
      // 被杀的 in-flight run 不会再产出 result/error 事件 —— 必须在此解锁 pending scope，
      // 否则该 threadKey 后续消息被静默吞掉（blocked 永不释放，只剩 60min 兜底）。
      // unblock 幂等；若停止期间有积压消息，会在静默窗口后正常 flush（重启场景投递给新会话）。
      pending.unblock(threadKey);
    },

    onEvent: async (threadKey, ev: EngineEvent) => {
      const { chatId } = parseThreadKey(threadKey);
      const terminal = ev.kind === 'result' || ev.kind === 'error';
      if (ev.kind === 'result' && ev.usage) cost.add(threadKey, ev.usage);
      try {
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
      } catch (err) {
        // 飞书渲染/发送属于展示层，失败不能反向击穿 SDK pump。
        log().error({ err, threadKey, eventKind: ev.kind }, 'EngineEvent 展示处理失败');
      } finally {
        if (ev.kind === 'result') {
          persistSession(threadKey, pool.isActiveForAnyUser(threadKey));
        }
        if (terminal) {
          pending.unblock(threadKey);
          requesterByThread.delete(threadKey);
        }
      }
    },
  });

  // 消息静默窗口队列：flush 时锁定 scope（同会话同时最多一个 run），
  // 合并消息投递给 Session；run 结束（result/error 事件）后 unblock
  const pending = new PendingQueue(cfg.message_debounce_ms, (threadKey, messages, requesterIds) => {
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
    const requesterId = requesterIds[0] ?? parseThreadKey(threadKey).senderId;
    if (requesterId) requesterByThread.set(threadKey, requesterId);
    try {
      // 新 prompt 是明确的轮次边界：清掉可能因 idle /stop 未收到终态而残留的抑制标记。
      streamer.beginTurn(threadKey);
      sess.send(messages.join('\n\n'));
    } catch (err) {
      requesterByThread.delete(threadKey);
      throw err;
    }
  }, Math.max(60_000, cfg.claude_session_timeout_min * 60_000 + 60_000), {
    maxMessages: cfg.max_pending_messages_per_session,
    maxChars: cfg.max_pending_chars_per_session,
    maxFlushRetries: 3,
    onDiscard: async (threadKey, messages, _requesterIds, err) => {
      requesterByThread.delete(threadKey);
      const { chatId } = parseThreadKey(threadKey);
      log().error({ err, threadKey, count: messages.length }, '积压消息投递重试耗尽');
      await streamer.notifyQueueFailure(
        threadKey,
        chatId,
        '❌ 消息连续投递失败，已停止自动重试，避免重复执行。请确认会话状态后重新发送。',
      );
    },
  });

  const persistedSessions = persistence.loadAll();
  const priorSessions = persistedSessions.flatMap((session) => {
    const checked = validateCwd(cfg, session.cwd);
    if (!checked.ok) {
      log().warn(
        { threadKey: session.threadKey, cwd: checked.cwd, reason: checked.reason },
        '持久化会话 cwd 已不在允许范围，本次不预热（文件保留）',
      );
      return [];
    }
    return [{ ...session, cwd: checked.cwd }];
  });
  // 旧 2 段 key 与已迁移 3 段 key 可能在异常退出后短暂并存。按最后使用时间排序，
  // 让较新的 metadata 覆盖旧项；cost 也只取同一规范 key 的最新快照，避免双计。
  priorSessions.sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt));
  pool.prewarm(priorSessions);
  const latestCostByKey = new Map<string, UsageSnapshot>();
  for (const s of priorSessions) {
    const normalizedKey = s.threadKey.split(':').length < 3 ? `${s.threadKey}:default` : s.threadKey;
    if (s.cost) latestCostByKey.set(normalizedKey, s.cost);
  }
  for (const [threadKey, usage] of latestCostByKey) cost.add(threadKey, usage);
  // 把重复 wasActive、旧 2 段 threadKey 等预热迁移结果主动归一化回磁盘。
  for (const s of priorSessions) {
    if (s.threadKey.split(':').length < 3) persistence.delete(s.threadKey);
  }
  for (const s of pool.list()) persistSession(s.threadKey, pool.isActiveForAnyUser(s.threadKey));

  const deps = {
    cfg,
    pool,
    replier,
    streamer,
    gate,
    configPath: cfgPath,
    pending,
    apiProfiles,
    chatNames,
    requestRestart: scheduleDaemonRestart,
  };
  const router = new Router(replier, deps);
  router.register('ping', async () => `pong · chatcc v4 · ${new Date().toISOString()}`);
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
      getReport: async (meta: MessageMeta) => {
        const byThread = cost.entries().filter((entry) => canAccessSession(meta, entry.threadKey));
        const totals = sumUsage(byThread.map((entry) => entry.usage));
        return {
          totals,
          byThread,
          actualUsd: totals.costUsd,
          estimatedUsd: cost.estimateUsd(totals),
        };
      },
    }),
  );

  const cardHandler = buildCardActionHandler({
    router,
    deps,
    callbackStore: new CallbackStore(callbackNoncesPath()),
    approvalResolver: (requestId, decision, actor) => gate.resolve(requestId, decision, actor),
    isAllowed: (senderId: string, chatId: string) => isAllowed(cfg, senderId, chatId),
    isPrivileged: (senderId: string) => isPrivileged(cfg, senderId),
    resolveThreadId: (chatId, messageId) => threadResolver.resolve(chatId, messageId),
    renderRefreshCard: (refresh, actionMeta) => {
      const userKey = `${actionMeta.chatId}|${actionMeta.senderId || actionMeta.chatId}`;
      switch (refresh) {
        case 'status': {
          const cur = isPrivileged(cfg, actionMeta.senderId) ? apiProfiles.current() : undefined;
          const sessions = listAccessibleSessions(actionMeta, pool);
          const ids = sessions
            .slice(0, MAX_STATUS_SESSIONS)
            .map((s) => parseThreadKey(s.threadKey).chatId);
          return chatNames
            .resolveAll(ids)
            .then((names) =>
              renderStatusCard(
                cfg,
                pool,
                cfgPath,
                cur ? { name: cur.name, baseUrl: cur.baseUrl } : undefined,
                names,
                sessions,
              ),
            );
        }
        case 'session_list':
        case 'sessions':
          return renderSessionListCard(
            pool,
            actionMeta,
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
    threadResolver,
    forwardResolver: (messageId) => fetchForwardTranscript(client, messageId),
    mediaResolver: async (messageId, msgType, rawContent) => {
      const media = await fetchMessageMedia(client, messageId, msgType, rawContent);
      return media ? mediaPrompt(media) : undefined;
    },
    commentHandler: buildCommentHandler({ client, cfg, apiProfiles }),
    onUserMessage: (meta) => recordRecentActivity(lastUserMsgAt, meta.chatId),
    messageReceipts,
    onMessageError: async (meta) => {
      await replier.replyText(
        meta.messageId,
        '❌ 消息处理失败，未确认执行成功。请稍后重试；若持续失败可运行 `chat-cc logs` 查看原因。',
        { inThread: Boolean(meta.threadId) },
      );
    },
  });
  const keepalive = startKeepalive({
    getState: () => wsController.getState(),
    forceReconnect: () => wsController.forceReconnect(),
  });
  // 媒体落盘定期清理：启动即清一次，此后每天一次（media_retention_days=0 关闭）
  const stopMediaSweeper = startMediaSweeper(cfg.media_retention_days);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log().info({ sig }, '收到信号，关闭');
    keepalive.stop();
    wsController.close();
    stopMediaSweeper();
    gate.clear();
    for (const item of pool.list()) {
      persistSession(item.threadKey, pool.isActiveForAnyUser(item.threadKey));
    }
    await pool.closeAll().catch((err) => log().error({ err }, 'closeAll 失败'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 只有所有组件和退出处理器均已安装后才向父进程确认就绪，避免父进程
  // 刚写入 pid 后收到 SIGTERM，而子进程仍处在默认信号处理窗口。
  if (typeof process.send === 'function' && process.connected) {
    try { process.send({ type: 'ready', pid: process.pid }); } catch { /* parent 已退出 */ }
  }
}

let daemonRestartScheduled = false;

function scheduleDaemonRestart(): boolean {
  if (process.env['CHAT_CC_DAEMON'] !== '1') return false;
  if (daemonRestartScheduled) return true;
  const cliEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'cli', 'index.js');
  if (!existsSync(cliEntry)) return false;
  daemonRestartScheduled = true;
  const timer = setTimeout(() => {
    try {
      const child = spawn(process.execPath, [cliEntry, 'restart'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.once('error', (err) => {
        daemonRestartScheduled = false;
        log().error({ err }, 'daemon 重启子进程启动失败');
      });
      child.unref();
    } catch (err) {
      daemonRestartScheduled = false;
      log().error({ err }, '安排 daemon 重启失败');
    }
  }, 1_500);
  timer.unref?.();
  return true;
}

function sumUsage(items: UsageSnapshot[]): UsageSnapshot {
  const total: UsageSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  for (const item of items) {
    total.inputTokens += item.inputTokens;
    total.outputTokens += item.outputTokens;
    total.cacheReadTokens += item.cacheReadTokens;
    total.cacheCreationTokens += item.cacheCreationTokens;
    if (item.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + item.costUsd;
    if (item.model) total.model = item.model;
  }
  return total;
}

function recordRecentActivity(activity: Map<string, number>, chatId: string): void {
  activity.delete(chatId);
  activity.set(chatId, Date.now());
  while (activity.size > MAX_RECENT_CHAT_ACTIVITY) {
    const oldest = activity.keys().next().value as string | undefined;
    if (!oldest) break;
    activity.delete(oldest);
  }
}


const invokedAsMain = Boolean(
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (process.env['CHAT_CC_DAEMON'] === '1' || invokedAsMain) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('fatal:', err);
    if (typeof process.send === 'function' && process.connected) {
      try {
        process.send({ type: 'startup-error', message }, () => process.exit(1));
        return;
      } catch { /* parent 已退出 */ }
    }
    process.exit(1);
  });
}

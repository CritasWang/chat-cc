import { loadConfig, resolveConfigPath } from './config.js';
import { initLogger, log } from './logger.js';
import { logPath } from './paths.js';
import { buildClient, buildWsClient, startDispatcher } from './feishu/client.js';
import { Replier } from './feishu/replier.js';
import { Router } from './feishu/router.js';
import { SessionPool, parseThreadKey } from './engine/pool.js';
import type { EngineEvent } from './engine/events.js';
import { LiveStreamer } from './engine/streamer.js';
import { CostAggregator } from './engine/cost.js';
import { Persistence, type PersistedSession } from './engine/persistence.js';
import { createApprovalGate, buildCanUseTool } from './engine/hooks.js';
import { buildFeishuMcpServer } from './mcp/feishu-server.js';
import { buildCardActionHandler } from './feishu/card-action.js';
import { renderStatusCard } from './feishu/cards/status.js';
import { renderSessionListCard } from './feishu/cards/session.js';
import { renderHelpCard } from './feishu/cards/help.js';
import { askCommand } from './commands/ask.js';
import { sessionCommand } from './commands/session.js';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import { helpCommand } from './commands/help.js';
import { stopCommand } from './commands/stop.js';
import { makeUsageCommand } from './commands/usage.js';
import { projectCommand } from './commands/project.js';
import { dangerCommand, reloadCommand } from './commands/danger.js';
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

  const persistSession = (tk: string, wasActive?: boolean): void => {
    const meta = pool.getMeta(tk);
    if (!meta) return;
    const payload: PersistedSession = {
      threadKey: tk,
      cwd: meta.cwd,
      createdAt: meta.createdAt.toISOString(),
      lastUsedAt: new Date().toISOString(),
      cost: cost.get(tk),
    };
    if (meta.sessionId) payload.sessionId = meta.sessionId;
    if (wasActive) payload.wasActive = true;
    persistence.save(payload);
  };

  const streamer = new LiveStreamer({
    replier,
    throttleMs: cfg.stream_throttle_ms,
    onResult: async (threadKey, usage, durationMs) => {
      if (usage) cost.add(threadKey, usage);
      // 完成通知：推送到 notify_chat_id（用项目名替代 threadKey）
      if (cfg.notify_chat_id && usage) {
        const cwd = pool.getMeta(threadKey)?.cwd;
        const project = cwd ? cwd.split('/').filter(Boolean).pop() ?? '' : '';
        const label = project || threadKey;
        const dur = durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : '';
        await replier.sendText(
          cfg.notify_chat_id,
          `✓ ${label} · in ${usage.inputTokens} · out ${usage.outputTokens}${dur}`,
        );
      }
    },
  });

  const pool = new SessionPool({
    idleTimeoutMs: cfg.idle_timeout_minutes * 60_000,
    idleCheckIntervalMs: cfg.idle_check_seconds * 1000,

    buildConfig: (threadKey, cwd, resumeId) => {
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
      if (cfg.claude_danger_mode) {
        extra['allowDangerouslySkipPermissions'] = true;
      } else {
        extra['canUseTool'] = buildCanUseTool({
          threadKey,
          chatId,
          gate,
          autoApprovePatterns: currentAutoApprove,
          timeoutMs: cfg.approval_timeout_ms,
        });
      }
      return {
        threadKey,
        cwd,
        allowedTools: cfg.claude_allowed_tools,
        ...(resumeId ? { resumeId } : {}),
        ...(cfg.claude_danger_mode ? { permissionMode: 'bypassPermissions' as const } : {}),
        extraOptions: extra as never,
      };
    },

    onStop: (threadKey, keepMeta) => {
      if (!keepMeta) persistence.delete(threadKey);
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
      await streamer.onEvent(chatId, threadKey, ev, pool.getMeta(threadKey)?.cwd);
      if (ev.kind === 'result') {
        persistSession(threadKey, pool.isActiveForAnyUser(threadKey));
      }
    },
  });

  const priorSessions = persistence.loadAll();
  pool.prewarm(priorSessions);
  for (const s of priorSessions) {
    if (s.cost) cost.add(s.threadKey, s.cost);
  }

  const deps = { cfg, pool, replier, streamer, gate, configPath: cfgPath };
  const router = new Router(replier, deps);
  router.register('ping', async () => `pong · chatcc v3 · ${new Date().toISOString()}`);
  router.register('help', helpCommand, ['h']);
  router.register('status', statusCommand);
  router.register('ask', askCommand);
  router.register('session', sessionCommand, ['ses']);
  router.register('s', sendCommand);
  router.register('stop', stopCommand);
  router.register('project', projectCommand, ['proj']);
  router.register('danger', dangerCommand);
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
    approvalResolver: (requestId: string, decision: 'allow' | 'deny') =>
      gate.resolve(requestId, decision),
    isAllowed: (senderId: string, chatId: string) => isAllowed(cfg, senderId, chatId),
    renderRefreshCard: (refresh, chatId, senderId) => {
      const userKey = senderId || chatId;
      switch (refresh) {
        case 'status':
          return renderStatusCard(cfg, pool, cfgPath);
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

  const ws = buildWsClient(cfg);
  startDispatcher(ws, cfg, router, { cardAction: cardHandler });

  const shutdown = async (sig: string) => {
    log().info({ sig }, '收到信号，关闭');
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

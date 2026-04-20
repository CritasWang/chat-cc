import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { initLogger, log } from './logger.js';
import { buildClient, buildWsClient, startDispatcher } from './feishu/client.js';
import { Replier } from './feishu/replier.js';
import { Router } from './feishu/router.js';
import { SessionPool, type ThreadKey } from './engine/pool.js';
import type { EngineEvent } from './engine/events.js';
import { LiveStreamer } from './engine/streamer.js';
import { Monitor } from './engine/monitor.js';
import { CostAggregator } from './engine/cost.js';
import { Persistence, type PersistedSession } from './engine/persistence.js';
import { createApprovalGate, buildCanUseTool } from './engine/hooks.js';
import { buildFeishuMcpServer } from './mcp/feishu-server.js';
import { buildCardActionHandler } from './feishu/card-action.js';
import { askCommand } from './commands/ask.js';
import { sessionCommand } from './commands/session.js';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import { helpCommand } from './commands/help.js';
import { stopCommand } from './commands/stop.js';
import { makeUsageCommand } from './commands/usage.js';
import { projectCommand } from './commands/project.js';
import { dangerCommand, reloadCommand } from './commands/danger.js';

async function main(): Promise<void> {
  const cfgPath =
    process.env['CHATCC_CONFIG'] ??
    (existsSync('./config.local.yaml') ? './config.local.yaml' : './config.yaml');
  const cfg = loadConfig(cfgPath);
  const logger = initLogger(cfg.log_level);

  if (!cfg.app_id || !cfg.app_secret) {
    logger.fatal('未配置 app_id / app_secret（config.yaml 或环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）');
    process.exit(1);
  }

  const client = buildClient(cfg);
  const replier = new Replier(client);
  const cost = new CostAggregator();
  const persistence = new Persistence(cfg.persistence_dir);
  const gate = createApprovalGate(replier);

  const persistSession = (tk: string): void => {
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
    persistence.save(payload);
  };

  const streamer = new LiveStreamer({
    replier,
    throttleMs: cfg.stream_throttle_ms,
    onResult: async (threadKey, usage) => {
      if (usage) cost.add(threadKey, usage);
    },
  });

  const monitor = new Monitor(replier, cfg.status_push_chat_id || cfg.notify_chat_id);

  const autoApprovePatterns = cfg.auto_approve_tools.map((s) => new RegExp(s));
  const mcpServer = buildFeishuMcpServer({
    replier,
    defaultChatId: cfg.notify_chat_id,
    allowedChats: cfg.allowed_chats,
    perChatRateLimitMs: cfg.mcp_feishu_rate_limit_ms,
  });

  const pool = new SessionPool({
    idleTimeoutMs: cfg.idle_timeout_minutes * 60_000,
    idleCheckIntervalMs: cfg.idle_check_seconds * 1000,

    buildConfig: (threadKey, cwd, resumeId) => {
      const { chatId } = parseThreadKey(threadKey);
      const extra: Record<string, unknown> = {
        mcpServers: { feishu: mcpServer },
      };
      if (cfg.claude_danger_mode) {
        extra['allowDangerouslySkipPermissions'] = true;
      } else {
        extra['canUseTool'] = buildCanUseTool({
          threadKey,
          chatId,
          gate,
          autoApprovePatterns,
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

    onEvent: async (threadKey, ev: EngineEvent) => {
      const { chatId } = parseThreadKey(threadKey);
      if (ev.kind === 'init') {
        persistSession(threadKey);
      }
      await streamer.onEvent(chatId, threadKey, ev);
      if (ev.kind === 'result') {
        await monitor.onResult(threadKey, ev.usage, ev.durationMs);
        persistSession(threadKey);
      }
    },
  });

  const priorSessions = persistence.loadAll();
  pool.prewarm(priorSessions);
  for (const s of priorSessions) {
    if (s.cost) cost.add(s.threadKey, s.cost);
  }

  const deps = { cfg, pool, replier, streamer };
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

  const isAllowed = (senderId: string, chatId: string): boolean => {
    if (cfg.allowed_users.length === 0 && cfg.allowed_chats.length === 0) return true;
    if (cfg.allowed_users.includes(senderId)) return true;
    if (cfg.allowed_chats.includes(chatId)) return true;
    return false;
  };

  const cardHandler = buildCardActionHandler({
    router,
    deps,
    approvalResolver: (requestId: string, decision: 'allow' | 'deny') =>
      gate.resolve(requestId, decision),
    isAllowed,
  });

  const ws = buildWsClient(cfg);
  startDispatcher(ws, cfg, router, { cardAction: cardHandler });

  const shutdown = async (sig: string) => {
    log().info({ sig }, '收到信号，关闭');
    gate.clear();
    for (const item of pool.list()) {
      if (item.active) persistSession(item.threadKey);
    }
    await pool.closeAll().catch((err) => log().error({ err }, 'closeAll 失败'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function parseThreadKey(tk: string): ThreadKey {
  const idx = tk.indexOf(':');
  if (idx < 0) return { chatId: tk, senderId: '' };
  return { chatId: tk.slice(0, idx), senderId: tk.slice(idx + 1) };
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

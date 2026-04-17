import { existsSync } from 'node:fs';
import { loadConfig, type Config } from './config.js';
import { initLogger, log } from './logger.js';
import { buildClient, buildWsClient, startDispatcher } from './feishu/client.js';
import { Replier } from './feishu/replier.js';
import { Router } from './feishu/router.js';
import { SessionPool, type ThreadKey } from './engine/pool.js';
import type { EngineEvent, UsageSnapshot } from './engine/events.js';
import { LiveStreamer } from './engine/streamer.js';
import { Monitor } from './engine/monitor.js';
import { CostAggregator } from './engine/cost.js';
import { Persistence } from './engine/persistence.js';
import { createApprovalGate, buildCanUseTool, type ApprovalGate } from './engine/hooks.js';
import { buildFeishuMcpServer } from './mcp/feishu-server.js';
import { buildCardActionHandler, startCardHttpServer } from './feishu/card-action.js';
import { askCommand } from './commands/ask.js';
import { sessionCommand } from './commands/session.js';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import { helpCommand } from './commands/help.js';
import { stopCommand } from './commands/stop.js';
import { makeUsageCommand } from './commands/usage.js';

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

  const streamer = new LiveStreamer({
    replier,
    throttleMs: cfg.stream_throttle_ms,
    onResult: async (threadKey, usage) => {
      if (usage) cost.add(threadKey, usage);
      persistSession(persistence, threadKey, cost.get(threadKey));
    },
  });

  const monitor = new Monitor(replier, cfg.status_push_chat_id || cfg.notify_chat_id);
  const pool = createPool(cfg, replier, streamer, monitor, gate);

  // 预热：磁盘已有的会话 metadata 加载进 cost（但不 spawn session，lazy）
  for (const s of persistence.loadAll()) {
    if (s.cost) cost.add(s.threadKey, s.cost);
  }

  const router = new Router(replier, { cfg, pool, replier });
  router.register('ping', async () => `pong · chatcc v3 · ${new Date().toISOString()}`);
  router.register('help', helpCommand, ['h']);
  router.register('status', statusCommand);
  router.register('ask', askCommand);
  router.register('session', sessionCommand, ['ses']);
  router.register('s', sendCommand);
  router.register('stop', stopCommand);
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

  const ws = buildWsClient(cfg);
  startDispatcher(ws, cfg, router);

  const cardHandler = buildCardActionHandler({
    router,
    deps: { cfg, pool, replier },
    approvalResolver: (requestId, decision) => gate.resolve(requestId, decision),
  });
  const httpServer = startCardHttpServer(cardHandler, cfg.card_webhook_port, cfg.card_webhook_path);

  const shutdown = async (sig: string) => {
    log().info({ sig }, '收到信号，关闭');
    gate.clear();
    httpServer.close();
    await pool.closeAll().catch((err) => log().error({ err }, 'closeAll 失败'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function createPool(
  cfg: Config,
  replier: Replier,
  streamer: LiveStreamer,
  monitor: Monitor,
  gate: ApprovalGate,
): SessionPool {
  const autoApprovePatterns = cfg.auto_approve_tools.map((s) => new RegExp(s));

  const mcpServer = buildFeishuMcpServer({
    replier,
    defaultChatId: cfg.notify_chat_id,
    allowedChats: cfg.allowed_chats,
    perChatRateLimitMs: cfg.mcp_feishu_rate_limit_ms,
  });

  return new SessionPool({
    buildConfig: (threadKey, cwd) => {
      const { chatId } = parseThreadKey(threadKey);
      const extra: Record<string, unknown> = {
        mcpServers: { feishu: mcpServer },
      };
      if (!cfg.claude_danger_mode) {
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
        ...(cfg.claude_danger_mode ? { permissionMode: 'bypassPermissions' as const } : {}),
        extraOptions: extra as never,
      };
    },
    onEvent: async (threadKey, ev: EngineEvent) => {
      const { chatId } = parseThreadKey(threadKey);
      await streamer.onEvent(chatId, threadKey, ev);
      if (ev.kind === 'result') {
        await monitor.onResult(threadKey, ev.usage, ev.durationMs);
      }
    },
  });
}

function persistSession(p: Persistence, threadKey: string, usage: UsageSnapshot): void {
  p.save({
    threadKey,
    cwd: '',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    cost: usage,
  });
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

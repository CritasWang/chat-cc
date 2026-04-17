# chatcc v3 · AGENTS.md

面向在本代码库工作的 AI agent。v2 的 Go 版本仍活在 `main` 分支；本 worktree（`v3` 分支）是用 TypeScript + `@anthropic-ai/claude-agent-sdk` 的完整重写。

## 一句话总览

飞书 WebSocket 收到消息 → 路由到命令 → 命令操作长驻 `SessionPool` → SDK 的 `query()` async generator 产出 `SDKMessage` → `engine/events.ts` 翻译成 `EngineEvent` → `LiveStreamer` 事件驱动 PATCH 卡片；`canUseTool` 弹审批卡片阻塞等飞书按钮回调；MCP server 暴露反向能力让 Claude 回打飞书。

## 绝对不要做的事

- 不要重新引入 tmux、`capture-pane`、ANSI stripping 的任何变体，那是 v2 的设计债务。
- 不要基于 `hook_port` 做 HTTP shell hook。v3 用 SDK 的 in-process hooks。
- 不要让 engine 直接 `import` 具体卡片渲染函数。engine 只发 `EngineEvent`，渲染归 `feishu/cards/*`。
- Session 的 cwd 必须从 config 的 `default_cwd` 或 `/session start @alias` 解析来，不要写死。

## 代码地图

```
src/main.ts                      装配入口（读 config → 构造 Replier/Pool/Streamer/Router → 启动 WSClient + 卡片 HTTP server）
src/config.ts                    YAML + zod 校验 + env 覆盖 + @别名解析
src/engine/
  session.ts                     每 thread 一个 query()；内部 MessageQueue 做 streaming input
  pool.ts                        threadKey 映射 + 活跃会话指针
  streamer.ts                    LiveStreamer：每 thread 一张「当前直播卡」，throttle PATCH
  monitor.ts                     result 事件 → 通知群
  hooks.ts                       canUseTool + ApprovalGate（pending 审批 Map）
  cost.ts                        CostAggregator（per-thread + total + 估算 USD）
  persistence.ts                 `data/sessions/<safe>.json` 读写
  events.ts                      SDKMessage → EngineEvent（init/assistant-text/tool-use/tool-result/result/error）
src/feishu/
  client.ts                      Lark.Client、WSClient、EventDispatcher（只订阅 im.message.receive_v1）
  router.ts                      命令分发（/前缀）+ 非命令消息自动 → 活跃会话 → /ask 回退
  replier.ts                     sendText / sendCard / replyText / replyCard / patchCard（含 EOF/ECONN 指数退避）
  card-action.ts                 Lark.CardActionHandler + HTTP server，按钮 value 的 __approve 路由到 ApprovalGate.resolve
  cards/                         base.ts（header/markdown/button/divider/card）+ live / approval / cost
src/mcp/feishu-server.ts         createSdkMcpServer，暴露 send_message + ping
src/commands/                    ask / session / send / stop / usage / status / help
```

## 数据结构约定

- **threadKey**: `"{chatId}:{senderId}"`，唯一会话标识。`parseThreadKey()` 拆解。
- **SenderKey**（活跃会话归属）: `senderId || chatId`。
- **按钮 value**: `{ cmd, args?, echo?, decision? }`。`cmd === '__approve'` 保留给审批，其余经 router 执行 `/cmd args`。

## 类型修复速查

- SDK 的 `SDKAssistantMessage.message.content` 是 `BetaContentBlock[]`，不要直接断言 `Record<string,unknown>[]` — 必须先 `as unknown as`。`events.ts` 已处理。
- `@anthropic-ai/claude-agent-sdk@^0.2` 的 peer 是 `zod@^4.0.0`。不要锁回 zod 3，会 ERESOLVE。
- `Lark.EventReceive<T>` 不是公开导出类型。用本地 lean interface，只描述你真正读的字段。

## 构建与验证

```bash
npm run typecheck    # 零警告
npm run build
CHATCC_CONFIG=/nonexistent FEISHU_APP_ID= FEISHU_APP_SECRET= node dist/main.js
# 预期：fatal log，退出
```

真实联通需要：
1. 飞书后台配置卡片回调 URL 指向 `card_webhook_port` + `card_webhook_path`
2. 填 `app_id` / `app_secret`（或 env）
3. `npm run dev`

## 里程碑完成度（v3.0.0-alpha.1）

- [x] M1 地基
- [x] M2 会话池 + 命令集
- [x] M3 事件驱动实况 + 卡片
- [x] M4 审批 hook + MCP
- [x] M5 持久化 + cost
- [x] M6 精确中断 + rate limit
- [ ] M7 真实端到端联通验证 + v3 → main 合并（需要人工跑飞书）

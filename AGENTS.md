# chat-cc · AGENTS.md

面向在本代码库工作的 AI agent。本项目是 `chat-cc`（npm 全局 CLI），用 TypeScript + `@anthropic-ai/claude-agent-sdk` 构建。v2 Go 版本保留在 `v2_go` 分支。

## 一句话总览

`chat-cc start` 启动守护进程 → 飞书 WebSocket 收消息 → 路由到命令 → 命令操作 `SessionPool` → SDK `query()` async generator 产出 `SDKMessage` → `engine/events.ts` 翻译成 `EngineEvent` → `LiveStreamer` 事件驱动 PATCH 卡片；`canUseTool` 弹审批卡片阻塞等回调；MCP server 暴露反向能力让 Claude 回打飞书。

## 绝对不要做的事

- 不要重新引入 tmux、`capture-pane`、ANSI stripping 的任何变体，那是 v2 的设计债务。
- 不要基于 HTTP hook server 做回调。v3 用 SDK in-process hooks + 飞书 WS 卡片回调。
- 不要让 engine 直接 `import` 具体卡片渲染函数。engine 只发 `EngineEvent`，渲染归 `feishu/cards/*`。
- Session 的 cwd 必须从 config 的 `default_cwd` 或 `/session start @alias` 解析来，不要写死。
- 不要硬编码路径。所有运行时路径通过 `src/paths.ts` 获取（`chatccHome()`、`configPath()`、`pidPath()` 等）。

## 代码地图

```
src/
├─ cli/                          CLI 子命令（chat-cc init/start/stop/restart/status/logs/config/doctor/version）
│  ├─ index.ts                   argv 解析 + 子命令分发（bin 入口）
│  ├─ daemon.ts                  start（fork+detach+PID）/ stop（SIGTERM→SIGKILL）/ restart / status
│  ├─ init.ts                    交互式配置向导 → ~/.chat-cc/config.yaml
│  ├─ logs.ts                    日志查看/tail -f
│  ├─ config-cmd.ts              config get/set/edit/path
│  ├─ doctor.ts                  环境健康检查
│  └─ version.ts                 版本信息
├─ paths.ts                      ~/.chat-cc/ 路径解析（CHAT_CC_HOME / CHAT_CC_CONFIG 覆盖）
├─ main.ts                       服务入口（读 config → 构造 Replier/Pool/Streamer/Router → 启动 WSClient）
├─ config.ts                     YAML + zod 校验 + env 覆盖 + 路径优先级 + @别名解析
├─ logger.ts                     pino（后台写文件 / 前台 pino-pretty 双模式）
├─ engine/
│  ├─ session.ts                 每 thread 一个 query()；内部 MessageQueue 做 streaming input
│  ├─ pool.ts                    threadKey 映射 + 活跃会话指针 + 空闲回收 + 磁盘预热
│  ├─ streamer.ts                LiveStreamer：每 thread 一张「当前直播卡」，throttle PATCH
│  ├─ monitor.ts                 result 事件 → 通知群
│  ├─ hooks.ts                   canUseTool + ApprovalGate（pending 审批 Map）
│  ├─ cost.ts                    CostAggregator（per-thread + total + 估算 USD）
│  ├─ persistence.ts             ~/.chat-cc/sessions/<safe>.json 读写
│  └─ events.ts                  SDKMessage → EngineEvent（init/assistant-text/tool-use/tool-result/result/error）
├─ feishu/
│  ├─ client.ts                  Lark.Client、WSClient、EventDispatcher（im.message.receive_v1 + card.action.trigger）
│  ├─ router.ts                  命令分发（/前缀）+ 非命令消息自动 → 活跃会话 → /ask 回退
│  ├─ replier.ts                 sendText / sendCard / replyText / replyCard / patchCard（含指数退避重试）
│  ├─ card-action.ts             WS CardActionHandler，按钮 value 的 __approve 路由到 ApprovalGate.resolve
│  └─ cards/                     base.ts（header/markdown/button/divider/card）+ live / approval / cost / session / help / status / ask-user
├─ mcp/
│  └─ feishu-server.ts           createSdkMcpServer，暴露 send_message + ping
└─ commands/                     ask / session / send / stop / usage / status / help / project / danger / reload
```

## 配置路径优先级

`$CHAT_CC_CONFIG` > `$CHAT_CC_HOME/config.yaml` > `~/.chat-cc/config.yaml` > `./config.local.yaml`（兼容）> `./config.yaml`（兼容）

检测到旧路径时自动 fallback 并 warn 迁移。

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
npm run build        # 编译到 dist/

# CLI 快速验证
node dist/cli/index.js --help
node dist/cli/index.js version
node dist/cli/index.js doctor

# 前台启动（需要有效的飞书凭证）
node dist/cli/index.js start --foreground

# 开发模式
npm run dev          # tsx watch（前台运行）
```

## 发布

通过 GitHub Release 触发自动 npm publish（`.github/workflows/publish.yml`）：
1. 确认 `package.json` version 与目标 tag 一致
2. 在 GitHub 创建 Release → tag `vX.Y.Z` → target `main`
3. Actions 自动 typecheck → build → 版本校验 → `npm publish --provenance`

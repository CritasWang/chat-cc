# chatcc v3

飞书 ↔ Claude Code 远程控制网关 — v3 版本。

v3 用 **TypeScript + Claude Agent SDK** 重写。彻底抛弃 v2 的 `tmux capture-pane` + 0.5s 轮询 + ANSI stripping 体系，改为 SDK 原生 JSON 事件流 + in-process hooks + 飞书反向 MCP server。

## 和 v2 的主要差异

| 维度 | v2 (Go) | v3 (TS) |
|---|---|---|
| 会话执行 | tmux 子进程 + 屏幕抓取 | `@anthropic-ai/claude-agent-sdk` 的 `query()` + 长驻 async generator |
| 输出解析 | ANSI 转义正则清洗 | 结构化 `SDKMessage` 事件流（assistant/tool_use/tool_result/result） |
| 实况转播 | 每 3 秒轮询 PATCH | 事件驱动 PATCH（默认 throttle 500ms） |
| 中断 | tmux `send-keys` Ctrl-C 模拟 | `query.interrupt()`，SDK 保证下一个工具边界停 |
| 工具审批 | 无（danger mode 或配置白名单） | 每次高危工具调用出「✅ 允许 / ❌ 拒绝」卡片，in-process `canUseTool` 回调 |
| 飞书反向能力 | 无 | in-process MCP server（`mcp__feishu__send_message` / `ping`），可带 rate limit |
| 会话持久化 | 内存 map（重启丢） | JSON 磁盘持久化（`data/sessions/*.json`），重启后 cost 延续，session resume 下次 resume |
| Cost/usage | 无 | `/usage` 卡片，按 thread + 全局聚合 + 估算 USD |
| Hook 机制 | 外部 HTTP shell 调用 | SDK 原生 in-process hooks（`canUseTool` + 事件回调） |

## 快速开始

```bash
cd chatcc-v3
npm ci
npm run build

# 配置（二选一）
# 1) 复用 v2 配置：symlink ../chatcc/config.local.yaml
ln -s ../chatcc/config.local.yaml config.local.yaml

# 2) 或直接设环境变量
export FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx

# 启动
npm run dev                       # 开发：tsx watch
# 或
node dist/main.js                 # 生产：built JS
```

## 飞书侧最小权限 scopes

```
im:message                         # 收发消息
im:message:send_as_bot             # 机器人发消息
im:message.p2p_msg:readonly        # 读单聊消息
im:message.group_at_msg:readonly   # 读群 @ 机器人消息
im:message.group_msg:readonly      # 读群消息
```

同时在开放平台「卡片回调请求网址」填写 `http://<host>:<card_webhook_port><card_webhook_path>`（默认 `:9876/webhook/card`），用于按钮回调。

## 命令

| 命令 | 说明 |
|---|---|
| `/ping` | 健康检查 |
| `/status` | 系统状态 |
| `/help` | 帮助 |
| `/ask [@别名] <问题>` | 无状态单次提问（不保留上下文） |
| `/session start [@别名\|path]` | 启动长驻会话 |
| `/session stop [threadKey]` | 停止会话 |
| `/session list` | 列出活跃会话 |
| `/s <消息>` | 向当前活跃会话发送（非命令文本也自动走这里） |
| `/stop [threadKey]` | 精确中断当前活跃会话 |
| `/usage` | Token/Cost 看板 |

## 架构（核心文件）

```
src/
├─ main.ts                    # 入口：装配所有模块
├─ config.ts                  # YAML + zod + env 覆盖
├─ logger.ts                  # pino
├─ feishu/
│  ├─ client.ts               # Lark Client + WSClient + EventDispatcher
│  ├─ router.ts               # 命令分发
│  ├─ replier.ts              # 发消息 / 卡片 PATCH（含指数退避重试）
│  ├─ card-action.ts          # 卡片按钮回调 HTTP server + 审批 resolver
│  └─ cards/                  # 卡片渲染器（live / approval / cost / base）
├─ engine/
│  ├─ session.ts              # 每 thread 一个 query() + 输入 queue
│  ├─ pool.ts                 # SessionPool + 活跃会话指针
│  ├─ streamer.ts             # 事件驱动卡片 PATCH（throttle）
│  ├─ monitor.ts              # result → 完成通知
│  ├─ hooks.ts                # canUseTool + ApprovalGate（审批卡片 ↔ resolver）
│  ├─ cost.ts                 # token/cost 聚合
│  ├─ persistence.ts          # 会话磁盘持久化
│  └─ events.ts               # SDKMessage → EngineEvent 翻译
├─ mcp/
│  └─ feishu-server.ts        # Claude → 飞书反向 MCP（send_message / ping）
└─ commands/                  # /ask /session /s /stop /usage /status /help
```

## 关键配置字段

```yaml
app_id: ""
app_secret: ""
allowed_users: []
allowed_chats: []

default_cwd: "."
projects: {}                         # 别名 → 路径

claude_allowed_tools: ["Read", "Glob", "Grep"]
claude_danger_mode: false            # true 时绕过 canUseTool 审批
auto_approve_tools:                  # canUseTool 层白名单（正则匹配工具名）
  - "^(Read|Glob|Grep|LS|WebFetch|WebSearch|TodoWrite)$"
approval_timeout_ms: 120000          # 审批卡片超时后默认 deny

stream_throttle_ms: 500              # 实况卡片 PATCH 节流
card_webhook_port: 9876              # 卡片按钮回调 HTTP 监听端口
card_webhook_path: "/webhook/card"

persistence_dir: "./data/sessions"
mcp_feishu_rate_limit_ms: 10000      # MCP send_message 每 chat 最小间隔
notify_chat_id: ""                   # 默认通知群
log_level: "info"
```

## 开发

```bash
npm run dev            # tsx watch
npm run typecheck      # 只类型检查
npm run build          # 编译到 dist/
npm test               # vitest（里程碑后添加）
```

## 当前状态

v3 alpha.1 — M1～M6 完整落地，端到端可用骨架。后续：
- 集成测试 (`test/` 目录)
- 会话 resume 真实接管（当前 persistence 已存 sessionId，但 resume 侧未自动 wire）
- monitor 的 idle 检测
- PR 合并 v3 → main 切换线上部署

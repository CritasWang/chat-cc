# ChatCC

**Chat**（聊天）+ **CC**（Claude Code + Command）— 通过飞书消息远程操控 Claude Code 和本地程序。

## 特性

- **WebSocket 长连接**: 无需公网 IP，本地直接运行
- **Claude Agent SDK 原生集成**:
  - `/ask` — 无状态模式，单次 `query()` 调用
  - `/session` + `/s` — 长驻 `ClaudeSDKClient`，完整上下文保持
- **事件驱动实况转播**: SDK 事件流驱动卡片 PATCH（默认 500ms 节流），替代 v2 的 3s 轮询
- **工具审批卡片**: 高危工具调用弹「✅ 允许 / ❌ 拒绝」卡片，in-process `canUseTool` 回调
- **飞书反向 MCP**: Claude 可主动给飞书发消息（`mcp__feishu__send_message`），带 rate limit
- **会话磁盘持久化**: `data/sessions/*.json`，重启后自动 resume、cost 延续
- **Token/Cost 看板**: `/usage` 按会话 + 全局聚合 + 估算 USD
- **精确中断**: `query.interrupt()` 替代 tmux Ctrl-C 模拟
- **空闲自动回收**: 30 分钟无活动自动 disconnect，保留磁盘 meta，下次 resume
- **卡片按钮交互**: 所有状态卡片支持按钮点击直接触发命令
- **安全控制**: 用户/群聊白名单（消息 + 卡片按钮双入口统一校验）

## 快速开始

### 1. 飞书应用配置

1. 登录 [飞书开放平台](https://open.feishu.cn) → 创建企业自建应用
2. 添加「机器人」能力
3. 权限: `im:message`、`im:message:send_as_bot`、`im:message:patch`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message.group_msg:readonly`
4. 事件与回调 → **WebSocket 模式**
   - **事件配置** 添加 `im.message.receive_v1`（消息接收）
   - **回调配置** 添加 `card.action.trigger`（卡片按钮回调，通过 WS 长连接承载，无需公网/HTTP）
5. 发布应用版本

### 2. 配置

```bash
npm ci
npm run build

# 配置（二选一）
# 1) 复用 v2 配置
ln -s ../chatcc/config.local.yaml config.local.yaml

# 2) 或直接设环境变量
export FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx
```

### 3. 启动

```bash
npm run dev                       # 开发：tsx watch
# 或
node dist/main.js                 # 生产：built JS
```

## 命令

| 命令 | 说明 |
|---|---|
| `/ping` | 健康检查 |
| `/status` | 系统状态 |
| `/help` | 帮助 |
| `/ask [@别名] <问题>` | 无状态单次提问（不保留上下文） |
| `/session start [@别名\|path]` | 启动长驻会话 |
| `/session stop [threadKey]` | 停止会话 |
| `/session list` | 列出活跃会话（含历史持久化会话） |
| `/s <消息>` | 向当前活跃会话发送（非命令文本也自动走这里） |
| `/stop [threadKey]` | 精确中断当前活跃会话 |
| `/usage` | Token/Cost 看板 |

## 架构

```
src/
├─ main.ts                    # 入口：装配所有模块
├─ config.ts                  # YAML + zod + env 覆盖
├─ logger.ts                  # pino
├─ feishu/
│  ├─ client.ts               # Lark Client + WSClient + EventDispatcher
│  ├─ router.ts               # 命令分发
│  ├─ replier.ts              # 发消息 / 卡片 PATCH（含指数退避重试）
│  ├─ card-action.ts          # 卡片按钮回调（WS card.action.trigger + 审批 resolver）
│  └─ cards/                  # 卡片渲染器（live / approval / cost / base）
├─ engine/
│  ├─ session.ts              # 每 thread 一个 query() + 输入 queue + resume
│  ├─ pool.ts                 # SessionPool + 活跃会话指针 + 空闲回收 + 磁盘预热
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

persistence_dir: "./data/sessions"
idle_timeout_minutes: 30             # 会话空闲自动 disconnect（保留磁盘 meta，下次自动 resume）
idle_check_seconds: 60
mcp_feishu_rate_limit_ms: 10000      # MCP send_message 每 chat 最小间隔
notify_chat_id: ""                   # 默认通知群
log_level: "info"
```

## 开发

```bash
npm run dev            # tsx watch
npm run typecheck      # 只类型检查
npm run build          # 编译到 dist/
npm test               # vitest
```

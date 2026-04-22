# ChatCC

**Chat**（聊天）+ **CC**（Claude Code + Command）— 通过飞书消息远程操控 Claude Code 和本地程序。

以 npm 全局包形式分发，内置守护进程管理，无需 PM2 或手动 nohup。

## 特性

- **WebSocket 长连接** — 无需公网 IP，本地直接运行
- **Claude Agent SDK 原生集成** — `query()` async generator，结构化事件流，支持 `canUseTool` / `resume` / `interrupt()`
- **事件驱动实况卡片** — SDK 事件流驱动卡片 PATCH（默认 500ms 节流），替代轮询
- **工具审批卡片** — 高危工具弹「✅ 允许 / ❌ 拒绝」卡片，in-process `canUseTool` 回调
- **飞书反向 MCP** — Claude 可主动给飞书发消息（`mcp__feishu__send_message`），带 rate limit
- **会话磁盘持久化** — 重启后自动 resume，cost 延续
- **内置守护进程** — fork + PID 文件 + 信号处理，`chat-cc start/stop/restart/status`
- **空闲自动回收** — 30 分钟无活动自动 disconnect，保留磁盘 meta，下次自动 resume
- **安全控制** — 用户/群聊白名单（消息 + 卡片按钮双入口统一校验）

## 前置条件

- **Node.js >= 20.11**
- **Claude Code CLI** — `claude` 命令可用（`npm install -g @anthropic-ai/claude-code`）
- **ANTHROPIC_API_KEY** 已设置
- 飞书企业自建应用（Bot 能力 + WebSocket 事件）

## 快速开始

### 第一步：安装

```bash
npm install -g chat-cc
```

安装后提供两个等价命令：`chat-cc` 和 `chatcc`。

### 第二步：配置飞书应用

1. 登录 [飞书开放平台](https://open.feishu.cn) → 创建企业自建应用
2. 添加「机器人」能力
3. **权限管理** 开通以下权限：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message:patch`
   - `im:message.p2p_msg:readonly`
   - `im:message.group_at_msg:readonly`
   - `im:message.group_msg:readonly`
4. **事件与回调** → 选择 **WebSocket 模式**
   - 事件配置：添加 `im.message.receive_v1`
   - 回调配置：添加 `card.action.trigger`
5. 发布应用版本

### 第三步：初始化配置

```bash
chat-cc init
```

交互向导会引导填写 `app_id`、`app_secret` 等必要字段，配置写入 `~/.chat-cc/config.yaml`。

### 第四步：启动

```bash
chat-cc start          # 后台守护进程（默认）
chat-cc start --foreground  # 前台运行（调试用）
```

### 第五步：在飞书中发消息

与机器人私聊或在已加入的群 @ 机器人，发送 `/ping` 验证连通性。

---

## CLI 命令

```
chat-cc init                    # 交互式配置向导
chat-cc start [--foreground]    # 启动守护进程（默认后台）
chat-cc stop                    # 停止守护进程
chat-cc restart                 # 重启守护进程
chat-cc status                  # 进程状态 + 连接状态
chat-cc logs [--follow] [-n <行数>]  # 查看/实时追踪日志
chat-cc config <get|set|edit|path>   # 管理配置
chat-cc doctor                  # 环境健康检查
chat-cc version                 # 版本信息
```

### 配置目录

| 路径 | 说明 | 环境变量覆盖 |
|---|---|---|
| `~/.chat-cc/` | 配置根目录 | `CHAT_CC_HOME` |
| `~/.chat-cc/config.yaml` | 主配置文件 | `CHAT_CC_CONFIG` |

---

## 飞书机器人命令

| 命令 | 说明 |
|---|---|
| `/ping` | 健康检查 |
| `/status` | 系统状态 |
| `/help` | 帮助 |
| `/ask [@别名] <问题>` | 无状态单次提问，流式卡片输出 |
| `/session start [@别名\|path]` | 启动长驻会话 |
| `/session list` | 列出活跃及历史会话 |
| `/s <消息>` | 向当前活跃会话发送（非命令文本也自动走这里） |
| `/stop` | 精确中断当前活跃会话 |
| `/usage` | Token/Cost 看板（按会话 + 全局聚合） |
| `/project` | 项目别名管理 |
| `/danger` | 切换 danger 模式（绕过工具审批） |
| `/reload` | 热重载配置 |

---

## 配置说明

配置文件位于 `~/.chat-cc/config.yaml`，关键字段如下：

```yaml
# 飞书应用凭据（也可用环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）
app_id: ""
app_secret: ""

# 安全白名单（留空表示不限制）
allowed_users: []
allowed_chats: []

# 工作目录与项目别名
default_cwd: "."
projects:                        # 别名 → 路径，/ask @myapp 即切换到对应目录
  myapp: /path/to/project

# Claude 工具控制
claude_allowed_tools: ["Read", "Glob", "Grep"]
claude_danger_mode: false        # true 时绕过 canUseTool 审批
auto_approve_tools:              # canUseTool 层白名单（正则匹配工具名）
  - "^(Read|Glob|Grep|LS|WebFetch|WebSearch|TodoWrite)$"
approval_timeout_ms: 120000      # 审批卡片超时后默认 deny

# 实况卡片
stream_throttle_ms: 500          # 卡片 PATCH 节流间隔（毫秒）

# 会话管理
idle_timeout_minutes: 30         # 空闲超时自动 disconnect（保留磁盘 meta）
idle_check_seconds: 60

# 飞书反向 MCP
mcp_feishu_rate_limit_ms: 10000  # 同一 chat 发消息最小间隔
notify_chat_id: ""               # 默认通知群

log_level: "info"
```

---

## 架构

```
src/
├─ main.ts                    # 入口：装配所有模块
├─ paths.ts                   # 配置目录/文件路径解析（CHAT_CC_HOME / CHAT_CC_CONFIG）
├─ config.ts                  # YAML + zod + env 覆盖
├─ logger.ts                  # pino
├─ cli/                       # CLI 子命令实现（init / start / stop / logs / config / doctor …）
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
└─ commands/                  # /ask /session /s /stop /usage /status /help /project /danger /reload
```

---

## 开发

```bash
npm run dev            # tsx watch（前台运行）
npm run build          # 编译到 dist/
npm run typecheck      # 只类型检查
npm test               # vitest
```

### 为什么用 TypeScript 而非 Go

v2 用 Go 通过 tmux 子进程 + `capture-pane` 轮询抓取输出，存在三个系统性瓶颈：Claude Agent SDK 无 Go 版本（`canUseTool`/`resume`/MCP 均为 SDK 独占能力）、ANSI 屏幕抓取脆弱、轮询延迟不可消除。v3 直接使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` async generator，获得结构化 JSON 事件流和全部一等公民能力。

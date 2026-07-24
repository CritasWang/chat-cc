# ChatCC

**Chat**（聊天）+ **CC**（Claude Code + Command）— 通过飞书消息远程操控 Claude Code 和本地程序。

以 npm 全局包形式分发，内置守护进程管理，无需 PM2 或手动 nohup。

## 特性

- **WebSocket 长连接** — 无需公网 IP，本地直接运行；独立 15s 保活旁路（睡眠唤醒检测 / 断网与 WS 卡死区分 / 自动重建连接）
- **双引擎** — Claude（Agent SDK 原生集成：`canUseTool` / `resume` / `interrupt()`）或 Codex（`codex exec` 子进程 + JSONL，threadId 续上下文），`agent: claude|codex` 一键切换
- **事件驱动实况卡片** — SDK 事件流驱动卡片 PATCH（默认 500ms 节流）；工具调用 ≥3 自动折叠防飞书 30KB 超限；超长正文保最新
- **话题群 thread = session** — 话题群里一个话题一个独立会话，回复锚定话题内；`/new chat` 自动建群开好会话
- **消息合批** — 600ms 静默窗口内连续消息合并为一条 prompt；agent 运行期间的消息累积到下一轮
- **合并转发直达** — 飞书聊天记录一键合并转发给 bot，自动解析（含卡片文本提取）喂给会话
- **文档划词评论** — 云文档评论 @bot，自动读取划词与评论线程并回复到原线程（可选，需订阅事件）
- **API profile 切换（会话级 + 全局）** — 读取本机 `~/.claude/cc-profiles.zsh`；`/profile use <name>` 只切当前会话（类比终端各窗口各自 ccuse），`--global` 切全局默认；`/session start`、`/new chat` 支持 `--profile <name>` 开局指定，选择随会话持久化（可选功能，无该文件则自动隐藏）
- **工具审批卡片** — 高危工具弹「✅ 允许 / ❌ 拒绝」卡片，in-process `canUseTool` 回调（Claude 引擎）
- **飞书反向 MCP** — Claude 可主动给飞书发消息（`mcp__feishu__send_message`），带 rate limit
- **会话磁盘持久化** — 原子写（fsync + rename），重启后自动 resume，cost 延续
- **内置守护进程** — fork + PID 文件 + 信号处理，`chat-cc start/stop/restart/status`
- **空闲自动回收** — 30 分钟无活动自动 disconnect，保留磁盘 meta，下次自动 resume
- **安全控制** — 用户/群聊白名单 + `admin_users` 敏感命令收敛 + 卡片回调防重放（双击去重 / 一次性 nonce）

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
   - `im:chat`（可选 — `/new chat` 自动建群需要）
   - `im:chat:readonly`（可选 — 话题群 thread=session 的 chat_mode 判定需要）
   - `drive:drive`（可选 — 文档划词评论回复需要）
4. **事件与回调** → 选择 **WebSocket 模式**（长连接）
   - 事件配置：添加 `im.message.receive_v1`
   - 事件配置：添加 `drive.notice.comment_add_v1`（可选 — 文档划词评论）
   - 回调配置：添加 `card.action.trigger`
5. 发布应用版本

> 不需要任何 `admin:*` 管理员权限。可选权限不开通时对应功能自动不可用，其余功能不受影响。

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
| `/status` | 系统状态（版本 / 会话 / 当前 API profile） |
| `/help [--pin]` | 帮助卡片（含常用操作按钮，`--pin` 置顶到群当命令面板） |
| `/ask [@别名] <问题>` | 无状态单次提问，流式卡片输出 |
| `/session start [@别名\|path] [--codex\|--claude]` | 启动长驻会话（可按会话选引擎；同群同用户可开多个 slot） |
| `/session switch <slot\|序号>` | 切换活跃会话，其他会话后台保持 |
| `/session list` / `current` / `stop` | 会话列表 / 当前会话 / 关闭会话 |
| `/new chat [名字] [@别名] [--topic] [--codex\|--claude] [--profile <name>]` | 自动建新群并开好会话（`@别名` 指定项目；`--topic` 建话题群，一个话题一个独立会话）；自动打会话标签 `AI`+`Claude` / `AI`+`Codex`（`new_chat_tags_*` 可配，需 lark-cli 用户授权） |
| `/s <消息>` | 向当前活跃会话发送（非命令文本也自动走这里；话题群里自动按话题路由） |
| `/stop` | 精确中断当前活跃会话 |
| `/cd <@别名\|路径>` | 当前会话切换工作目录（新目录开新对话，引擎/profile 等设置保留） |
| `/clear`（`/reset`） | 清空当前会话上下文原地重开（cwd 与引擎/profile/权限设置保留；话题群里作用于当前话题） |
| `/profile use <name> [--global]` | 当前会话切 API profile；`--global` 切全局默认（可选，读 `~/.claude/cc-profiles.zsh`） |
| `/profile [list\|clear\|reload]` | 查看两层状态 / 会话回归全局 / 重读数据源 |
| `/usage` | Token/Cost 看板（按会话 + 全局聚合） |
| `/project` | 项目别名管理 |
| `/danger on\|off [--global]` | 当前会话切权限模式；`--global` 切全局默认；`clear` 回归全局 ※ admin_users 可收敛 |
| `/reload` | 热重载配置 ※ admin_users 可收敛 |

其他玩法：
- **话题群**：把群转成话题群后，每个话题就是一个独立会话，互不串上下文
- **合并转发**：选多条消息 → 合并转发给 bot，自动解析为聊天记录交给会话处理
- **文档评论**：在云文档划词评论并 @bot，回答直接回到评论线程

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
# 管理员（可执行 /danger /reload /profile use；留空 = 不额外设限）
admin_users: []

# 会话引擎：claude（默认）或 codex；也可在 /session start、/new chat 时用 --codex/--claude 按会话指定
agent: "claude"
codex_bin: "codex"               # codex 可执行文件
codex_sandbox: "workspace-write" # read-only | workspace-write | danger-full-access
codex_model: ""                  # 留空用 Codex 默认

# 工作目录与项目别名
default_cwd: "."
projects:                        # 别名 → 路径，/ask @myapp 即切换到对应目录
  myapp: /path/to/project

# Claude 工具控制
claude_allowed_tools: ["Read", "Glob", "Grep"]
claude_danger_mode: false        # true 时绕过 canUseTool 审批（codex 引擎下 = danger-full-access 沙箱）
auto_approve_tools:              # canUseTool 层白名单（正则匹配工具名）
  - "^(Read|Glob|Grep|LS|WebFetch|WebSearch|TodoWrite)$"
approval_timeout_ms: 120000      # 审批卡片超时后默认 deny

# 实况卡片
stream_throttle_ms: 500          # 卡片 PATCH 节流间隔（毫秒）
message_debounce_ms: 600         # 消息静默窗口：窗口内连续消息合并为一条 prompt；0 关闭合批窗口

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
├─ main.ts                    # 入口：装配所有模块（含 createSession 引擎工厂）
├─ paths.ts                   # 配置目录/文件路径解析（CHAT_CC_HOME / CHAT_CC_CONFIG）
├─ config.ts                  # YAML + zod + env 覆盖
├─ logger.ts                  # pino
├─ cli/                       # CLI 子命令实现（init / start / stop / logs / config / doctor …）
├─ agent/
│  ├─ types.ts                # AgentSession 统一接口（claude | codex）
│  ├─ codex-session.ts        # Codex：codex exec 子进程，每轮一进程，threadId 续上下文
│  ├─ codex-args.ts           # codex exec 参数构建（沙箱/resume/stdin prompt）
│  └─ codex-jsonl.ts          # Codex JSONL → EngineEvent 状态机翻译
├─ feishu/
│  ├─ client.ts               # Lark Client + WSClient 控制器（可强制重建）+ EventDispatcher
│  ├─ keepalive.ts            # 独立 15s 保活：睡眠检测 / HTTP 探测 / 防抖重连
│  ├─ router.ts               # 命令分发
│  ├─ replier.ts              # 发消息 / 卡片 PATCH / 建群（含指数退避重试）
│  ├─ card-action.ts          # 卡片按钮回调（防重放 + 审批 resolver）
│  ├─ callback-store.ts       # 回调防重放（短窗口去重 + 一次性 nonce 持久化）
│  ├─ thread-id.ts            # 话题群 chat_mode 缓存 + thread_id 补查
│  ├─ forward.ts              # 合并转发消息解析（text/post/卡片文本提取）
│  ├─ comments.ts             # 云文档划词评论 @bot → agent → 回评论线程
│  └─ cards/                  # 卡片渲染器（live 折叠状态机 / approval / cost / base）
├─ engine/
│  ├─ session.ts              # Claude：每 thread 一个 query() + 输入 queue + resume 自愈
│  ├─ pool.ts                 # SessionPool + 话题 threadKey + 空闲回收 + 磁盘预热
│  ├─ pending-queue.ts        # 消息静默窗口合批（run 期间 block/unblock）
│  ├─ streamer.ts             # 事件驱动卡片 PATCH（throttle + replyTarget 话题锚定）
│  ├─ api-profiles.ts         # cc-profiles.zsh 解析 + /profile 状态持久化
│  ├─ hooks.ts                # canUseTool + ApprovalGate（审批卡片 ↔ resolver）
│  ├─ cost.ts                 # token/cost 聚合
│  ├─ persistence.ts          # 会话磁盘持久化（原子写）
│  └─ events.ts               # SDKMessage → EngineEvent 翻译
├─ platform/
│  └─ atomic-write.ts         # 原子写：tmp + fsync + rename + 目录 fsync
├─ policy/
│  └─ owner.ts                # 敏感命令特权判定（仅 admin_users，无管理类 API）
├─ mcp/
│  └─ feishu-server.ts        # Claude → 飞书反向 MCP（send_message / ping）
└─ commands/                  # /ask /session /new /s /stop /usage /status /help /project /danger /reload /profile
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

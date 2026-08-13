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
- **模型选择（会话级 + 全局）** — `/model <名字>` 只切当前会话（优先在线热切换，失败自动重启 + resume），`--global` 切全局默认，`/model clear` 回归，`/model list` 看可选；`/session start`、`/new chat` 支持 `--model <name>` 开局指定；优先级：会话覆盖 > profile 第三段 > `claude_model` > daemon 启动环境 > 内置默认（管理员专属）
- **工具审批卡片** — 高危工具弹「✅ 允许 / ❌ 拒绝」卡片，in-process `canUseTool` 回调（Claude 引擎）
- **飞书反向 MCP** — Claude 可主动给飞书发消息（`mcp__feishu__send_message`），带 rate limit
- **会话磁盘持久化** — 原子写（fsync + rename），重启后自动 resume，cost 延续
- **内置守护进程** — fork + PID 文件 + 信号处理，`chat-cc start/stop/restart/status`
- **空闲自动回收** — 30 分钟无活动自动 disconnect，保留磁盘 meta，下次自动 resume
- **安全控制** — 默认拒绝访问（需显式白名单或 `allow_all_users`）+ `admin_users` 敏感命令收敛 + cwd 根目录约束 + 入站消息持久化去重

## 前置条件

- **Node.js >= 20.11**
- **ANTHROPIC_API_KEY** 已设置（或通过 API profile 提供凭据）
- **Codex CLI**（可选）— 使用 `codex` 引擎时需 `codex` 命令可用
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

### 安装更新与重启

守护进程的启动、停止、重启和状态查询统一通过全局 CLI 完成。对本仓库进行操作的人工或 AI Agent 都不应使用 `node dist/cli/index.js start`、`npm start` 或手工 `kill` 代替：

```bash
# 从源码更新全局安装
npm run build
npm install -g .

# 让正在运行的 daemon 加载新版本
chat-cc restart
chat-cc status
chat-cc logs -n 50
```

完整运维和故障排查流程见 [docs/operations.md](docs/operations.md)。

---

## 飞书机器人命令

| 命令 | 说明 |
|---|---|
| `/ping` | 健康检查 |
| `/status` | 系统状态（版本 / 会话 / 当前 API profile / 当前模型） |
| `/help [--pin]` | 帮助卡片（含常用操作按钮，`--pin` 置顶到群当命令面板） |
| `/ask [@别名] <问题>` | 无状态单次提问，流式卡片输出 |
| `/session start [@别名\|path] [--codex\|--claude] [--profile <name>] [--model <name>]` | 启动长驻会话（可按会话选引擎/模型；同群同用户可开多个 slot） |
| `/session switch <slot\|序号>` | 切换活跃会话，其他会话后台保持 |
| `/session list` / `current` / `stop` | 会话列表 / 当前会话 / 关闭会话 |
| `/new chat [名字] [@别名] [--topic] [--codex\|--claude] [--profile <name>] [--model <name>]` | 管理员创建新群并开好会话（`@别名` 指定项目；`--topic` 建话题群，一个话题一个独立会话） |
| `/s <消息>` | 向当前活跃会话发送（非命令文本也自动走这里；话题群里自动按话题路由） |
| `/stop` | 精确中断当前活跃会话 |
| `/cd <@别名\|路径>` | 当前会话切换工作目录（新目录开新对话，引擎/profile/模型等设置保留） |
| `/clear`（`/reset`） | 清空当前会话上下文原地重开（cwd 与引擎/profile/模型/权限设置保留；话题群里作用于当前话题） |
| `/profile use <name> [--global]` | 当前会话切 API profile；`--global` 切全局默认（可选，读 `~/.claude/cc-profiles.zsh`） |
| `/profile [list\|clear\|reload]` | 管理员查看/切换 API profile、回归全局或重读数据源 |
| `/model <名字> [--global]` | 当前会话切模型；`--global` 切全局默认（写 `claude_model`，跟随全局的会话同步更新）※ 仅 `admin_users` |
| `/model clear [--global]` / `list` | 回归 profile/全局默认 · 查看可选模型与当前生效链路 |
| `/usage` | Token/Cost 看板（按会话 + 全局聚合） |
| `/project` | 项目别名管理 |
| `/danger on\|off [--global]` | 当前会话切权限模式；`--global` 切全局默认；`clear` 回归全局 ※ admin_users 可收敛 |
| `/reload` | 校验配置并完整重启后台 daemon ※ 仅 `admin_users` |

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

# 安全白名单（默认 fail-closed）
allow_all_users: false           # 只有明确需要公开机器人时才设 true
allowed_users: []
allowed_chats: []
# 管理员（可执行 /danger /reload /profile use；留空 = 无人有特权）
admin_users: []

# 会话引擎：claude（默认）或 codex；也可在 /session start、/new chat 时用 --codex/--claude 按会话指定
agent: "claude"
codex_bin: "codex"               # codex 可执行文件
codex_sandbox: "workspace-write" # read-only | workspace-write | danger-full-access
codex_model: ""                  # codex 模型（留空用 Codex 默认）
claude_model: ""                 # Claude 全局默认模型；优先级低于会话 /model 与 profile

# 工作目录与项目别名
default_cwd: "."
projects:                        # 别名 → 路径，/ask @myapp 即切换到对应目录
  myapp: /path/to/project
allowed_cwd_roots: []            # 额外允许的 cwd 根；会做 realpath 校验，阻止 symlink/.. 越界
# Agent 子进程继承 daemon 的完整环境；请不要在 daemon 环境中放入无关凭据

# Claude 工具控制
claude_allowed_tools: ["Read", "Glob", "Grep"]
claude_danger_mode: false        # true 时绕过 canUseTool 审批（codex 引擎下 = danger-full-access 沙箱）
auto_approve_tools:              # canUseTool 层白名单（正则匹配工具名）
  - "^(Read|Glob|Grep|LS|LSP|WebFetch|WebSearch|AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TaskGet|NotebookRead|PushNotification)$"
approval_timeout_ms: 120000      # 审批卡片超时后默认 deny
max_concurrent_asks: 20          # /ask 全局并发上限
max_concurrent_asks_per_user: 2  # 单个 chat+用户的 /ask 并发上限
max_concurrent_comment_queries: 10  # 文档评论查询并发上限
max_active_sessions: 20          # 同时驻留的会话/query 上限，防批量话题耗尽进程资源

# 超时
claude_ask_timeout_min: 50       # /ask 单次查询上限（分钟）
claude_session_timeout_min: 50   # Claude 会话单轮任务上限（分钟）
codex_first_token_timeout_min: 10  # Codex spawn 后首 token 超时（分钟），超时无输出判定卡死

# 实况卡片
stream_throttle_ms: 500          # 卡片 PATCH 节流间隔（毫秒）
message_debounce_ms: 600         # 消息静默窗口：窗口内连续消息合并为一条 prompt；0 关闭合批窗口
max_chunk_size: 3500             # 长消息分块大小（字符）
max_pending_messages_per_session: 100
max_pending_chars_per_session: 100000

# 会话管理
persistence_dir: ""              # 会话持久化目录（默认 ~/.chat-cc/sessions）
idle_timeout_minutes: 30         # 空闲超时自动 disconnect（保留磁盘 meta）
idle_check_seconds: 60

# 飞书反向 MCP 与通知
mcp_feishu_rate_limit_ms: 10000  # 同一 chat 发消息最小间隔
notify_chat_id: ""               # 默认通知群
notify_quiet_minutes: 2          # 完成通知安静阈值（分钟）：距上次发言超过此时长才推送；0 = 总是推送
notify_done_ping: true           # 后台会话完成时在源群补发轻量提示（卡片 PATCH 不产生红点）
status_push_interval_min: 180    # 定期推送状态卡片间隔（分钟）；0 = 关闭
status_push_chat_id: ""          # 状态推送目标群（留空不推送）

# 群标签（feed 标签，借道本机 lark-cli 用户身份；不需要可留空数组）
new_chat_tags_claude: ["AI", "Claude"]   # /new chat 建 Claude 会话群时自动打的标签
new_chat_tags_codex: ["AI", "Codex"]     # /new chat 建 Codex 会话群时自动打的标签
lark_cli_bin: "lark-cli"         # lark-cli 可执行文件（打标签用）
danger_tag: "Danger"             # 会话级 danger 开启时给群打的标签（off/clear 时移除；留空禁用）

# 用户消息资源（图片/文件）落盘保留天数，超期自动清理；0 = 不清理
media_retention_days: 7

log_level: "info"
```

### 升级配置检查

- `admin_users` 默认 fail-closed；空数组意味着无人可执行 `/danger`、`/reload`、`/profile`、`/model` 等特权操作。升级前应配置明确的管理员 `open_id`。
- 配置使用严格 schema，未知键会导致启动失败，以防拼写错误静默生效。已移除的 `claude_bin`、`hook_port`、`agent_env_allowlist` 会作为明确的历史键兼容忽略；升级或回滚前仍应先用 `chat-cc doctor` 检查配置。
- `agent_env_allowlist` 已移除，可直接从旧配置删除；Claude/Codex 子进程现在继承 daemon 的完整环境。

---

## 架构

```
src/
├─ main.ts                    # 入口：装配所有模块（含 createSession 引擎工厂）
├─ paths.ts                   # 配置目录/文件路径解析（CHAT_CC_HOME / CHAT_CC_CONFIG）
├─ config.ts                  # YAML + zod + env 覆盖
├─ logger.ts                  # pino
├─ cli/                       # CLI 子命令实现（init / start / stop / logs / config / doctor / version …）
├─ agent/
│  ├─ types.ts                # AgentSession 统一接口（claude | codex）
│  ├─ env.ts                  # Claude 环境/模型解析（会话覆盖 > profile > claude_model > 启动环境）
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
│  ├─ media.ts                # 用户消息图片/文件落盘与定期清理
│  ├─ feed-tag.ts             # 群标签打标（lark-cli 借道用户身份）
│  └─ cards/                  # 卡片渲染器（live 折叠状态机 / approval / cost / base）
├─ engine/
│  ├─ session.ts              # Claude：每 thread 一个 query() + 输入 queue + resume 自愈
│  ├─ pool.ts                 # SessionPool + 话题 threadKey + 空闲回收 + 磁盘预热
│  ├─ pending-queue.ts        # 消息静默窗口合批（run 期间 block/unblock）
│  ├─ streamer.ts             # 事件驱动卡片 PATCH（throttle + replyTarget 话题锚定）
│  ├─ api-profiles.ts         # cc-profiles.zsh 解析 + /profile 状态持久化
│  ├─ runtime-overrides.ts    # 会话级运行时覆盖（模型等）持久化
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
└─ commands/                  # /ask /session /new /s /stop /usage /status /help /project
                              # /danger /reload /profile /model /cd /clear
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

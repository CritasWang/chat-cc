# ChatCC

**Chat**（聊天）+ **CC**（Claude Code + Command）— 通过飞书消息远程操控 Claude Code 和本地程序。

## 特性

- **WebSocket 长连接**: 无需公网 IP，本地直接运行
- **双模式 Claude Code 集成**:
  - `/ask` — 无状态模式，`claude -p` 一次性调用
  - `/session` + `/s` — tmux 持久会话，保持上下文
- **卡片按钮交互**: `/help` `/status` `/project` `/session list` `/danger` 全部支持点击按钮直接触发命令；实况终端卡片内嵌 13 键键盘（↑↓←→ ␣↵⎋ ⇥ y n 1 2 3），等待输入时自动渲染「✅ 允许 / ❌ 拒绝」等场景化按钮
- **实况转播 + 宏指令兜底**: 每 3 秒刷新终端卡片；文字命令 `/y /n /do 2d sp ok` 全部保留作键盘用户备选
- **通用命令框架**: 可扩展的命令路由，新增命令只需实现接口
- **Claude Code Hooks 回调**: 内置 HTTP 端点，支持双向通信
- **安全控制**: 用户/群聊白名单、Shell 命令白名单
- **定时状态推送**: 自动推送系统状态卡片到飞书群聊（默认每 3 小时）

## 快速开始

### 1. 飞书应用配置

1. 登录 [飞书开放平台](https://open.feishu.cn) → 创建企业自建应用
2. 添加「机器人」能力
3. 权限: `im:message`、`im:message:send_as_bot`、`im:message:patch`
4. 事件订阅 → **WebSocket 模式** → 订阅:
   - `im.message.receive_v1`（消息接收）
   - `card.action.trigger`（卡片按钮点击回调，开启后可用按钮交互代替文字命令）
5. 发布应用版本

### 2. 配置

```bash
cp config.yaml config.local.yaml
# 编辑 config.local.yaml，填入 app_id 和 app_secret
```

或使用环境变量:

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### 3. 运行

```bash
# 编译
go build -o chatcc .

# 后台启动（日志写入 logs/ 目录，按天自动切换）
./chatcc start --config config.local.yaml

# 查看状态
./chatcc status

# 停止
./chatcc stop

# 重启
./chatcc restart --config config.local.yaml

# 前台运行（日志输出到终端，调试用）
./chatcc console --config config.local.yaml
```

### 日志

- `start` 模式日志写入 `logs/chatcc.log`
- 跨天自动归档为 `logs/chatcc-YYYY-MM-DD.log.gz`（gzip 压缩）
- `console` 模式日志直接输出到终端

## 命令列表

| 命令 | 说明 | 示例 |
|------|------|------|
| `/ask <提示词>` | Claude Code 无状态问答 | `/ask 帮我看看有什么文件` |
| `/ask --cwd <目录> <提示词>` | 指定工作目录 | `/ask --cwd /path/to/project 分析结构` |
| `/ask @别名 <提示词>` | 用项目别名 | `/ask @server 看看迁移方案` |
| `/session start [目录]` | 启动 tmux 持久会话 | `/session start /path/to/project` |
| `/session status` | 查看当前会话详情 | `/session status` |
| `/session list` | 列出所有活跃会话 | `/session list` |
| `/session kill <会话名>` | 终止指定会话 | `/session kill cc-chat-xxx` |
| `/session stop` | 关闭当前会话 | `/session stop` |
| `/s <消息>` | 发送到活跃会话 | `/s 帮我重构这个函数` |
| `/key <按键>` | 向活跃会话发送特殊按键 | `/key enter`, `/key ctrl+c` |
| `/shell <命令>` | 执行白名单 shell 命令 | `/shell docker ps` |
| `/project` 或 `/p` | 查看已配置的项目别名 | `/project` |
| `/status` | 查看系统状态和活跃会话 | `/status` |
| `/danger on\|off` | 切换 Claude Code 权限绕过模式 | `/danger on` |
| `/reload` | 热重载配置文件 | `/reload` |
| `/help [命令]` | 帮助信息 | `/help ask` |

**非命令消息**: 如有活跃 tmux 会话则发送到会话，否则等同 `/ask`。

## 卡片按钮交互

前提：飞书应用已订阅 `card.action.trigger` 事件（见「飞书应用配置」步骤 4）。

### 各命令对应的按钮

| 卡片 | 按钮 | 效果 |
|---|---|---|
| `/help` | 13 键键盘（y/n/↵/⎋/⇥/1-3/↑/↓）· 📊 状态 · 📂 项目 · 📋 会话 · ⚡ Danger · ♻️ 重载 | 按键直接发送到活跃会话；功能按钮推送对应卡片 |
| `/status` | 🔄 刷新 · ⚡ 切 Danger · ♻️ 重载 · 📂 项目 · 📋 会话 · ❓ 帮助 | 「刷新」和「切 Danger」原地更新卡片 |
| `/project` | 每个项目一个 `💬 @alias` 启动按钮（4 列网格） | 一键启动命名会话，别名自动带入 tmux label |
| `/session list` | 每会话 🔀 切换 · ⛔ 关闭 · 📺 查看终端 | 切换/关闭后自动刷新列表卡片 |
| `/danger` | 根据当前状态显示 ⚡ 开启 / 🔒 关闭 | 原地翻转状态并刷新卡片 |
| `/reload` | 🔄 再次重载 · 📊 状态 · 📂 项目 | 重载失败时给出重试按钮 |
| 📺 实况终端 | ↑↓←→ ␣↵⎋ ⇥ y n 1 2 3 + 💬 发消息 + ⛔ 关闭会话 | 按钮直接发送 tmux 按键 |
| ⌨️ 等待输入 | 按提示类型动态渲染：yn 类 = ✅ 允许 / ❌ 拒绝；菜单类 = 1/2/3；enter 类 = ↵ 继续 | 场景化按钮一键回应 |
| ✅ 会话已完成 | 💬 继续对话 · 📋 会话列表 · 📺 查看实况 | 无需打字切场景 |

### 反馈模式

- **键位类按钮**（↑/↓/y/n/...）：仅 Toast 提示「已发送 ↓」，不重复落消息
- **状态类按钮**（Danger 切换、刷新、切换/关闭会话）：Toast + 原地更新原卡片
- **导航类按钮**（查看状态、打开项目列表）：推送新卡片到聊天

### 文字命令兜底

所有按钮能做的事，文字命令全部保留：`/y` `/n` `/1` `/enter` `/esc` `/tab`、`/key up 3`、`/do 2d sp ok` 等，键盘党和手机党都可用。

## 配置说明

### 超时配置

默认情况下，Claude Code 执行超时为 50 分钟（相比之前的 5 分钟大幅提升）。你可以在 `config.yaml` 中自定义超时时间：

```yaml
# Claude Code 超时配置（分钟）
claude_ask_timeout: 50        # /ask 命令超时时间
claude_session_timeout: 50    # /session 会话响应超时
```

### 消息分块与长输出处理

系统会自动将超过 3500 字符的长消息分块发送，避免消息截断导致信息丢失。分块时会智能选择段落、句子边界，确保内容完整性。每条分块消息会标注序号（如 [1/3], [2/3], [3/3]）。

你可以自定义分块大小：

```yaml
# 消息分块配置
max_chunk_size: 3500    # 长消息分块大小（默认 3500 字符）
```

### 定时状态推送

系统可以定时将服务状态以卡片形式推送到飞书群聊，方便团队实时了解系统运行情况。默认每 3 小时推送一次，推送内容与 `/status` 命令一致（系统信息、活跃会话、tmux 状态等）。

```yaml
# 定时状态推送
status_push_interval: 180        # 推送间隔（分钟），0 则禁用，默认 180（3 小时）
status_push_chat_id: ""          # 推送目标群聊，为空则用 notify_chat_id
```

支持热重载：修改配置后执行 `/reload` 即可生效，无需重启。

### 交互式输入处理

当 Claude Code 在 `/session` 会话中遇到交互式提示（如确认操作、yes/no 问题等）时，系统会自动检测并提示你：

```
⚠️ 检测到交互式提示，Claude Code 正在等待输入。
💡 请使用 /s 命令发送您的响应。
```

你可以通过 `/s yes` 或 `/s n` 等命令回应交互提示。系统会检测以下常见交互模式：
- `(y/n)`, `[yes/no]` - 确认问题
- `continue?`, `proceed?` - 继续提示
- `press enter`, `按回车` - 等待确认
- 以及其他常见的交互式提示

### 嵌套会话问题

本项目已修复嵌套 Claude Code 会话问题。系统会自动过滤可能导致嵌套会话检测的环境变量（如 `CLAUDECODE`、`CLAUDE_CODE_` 等），确保在 Claude Code 环境中也能正常启动子进程。

### 会话健康检查与错误诊断

`/session` 模式内置了完善的健康检查机制：

- **启动前验证**: 自动检查工作目录是否存在，无效路径会立即报错而非静默失败
- **启动后验证**: 创建 tmux 会话后自动验证 claude 进程是否成功启动；如果进程退出，会捕获错误输出用于诊断
- **发送前检查**: 每次发送消息前检查 tmux 会话和 claude 进程是否仍然存活，死亡会话自动清理
- **列表同步**: `/session list` 和 `/session status` 会与真实 tmux 状态同步，自动清理已死亡的会话
- **remain-on-exit**: tmux 会话设置了 `remain-on-exit`，即使 claude 退出也能捕获最后的输出用于问题诊断

常见问题排查：
```
# 如果 /session start 报错"工作目录不存在"
# → 检查路径是否拼写正确
/session start /Volumes/data/sources   ✅
/session start /Volumns/data/sources   ❌ (typo)

# 如果报错"claude 进程已退出"
# → 检查 claude 命令是否可正常运行
claude --version

# 清理残留会话
/session stop
```

### 状态查询和项目管理

**会话管理** (`/session`):
- `/session start [目录]` - 启动新的 Claude Code 持久会话
- `/session status` - 查看当前会话的详细信息（会话名、工作目录、创建时间、运行时间、状态）
- `/session list` - 列出所有活跃的会话及其工作目录和运行时间
- `/session kill <会话名>` - 终止指定名称的会话（通过 `/session list` 查看会话名）
- `/session stop` - 关闭当前会话

**查看系统状态** (`/status`):
- 显示系统信息（OS、架构、运行时间）
- 显示默认工作目录
- 显示活跃的 Claude Code 会话及其工作目录和运行时间
- **显示所有运行中的 Claude 进程**（包括 `/ask` 产生的 `claude -p` 进程、交互式会话、VSCode 集成），含 PID、运行模式和运行时长
- 显示 tmux 会话列表
- 显示 Claude Code 版本信息
- 显示权限模式状态

**查看项目列表** (`/project` 或 `/p`):
- 显示所有配置的项目别名及其对应目录
- 提供项目别名的使用示例

在 `config.yaml` 中配置项目：
```yaml
projects:
  server: "/Volumes/data/sources/server_migration"
  devops: "/Volumes/data/sources/devops"
  webapp: "/path/to/webapp"
```

使用项目别名：
```
/ask @server 分析最新的代码变更
/session start @webapp
```

## Claude Code Hooks 集成

### 从 Claude Code 通知飞书

在 `~/.claude/settings.json` 中配置 hooks:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sS http://localhost:9876/notify -H 'Content-Type: application/json' -d '{\"event\":\"file_changed\",\"message\":\"Claude 修改了文件\",\"chat_id\":\"oc_xxx\"}'"
          }
        ]
      }
    ]
  }
}
```

### Hook HTTP API

```
POST http://localhost:9876/notify
Content-Type: application/json

{
  "event": "task_complete",
  "message": "任务已完成: 重构了认证模块",
  "chat_id": "oc_xxx"       // 可选，指定推送到哪个飞书聊天
}
```

```
GET http://localhost:9876/health
→ 200 ok
```

## 项目别名

在 `config.yaml` 中配置项目目录别名:

```yaml
projects:
  server: "/Volumes/data/sources/server_migration"
  devops: "/Volumes/data/sources/devops"
  webapp: "/Volumes/data/sources/webapp"
```

使用: `/ask @server 看看迁移方案的进度`

## 扩展命令

实现 `commands.Command` 接口并注册到 router:

```go
type Command interface {
    Name() string
    Aliases() []string
    Description() string
    Usage() string
    Execute(ctx context.Context, args string, meta *MessageMeta) (string, error)
}
```

在 `main.go` 中注册:

```go
router.Register(NewMyCommand())
```

## ChatCC vs OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) 是跨平台（20+）的通用 AI 助手，ChatCC 则专注飞书 + Claude Code 远程控制。两者定位不同，可以互补使用。

| 维度 | OpenClaw | ChatCC |
|------|----------|------------|
| **定位** | 通用个人 AI 助手，支持多平台 | 专注飞书的 Claude Code 远程控制网关 |
| **核心功能** | 多模型 AI 对话（ChatGPT/Claude/Gemini） | Claude Code 专用执行环境（本地开发工具） |
| **消息平台** | 20+ 平台（WhatsApp/Telegram/Slack 等） | 仅飞书（深度集成） |
| **技术栈** | Node.js | Go（单二进制部署） |
| **本地执行** | 主要调用 AI API | 直接在本地执行 Claude Code（tmux 持久会话） |
| **配置复杂度** | 多平台 + 多模型认证 | 仅需飞书 app_id/app_secret |

**选 ChatCC**：需要通过飞书远程控制本地 Claude Code、企业内网环境、轻量部署。

**选 OpenClaw**：需要跨平台统一 AI 助手、多模型切换、语音/多模态交互。

> 详细对比请参考 [docs/comparison-openclaw.md](docs/comparison-openclaw.md)。

## 安全注意

- `/shell` 仅执行白名单内的命令
- 建议配置 `allowed_users` 限制响应范围
- `claude_danger_mode: true` 会跳过所有 Claude Code 权限检查，仅在可控环境使用
- 不要将 `config.yaml` 中的 `app_secret` 提交到版本控制

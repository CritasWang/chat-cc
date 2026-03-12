# ChatCC

**Chat**（聊天）+ **CC**（Claude Code + Command）— 通过飞书消息远程操控 Claude Code 和本地程序。

## 特性

- **WebSocket 长连接**: 无需公网 IP，本地直接运行
- **双模式 Claude Code 集成**:
  - `/ask` — 无状态模式，`claude -p` 一次性调用
  - `/session` + `/s` — tmux 持久会话，保持上下文
- **通用命令框架**: 可扩展的命令路由，新增命令只需实现接口
- **Claude Code Hooks 回调**: 内置 HTTP 端点，支持双向通信
- **安全控制**: 用户/群聊白名单、Shell 命令白名单

## 快速开始

### 1. 飞书应用配置

1. 登录 [飞书开放平台](https://open.feishu.cn) → 创建企业自建应用
2. 添加「机器人」能力
3. 权限: `im:message`、`im:message:send_as_bot`、`im:message:patch`
4. 事件订阅 → **WebSocket 模式** → 订阅 `im.message.receive_v1`
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
| `/shell <命令>` | 执行白名单 shell 命令 | `/shell docker ps` |
| `/project` 或 `/p` | 查看已配置的项目别名 | `/project` |
| `/status` | 查看系统状态和活跃会话 | `/status` |
| `/danger on\|off` | 切换 Claude Code 权限绕过模式 | `/danger on` |
| `/reload` | 热重载配置文件 | `/reload` |
| `/help [命令]` | 帮助信息 | `/help ask` |

**非命令消息**: 如有活跃 tmux 会话则发送到会话，否则等同 `/ask`。

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

本项目已修复嵌套 Claude Code 会话问题。系统会自动过滤可能导致嵌套会话检测的环境变量（如 `CLAUDECODE`、`ANTHROPIC_*` 等），确保在 Claude Code 环境中也能正常启动子进程。

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
- 显示 tmux 会话列表
- 显示 Claude Code 版本信息

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

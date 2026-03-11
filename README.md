# feishu-bot

飞书机器人本地服务 — 通过飞书消息远程操控 Claude Code 和本地程序。

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
go build -o feishu-bot .

# 后台启动（日志写入 logs/ 目录，按天自动切换）
./feishu-bot start --config config.local.yaml

# 查看状态
./feishu-bot status

# 停止
./feishu-bot stop

# 重启
./feishu-bot restart --config config.local.yaml

# 前台运行（日志输出到终端，调试用）
./feishu-bot console --config config.local.yaml
```

### 日志

- `start` 模式日志写入 `logs/feishu-bot.log`
- 跨天自动归档为 `logs/feishu-bot-YYYY-MM-DD.log.gz`（gzip 压缩）
- `console` 模式日志直接输出到终端

## 命令列表

| 命令 | 说明 | 示例 |
|------|------|------|
| `/ask <提示词>` | Claude Code 无状态问答 | `/ask 帮我看看有什么文件` |
| `/ask --cwd <目录> <提示词>` | 指定工作目录 | `/ask --cwd /path/to/project 分析结构` |
| `/ask @别名 <提示词>` | 用项目别名 | `/ask @server 看看迁移方案` |
| `/session start [目录]` | 启动 tmux 持久会话 | `/session start /path/to/project` |
| `/s <消息>` | 发送到活跃会话 | `/s 帮我重构这个函数` |
| `/session stop` | 关闭持久会话 | `/session stop` |
| `/shell <命令>` | 执行白名单 shell 命令 | `/shell docker ps` |
| `/danger on\|off` | 切换 Claude Code 权限绕过模式 | `/danger on` |
| `/status` | 查看系统状态 | `/status` |
| `/help [命令]` | 帮助信息 | `/help ask` |

**非命令消息**: 如有活跃 tmux 会话则发送到会话，否则等同 `/ask`。

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

## 安全注意

- `/shell` 仅执行白名单内的命令
- 建议配置 `allowed_users` 限制响应范围
- `claude_danger_mode: true` 会跳过所有 Claude Code 权限检查，仅在可控环境使用
- 不要将 `config.yaml` 中的 `app_secret` 提交到版本控制

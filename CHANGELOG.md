# Changelog

## v3.0.0-alpha.1 (2026-04-17)

全量重写：Go + tmux → TypeScript + Claude Agent SDK。

### Breaking Changes

- **语言切换**: 从 Go 切换到 TypeScript / Node.js (>=20.11)
- **运行时依赖变更**: 不再需要 tmux；需要 `npm ci` 安装 Node 依赖
- **配置字段变更**:
  - 删除: `hook_port`、`session_monitor_*`、`live_stream_enabled`、`stream_interval`、`stream_min_delta`、`stream_enabled`
  - 新增: `stream_throttle_ms`、`persistence_dir`、`idle_timeout_minutes`、`idle_check_seconds`、`auto_approve_tools`、`approval_timeout_ms`、`mcp_feishu_rate_limit_ms`
  - 保留兼容: `app_id`、`app_secret`、`allowed_users`、`allowed_chats`、`default_cwd`、`projects`、`claude_allowed_tools`、`claude_danger_mode`、`shell_whitelist`、`notify_chat_id`、`max_chunk_size`、`log_level`
- **命令变更**:
  - 新增: `/stop`（精确中断）、`/usage`（token/cost 看板）
  - 删除: `/key`（tmux 按键模拟，不再需要）、`/do`（宏指令）、`/danger`（改为 config 静态配置）、`/reload`（热重载）、`/project`（保留 @别名 语法）

### Added

- **Claude Agent SDK 原生集成** — 每飞书 thread 一个 `ClaudeSDKClient` 长驻 async generator，JSON 事件流取代 tmux 屏幕抓取
- **事件驱动实况转播** — SDK `assistant` / `tool_use` / `result` 事件驱动卡片 PATCH，默认 500ms 节流（v2 是 3s 轮询）
- **工具审批卡片** — 高危工具执行前弹「✅ 允许 / ❌ 拒绝」飞书卡片，in-process `canUseTool` 回调；支持 `AbortSignal` 提前终止
- **飞书反向 MCP server** — Claude 可在对话中主动调用 `mcp__feishu__send_message` 给飞书群发消息，带 per-chat rate limit
- **会话磁盘持久化** — `data/sessions/*.json` 存储 sessionId / cwd / cost；进程重启后自动预热，下次用户发消息时 `--resume` 接管
- **空闲自动回收** — 会话空闲超 `idle_timeout_minutes`（默认 30 分）自动 disconnect，保留磁盘 meta，下次 resume
- **Token/Cost 看板** — `/usage` 命令，按 thread + 全局聚合 input/output/cache tokens + 估算 USD
- **精确中断** — `/stop` 调用 `query.interrupt()`，SDK 保证下一个工具边界终止；同步 PATCH 当前直播卡片为「🛑 已中断」
- **SDK 错误态区分** — `result.is_error` 映射为红色 error 卡片，不再和成功混淆
- **卡片按钮权限校验** — `card.action.trigger` 入口和消息入口一致做 `allowed_users` / `allowed_chats` 校验
- **bypassPermissions 完整支持** — danger mode 同时设置 `allowDangerouslySkipPermissions`，避免不可见的权限挂起

### Removed

- **tmux 依赖** — 不再需要 tmux、`capture-pane`、`send-keys`
- **ANSI 清洗** — `stripANSI` 正则全删（JSON 事件流不含转义码）
- **HTTP Hook Server** — `hookserver.go` 删除，功能由 SDK in-process hooks 接管
- **轮询检测** — 0.5s 稳定检测、3s 实况轮询、5s 监控扫描全部删除，改为事件驱动
- **Go 运行时** — 所有 `.go` 文件、`Makefile`、`go.mod`/`go.sum` 从 v3 分支删除

### Fixed

- 卡片回调走纯 WebSocket（Node SDK `EventDispatcher` 注册 `card.action.trigger`，handler 返回值通过 WS 帧回写 Toast/Card）
- `/session start @alias` 已有会话时显示实际 cwd 而非新解析的 cwd
- active-session 索引使用 `senderId || chatId`，避免 senderId 为空时查询 miss

---

## v2.x (Go)

v2 的变更历史保留在 `main` 分支的 git log 中。主要里程碑：

- `ec9cdde` docs: 修正卡片回调订阅路径为「回调配置」
- `4bab084` feat: 卡片按钮回调交互，全面替换文字命令
- `3e4e077` feat: V2 实况转播 + 宏指令 + 静默环境变量 + Help 卡片化
- `f7a406d` feat: 会话监控器 + 快捷命令，支持任务完成通知和等待输入提示
- `25da2bb` feat: 多会话切换 + 流式输出同步
- `998b8b5` 项目从 feishu-bot 更名为 ChatCC
- `e6fc7f5` feat: 初版飞书机器人，WebSocket 长连接 + Claude Code 远程控制

# Changelog

## v3.0.1 (2026-04-22)

代码质量提升 + 功能增强 — 14 项修复与改进。

### Fixed

- **`/reload` 环境变量名拼写** — `CHATCC_CONFIG` 修正为 `CHAT_CC_CONFIG`，并统一使用 `resolveConfigPath()`
- **审批 Gate setTimeout 内存泄漏** — 用户点击后 `clearTimeout`，避免闭包堆积
- **`Session.close()` 无超时兜底** — 加 5s `Promise.race` 防止 SDK pump 卡死导致进程退出挂起
- **`/usage` 命令用 `sendCard`** — 修正为 `replyCard`，与其他命令体验一致

### Changed

- **LiveCard 展示项目名称** — 卡片标题追加 cwd 目录名（如 `💬 Claude 思考中… · chatcc-v3`）
- **`/ask` 补齐工具审批** — 非 danger 模式下 `/ask` 也走 `canUseTool` 审批拦截
- **`restartAll()` 真正重启** — `/danger on|off` 后所有会话立即 stop → start，新配置即时生效
- **`getOrResumeActive()` 懒恢复** — 服务重启后用户直接发消息即可恢复会话，无需手动 `/session start`
- **`loadConfig` 返回结构化元数据** — `{ config, meta }` 替代隐藏的 `_cfgPath` 字段，类型安全
- **`config set` 支持数组与浮点** — JSON 数组解析 + 浮点数 + 未知 key 警告
- **持久化文件名防碰撞** — hex 编码替代正则替换 + `loadAll` 增加 schema 校验
- **非文本消息记录日志** — 用户发图片/文件时不再静默忽略

### Removed

- **Monitor 纯文本通知** — result 摘要已在 LiveCard 终态展示，移除冗余的 `sendText` 推送
- **`buildHookMatchers` 死代码** — 未使用的占位函数
- **`LiveCardState.interrupted` 残留字段** — 中断状态已通过 `phase: 'interrupted'` 表达

### Code Quality

- `previewJson` 提取到 `src/utils.ts`，消除 3 处重复
- `isAllowed` 提取到 `src/auth.ts`，消除 2 处重复
- `getConfigMeta` 移除，config 元信息随 `loadConfig` 直接返回

## v3.0.0 (2026-04-22)

从 alpha 到正式版：CLI 产品化，一行安装即可使用。

### Added

- **CLI 全局命令** — `npm install -g chat-cc` 后提供 `chat-cc` / `chatcc` 命令
- **`chat-cc init`** — 交互式配置向导，生成 `~/.chat-cc/config.yaml`
- **`chat-cc start/stop/restart`** — 内置守护进程（fork + PID 文件 + signal），无需 PM2
- **`chat-cc status`** — 进程状态 + 运行时间
- **`chat-cc logs [-f] [-n]`** — 日志查看/跟踪
- **`chat-cc config <get|set|edit|path>`** — 配置管理
- **`chat-cc doctor`** — 环境健康检查（Node 版本、claude CLI、飞书凭证）
- **`chat-cc version`** — 版本信息
- **`~/.chat-cc/` 用户目录** — 配置、PID、日志、会话数据统一存放，项目目录零污染
- **配置路径优先级** — `$CHAT_CC_CONFIG` > `$CHAT_CC_HOME/config.yaml` > `~/.chat-cc/config.yaml` > `./config.local.yaml`（兼容）
- **旧路径兼容** — 检测到 `./config.local.yaml` 时自动 fallback 并 warn 迁移
- **日志双模式** — 后台写文件（`~/.chat-cc/chat-cc.log`），前台 pino-pretty 到 stdout
- **`/ask` 流式卡片** — 流式输出 + 多会话并存支持
- **`/session switch/current`** — 会话切换命令
- **`/project` 项目别名管理卡片** — 内联按钮启动会话/提问（按钮数限制 8 个）
- **`/danger` `/reload` 命令** — 重新引入危险模式切换和热重载
- **`AskUserQuestion` 选项卡片** — 将 Claude 的交互问题渲染为飞书选项卡片
- **卡片全面化** — schema 2.0 按钮体系
- **Lark HTTP Keep-Alive** — 连接复用，降低请求延迟
- **API 指数退避重试** — 处理 ECONNRESET/EOF 错误
- **PM2 进程管理支持** — `ecosystem.config.cjs` 可选支持（现已被内置守护进程替代）

### Changed

- `package.json` name 改为 `chat-cc`，不再 private
- `bin` 入口改为 `dist/cli/index.js`
- `npm run start` 改为前台模式启动（`chat-cc start --foreground`）
- `persistence_dir` 默认值从 `./data/sessions` 改为 `~/.chat-cc/sessions`
- `loadConfig()` 支持无参调用（自动解析路径优先级）

---

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

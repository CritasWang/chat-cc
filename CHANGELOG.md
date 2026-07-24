# Changelog

## v4.0.0 (Unreleased)

会话模型升级 + 产品能力对齐 + 多引擎/多账号。借鉴 [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 的工程实践。

### Added

- **话题群 thread = session**（`feishu/thread-id.ts` + `engine/pool.ts`）— 话题群里一个话题对应一个独立会话（群内共享，threadKey 形如 `oc_x::t-omt_y`），回复锚定到话题内（`reply_in_thread`）。事件缺 thread_id（启动话题的第一条消息）时经 chat_mode 缓存判定话题群后用 `im.v1.message.get` 原始消息补查——规范化消息会丢 thread_id（lark-bridge 踩坑经验）。新话题会话的 cwd 继承发送者活跃会话
- **`/new chat [名字] [@别名] [--codex|--claude] [--profile <name>]` 自动建群**（`commands/newchat.ts`）— 自动创建新群拉发送者进群并开好会话，无需手动拉群（一个群 = 一个 project）；cwd 优先级：`@别名` 显式指定 > 继承当前活跃会话 > default_cwd，欢迎卡注明来源；`--topic` 直接建话题群（每个话题的会话从预建锚点会话继承 cwd/引擎/profile/danger）；建群后自动打会话标签（claude → `AI` + `Claude` 两个独立标签，codex → `AI` + `Codex`；`new_chat_tags_*` 数组可配/可禁用；借道本机 lark-cli 用户身份 best-effort，见 `feishu/feed-tag.ts`）
- **消息静默窗口合批**（`engine/pending-queue.ts`）— 会话消息统一经 PendingQueue 投递：600ms（`message_debounce_ms` 可配）静默窗口内连续消息合并为一条 prompt；agent 运行期间到达的消息累积，run 结束后合并带入下一轮（同会话同时最多一个 run）。带 1h 强制解锁兜底防 run 挂死
- **合并转发消息解析**（`feishu/forward.ts`）— 把飞书消息一键合并转发给 bot，自动经 `im.v1.message.get` 取回原始子消息列表，text/post/interactive 卡片/媒体占位符逐条渲染成聊天记录文本喂给会话（话题群内转发同样锚定话题会话）
- **文档划词评论集成**（`feishu/comments.ts`）— 订阅 `drive.notice.comment_add_v1`：在云文档评论 @bot 后自动拉取划词内容 + 评论线程，跑一次性 agent，把回答回复到同一评论线程（≤2000 字）；whole-doc 评论不接受 reply（错误码 1069302）时降级为新建全局评论。同一评论线程并发去重；发起者走 allowed_users 鉴权。需应用订阅该事件并授予 drive 评论权限
- **API profile 切换 — 会话级 + 全局两层（可选功能）**（`engine/api-profiles.ts` + `commands/profile.ts`）— 解析本机 `~/.claude/cc-profiles.zsh`（`CC_PROFILES` / `CC_DEFAULT_PROFILE`）作为单一数据源。类比终端多窗口：`/profile use <name>` 只切**当前会话**（仅重建该会话，其他会话不受影响），`--global` 切全局默认（重建所有跟随全局的会话，带会话级覆盖的不动）；`/profile clear` 会话回归全局；`/session start`、`/new chat` 支持 `--profile <name>` 开局指定。会话级选择随会话持久化（重启/懒恢复后保持）；经 SDK `env` 注入 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`，上下文经 resume 保留；use/clear 收敛到 admin_users。**零配置兼容**：无 cc-profiles.zsh 的用户功能自动隐藏
- **Codex 完整接入 + 会话级引擎选择**（`agent/`）— `AgentSession` 统一接口，SessionPool 改为 `createSession` 工厂：全局 config `agent: claude|codex` 选择默认引擎，`/session start` 和 `/new chat` 支持 `--codex`/`--claude` 按会话覆盖（选择随会话持久化，重启/懒恢复后保持）。Codex 走 `codex exec --json` 子进程 + stdin prompt + JSONL 状态机翻译（`codex-jsonl.ts`），threadId 复用现有 sessionId 持久化/恢复链路实现跨轮上下文；沙箱模式 `codex_sandbox` 可配，danger 模式自动升级 `danger-full-access`；每轮超时 SIGTERM
- **`admin_users` 敏感命令收敛** — `/danger`、`/reload`、`/profile use` 可收敛到 config `admin_users` 列表（`policy/owner.ts`）；留空不额外设限（向后兼容）。**不需要任何飞书管理类权限**
- **提问卡片有状态交互 + 显式提交**（`feishu/cards/ask-user.ts` + `feishu/ask-store.ts`）— AskUserQuestion 卡片从静态按钮改为状态机：点选原地 PATCH 反馈（✅ 高亮 + toast 剩余题数），单选点选可换选、多选点选可切换，提交按钮实时显示进度（已答 N/M）；所有场景统一由「📨 提交回答」按钮显式触发发送（部分作答只发送已答题），提交后卡片变绿头终态（展示所选 + 「已提交给 Claude」），彻底解决「点完不知道是否提交了」。答案走 pending 队列与普通消息一致；服务重启后旧提问卡按钮提示已失效并引导直接发消息
- **会话级权限模式**（`/danger`）— 与 /profile 同构的两层语义：`/danger on|off|toggle` 只切当前会话（仅重建该会话，Claude=bypassPermissions，Codex=danger-full-access 沙箱），`--global` 切全局默认（带会话覆盖的不动），`/danger clear` 回归全局；选择随会话持久化
- **/status 会话区可读化 + 可操作** — 每个会话显示**群名**（经 `feishu/chat-names.ts` 缓存解析，10min TTL）+ slot + 项目名 + 引擎 + danger 标记，替代裸 threadKey；每行附「⏹ 关闭该会话」按钮（可跨群关闭，点击后原地刷新状态卡）
- **`/help` 兼作命令面板** — 手册卡片并入清空上下文/中断/权限/Profile 等常用操作按钮，`/help --pin` 发送并置顶到群顶（飞书群菜单仅支持跳转链接、无法触发 bot 命令，置顶卡片为等效替代）
- **/cd 自动更新群名** — chat-cc 自建的群（描述以「chat-cc 会话群」开头）切换目录后群名自动改为「项目名 · 引擎」，描述同步新 cwd
- **danger 群标签联动** — 会话级 `/danger on` 给群打 `Danger` 标签、`off`/`clear` 时移除（`danger_tag` 可配/可禁用，best-effort）
- **`/clear`（别名 `/reset`）清空会话上下文** — 丢弃 sessionId 原地重开当前会话（话题群作用于当前话题），cwd/引擎/profile/danger 等会话设置全部保留
- **全局 danger 落盘持久化**（`engine/runtime-overrides.ts`）— 修复 `/danger on --global` 在 daemon 重启后静默失效：运行时切换写入 `~/.chat-cc/runtime-overrides.json`，启动时叠加在 config.yaml 之上
- **`/cd <@别名|路径>` 切换会话工作目录** — /new chat 建群后可再决定干哪个项目；换目录重开对话（旧上下文不再适用），引擎/profile/danger 等会话设置保留
- **跨群会话隔离** — 「活跃会话」指针从按用户全局一个改为**按群+用户**独立：在哪个群发消息就路由到哪个群的会话，`/new chat` 建新群不再顶掉原群的活跃指针（此前在 A 群发消息可能被 B 群会话处理、且建新群后原会话失联）；`/session switch` 相应收敛为群内切换
- 新增测试：`pending-queue` / `thread-key` / `forward` / `api-profiles` / `owner` / `codex` / `agent-flag`

### Changed

- `LiveStreamer` 支持 replyTarget：话题会话的流式卡片 / AskUser 卡片 / 超长 fallback 消息全部回到话题内；话题会话不参与「用户活跃会话」指针（路由由 thread_id 确定）
- 出站消息重试覆盖代理场景瞬时错误（TLS 握手被掐断、SDK token 获取失败），`patchCard` 复用同一判定

## v3.3.0 (2026-07-07)

P1 可靠性三件套：卡片状态机 + WS 保活 + 回调防重放。

### Changed

- **流式卡片重构为块状态机**（`feishu/cards/live.ts`）— 文本与工具调用按时间交错为 `blocks` 序列；工具调用 ≥3 个时折叠历史仅展开最新（运行中）/ 全部折叠为摘要（终态），折叠摘要只留标题行，避免序列化超过飞书单元素 ~30KB 限制导致 400 打断卡片流；正文超 4500 字符预算时从最早内容裁剪，始终保留最新输出。`streamer.ts` / `commands/ask.ts` 迁移到 `applyEvent()` 状态机。新增 `test/feishu/live-card.test.ts`

### Added

- **WS 连接保活**（`feishu/keepalive.ts`）— 独立 15s 心跳旁路检测：睡眠唤醒检测 → 计时风暴防护 → HTTP 探测区分「网络不可达」vs「WS 卡死」→ 连续 3 次不通才强制重连（销毁旧 WSClient 重建）。另启用 SDK `pingTimeout: 3`（存活看门狗）与 `handshakeTimeoutMs: 8000`（快速失败）
- **卡片回调防重放**（`feishu/callback-store.ts`）— 双层：短窗口去重（3s 内同按钮双击直接吞掉）+ 一次性 nonce（原子写持久化 `~/.chat-cc/callback-nonces.json`，重启后仍生效，支持 revoke）。新增 `test/feishu/callback-store.test.ts`

## v3.2.0 (2026-07-07)

P0 地基批次：SDK 升级 + 会话持久化原子写。

### Changed

- **`@anthropic-ai/claude-agent-sdk` 0.3.161 → 0.3.202** — typecheck / 单测 / build 全绿，resume 与 `CanUseTool` 签名无 breaking change

### Fixed

- **会话持久化改为原子写** — 新增 `src/platform/atomic-write.ts`（写临时文件 → fsync → chmod 600 → rename 原子替换 → 目录 fsync，rename 遇 EPERM/EBUSY 重试），`Persistence.save()` 弃用裸 `writeFileSync`，杜绝进程崩溃/断电时 session 文件写坏。临时文件名含 PID + 随机数，多进程并发安全。新增 `test/platform/atomic-write.test.ts`（8 例）

## v3.1.2 (2026-06-03)

修复 resume 失效导致会话死亡：自动降级为新建会话并重放消息。

### Fixed

- **resume 失效自愈** — 会话被 idle 回收后凭磁盘 `sessionId` 懒恢复时，若 SDK 本地 conversation 已被清理，resume 会失败。旧实现下整个 Session 会死亡（先回一张错误卡，再 `session pump 异常退出`，此后消息石沉大海）。现检测到 `No conversation found` 即自动丢弃失效 sessionId、用不带 resume 的新会话重建并**重放刚才那条消息**，用户直接得到回答；同时发卡提示「原会话上下文已过期，已新建会话继续」（旧对话历史确已丢失），并清除内存与磁盘上的失效 sessionId，避免重启后反复 resume 失败。新增 `test/engine/session.test.ts` 覆盖自愈全链路。

## v3.1.1 (2026-06-03)

修复 issue #4：会话被 idle 回收后无法续接多轮上下文，并改进无活跃会话场景的引导。

### Fixed

- **会话 idle 回收后丢失「当前会话」指针（issue #4 核心）** — `SessionPool.stop()` 在 `keepMeta` 模式（idle 超时自动回收、`restartAll` 前临时停）下会误删 `activeByUser` 活跃指针，导致会话静置超过 `idle_timeout_minutes`（默认 30 分钟）后再发消息被判为「无活跃会话」、静默降级到一次性 `/ask`、丢失多轮上下文（`numTurns` 退回 1）。现仅在彻底销毁（`/session stop`）时清除指针；idle 回收保留指针，后续消息凭磁盘 meta + SDK `resumeId` 懒恢复同一会话
- **降级到 `/ask` 时醒目提示** — `router` 检测到「无活跃会话」自动降级到 `/ask` 时，流式卡片顶部显示警告：本条按一次性提问处理、**不保留上下文**，并引导用户先 `/session start` 开启会话
- **`/session start` 路径不存在引导** — 工作目录不存在时，错误卡片补充完整用法（`@项目别名` / 绝对路径 / Windows 路径示例）

## v3.1.0 (2026-06-03)

依赖全面升级 —— Claude Agent SDK 跨版本 + 工具链 major 更新。功能与对外行为不变，已通过 build / CLI / smoke 验证。

### Changed

- **核心运行时 SDK**
  - `@anthropic-ai/claude-agent-sdk` 0.2.123 → **0.3.161**
  - `@larksuiteoapi/node-sdk` 1.62.0 → **1.66.1**
  - `pino` 9 → **10**，`pino-pretty` 11 → **13**
  - `yaml` 2.6 → **2.9**，`zod` 4.3.6 → **4.4.3**
  - `@anthropic-ai/sdk`（agent-sdk 0.3 改为 peerDependency）随之 0.81 → **0.100.1**
- **构建工具链**
  - `typescript` 5.6 → **6.0**
  - `vitest` 2.1 → **4.1**
  - `@types/node` 22 → **25**，`tsx` 4.19 → **4.22**

### Removed

- **`auto_approve_tools` 默认值清理** — 移除已过时的 `TodoWrite`（SDK 0.3 起改用 Task 工具，`TaskCreate/Update/List/Get` 已在白名单）

### Notes

- **agent-sdk 0.2→0.3 破坏点核对（项目代码均兼容，无需改动）**：移除 v2 session API（项目用 `query()`）、MCP 默认后台连接（feishu server 已设 `alwaysLoad: true`）、`TodoWrite`→Task 工具、错误码调整（`events.ts` 仅读 `is_error`，不匹配错误字符串）、`@anthropic-ai/sdk`/`@modelcontextprotocol/sdk` 转为 peerDependency
- **pino 10** 唯一破坏性变更是放弃 Node 18 支持，项目要求 `node >=20.11`，不受影响

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

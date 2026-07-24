# chat-cc 安装与守护进程运维

## 强制规则

无论人工还是 AI Agent，启动、停止、重启和查询 chat-cc daemon 时都必须使用全局命令：

```bash
chat-cc start
chat-cc stop
chat-cc restart
chat-cc status
```

`chatcc` 是完全等价的别名。

不要使用以下方式管理 daemon：

- `node dist/cli/index.js start`
- `npm start`
- 直接运行 `src/main.ts` 或 `dist/main.js`
- 用 `kill`、`pkill` 手工替代 `chat-cc stop`

全局 CLI 会统一维护 PID 文件、启动锁、就绪握手和 SIGTERM/SIGKILL 降级流程；绕过它可能产生重复 daemon、陈旧 PID 或无法可靠重启。

## 从源码安装或更新

在仓库根目录执行：

```bash
npm run typecheck
npm test
npm run build
npm install -g .
rehash
chat-cc version
```

`npm run build` 会在清理并重新生成 `dist/` 后，自动把 `dist/cli/index.js` 恢复为可执行权限。

## 启动与重启

首次启动：

```bash
chat-cc start
chat-cc status
```

代码、依赖或配置更新后：

```bash
chat-cc restart
chat-cc status
chat-cc logs -n 50
```

前台排障：

```bash
chat-cc stop
chat-cc start --foreground
```

前台进程退出后，再用 `chat-cc start` 恢复后台运行。

## 命令不存在

先确认全局安装和 PATH：

```bash
command -v chat-cc
npm prefix -g
npm ls -g --depth=0 chat-cc
```

若未安装或链接已失效，在仓库根目录重新执行：

```bash
npm run build
npm install -g .
rehash
chat-cc version
```

## 配置升级检查

- `admin_users: []` 会让所有特权命令 fail-closed；部署前配置明确的管理员 `open_id`。
- 配置采用严格 schema，未知字段会阻止启动。`claude_bin`、`hook_port`、`agent_env_allowlist` 作为明确的历史字段会被兼容忽略；升级和回滚前仍应检查目标版本支持的字段。
- `agent_env_allowlist` 已移除；Agent 子进程继承 daemon 的完整环境。不要在 daemon 环境中放入无关敏感凭据。

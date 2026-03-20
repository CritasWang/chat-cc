<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# ChatCC (feishu-bot)

## Purpose

A Feishu (Lark) chatbot that bridges Feishu messaging with Claude Code. Users interact with Claude Code through Feishu chat commands — either stateless one-shot queries (`/ask`) or persistent tmux-backed interactive sessions (`/session`). The bot runs as a daemon process, connects to Feishu via WebSocket, and exposes an HTTP hook server for Claude Code callback notifications.

## Key Files

| File | Description |
|------|-------------|
| `main.go` | Entry point: CLI subcommands (`start/stop/restart/reload/console/status`), module wiring, WebSocket client setup, signal handling, hot-reload logic |
| `config.go` | `Config` struct with YAML deserialization, `LoadConfig()`, `DefaultConfig()`, project alias resolution via `ResolveCWD()` |
| `config.yaml` | Default configuration template with all supported options documented |
| `handler.go` | Feishu event dispatcher: receives messages via WebSocket, parses text, checks permissions (`isAllowed`), routes to command handler asynchronously |
| `router.go` | Command router: dispatches `/command args` to registered `Command` implementations; falls back to active session or `/ask` for plain text |
| `replier.go` | Feishu message API wrapper: `Reply`, `Update`, `SendToChat`, `ReplyCard`, `ReplyChunked`, `ReplyCardChunked`, `SendCardToChat`; includes UTF-8-safe chunking |
| `card.go` | Feishu interactive card (schema 2.0) builder: converts text responses to structured cards with sections, headers, footers, and color inference |
| `session.go` | `SessionManager`: manages tmux-backed Claude Code sessions — `Start`, `Send`, `Stop`, `SendKeys`; polls for output stability; detects interactive prompts and dead panes |
| `hookserver.go` | HTTP server on configurable port; `/notify` endpoint receives Claude Code hook callbacks and forwards messages to Feishu chats |
| `daemon.go` | Daemonization: `daemonStart/Stop/Restart/Reload/Status` with PID file management and graceful shutdown via SIGTERM/SIGHUP |
| `logger.go` | `DailyRotateWriter`: daily log rotation with gzip compression for archived logs |
| `status_pusher.go` | `StatusPusher`: periodic timer that pushes system status cards to a Feishu chat at configurable intervals |
| `go.mod` | Go 1.22 module; depends on `larksuite/oapi-sdk-go/v3` (Feishu SDK) and `gopkg.in/yaml.v3` |
| `feishu-permissions.json` | Required Feishu app permissions (tenant scopes for messaging) |
| `.gitignore` | Ignores compiled binary, local configs, logs, PID files |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `commands/` | Command implementations (ask, session, shell, status, etc.) following the `Command` interface (see `commands/AGENTS.md`) |
| `docs/` | Project documentation and comparisons (see `docs/AGENTS.md`) |
| `logs/` | Runtime log files (gzipped daily archives + current `chatcc.log`); gitignored |

## Architecture

```
Feishu Cloud ──WebSocket──▶ main.go (larkws.Client)
                               │
                          handler.go (EventDispatcher)
                               │
                          router.go (Dispatch)
                           ┌───┴───┐
                      /command    plain text
                           │          │
                      commands/*   fallback: /s → /ask
                           │
                      replier.go ──▶ Feishu API (reply/card)

Claude Code hooks ──HTTP POST──▶ hookserver.go ──▶ replier.go
```

## For AI Agents

### Working In This Directory

- **Language**: Go 1.22, single `main` package at root level with a `commands` sub-package
- **Build**: `go build -o chatcc .` from project root
- **Run**: `./chatcc console --config config.local.yaml` for foreground; `./chatcc start` for daemon
- **Comments and UI strings are in Chinese** (zh-CN) — preserve this convention
- All Feishu API calls go through `replier.go`; never call the Lark SDK directly from commands
- The `Config` struct is the single source of truth for all settings; new config fields require YAML tags
- Hot-reload via SIGHUP updates runtime config without restart (except `app_id`, `app_secret`, `hook_port`)

### Testing Requirements

- No test files exist yet — when adding tests, use Go standard `testing` package
- For `commands/` package: test via the `Command` interface with mock `SessionIface`/`ConfigIface`
- For `session.go`: requires tmux — consider integration tests or mocking `exec.Command`
- Verify build: `go build ./...`

### Common Patterns

- **Command pattern**: All chat commands implement `commands.Command` interface (Name/Aliases/Description/Usage/Execute)
- **Interface adapters**: `sessionManagerAdapter` and `sessionCommandAdapter` in `main.go` bridge the root `SessionManager` to `commands` package interfaces, avoiding circular imports
- **Graceful degradation**: Card replies fall back to plain text on failure; long messages auto-chunk
- **Thread safety**: `sync.RWMutex` used throughout for concurrent access (`SessionManager`, `AskCommand`, `ShellCommand`, `HookServer`, `StatusPusher`)
- **Hot-reload support**: Components expose setter methods (`SetWhitelist`, `SetDefaultChatID`, `UpdateConfig`, `Configure`) called from the centralized `reloadFn`

## Dependencies

### External

- `github.com/larksuite/oapi-sdk-go/v3` — Feishu/Lark Open API SDK (WebSocket, messaging, events)
- `gopkg.in/yaml.v3` — YAML config parsing

### System

- `tmux` — Required for persistent Claude Code sessions (`/session` commands)
- `claude` CLI — Claude Code executable invoked by `/ask` and `/session`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

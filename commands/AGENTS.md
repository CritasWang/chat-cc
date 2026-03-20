<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# commands

## Purpose

Implements all chat commands that users invoke via Feishu messages. Each command follows the `Command` interface and is registered with the `Router` in `main.go`. This package also defines shared interfaces (`SessionIface`, `ConfigIface`, `DangerModeIface`) to decouple commands from the root-level managers, avoiding circular imports.

## Key Files

| File | Description |
|------|-------------|
| `command.go` | `Command` interface definition (Name/Aliases/Description/Usage/Execute), `MessageMeta` struct with `SessionKey()` for per-chat/per-user session routing |
| `ask.go` | `/ask` — Stateless Claude Code queries via `claude -p`; supports `--cwd`, `@alias` project shortcuts, tool whitelisting, danger mode; includes `FilterEnvForClaudeCode()` to prevent nested session detection |
| `session_cmd.go` | `/session` — Manage tmux-backed Claude Code sessions (start/stop/status/list/kill); `/s` — Send message to active session; `SessionInfo` and `SessionIface` interface definitions |
| `key.go` | `/key` — Send raw keystrokes (arrows, Ctrl+C, Tab, Enter, etc.) to active tmux sessions via `KeySender` interface; supports repeat count and friendly aliases (y/n for quick confirm) |
| `shell.go` | `/shell` — Execute whitelisted shell commands with 30s timeout; prefix-based whitelist checking |
| `status.go` | `/status` — System status dashboard: OS info, uptime, active sessions, running Claude processes, tmux sessions, Claude Code version, danger mode state |
| `help.go` | `/help` — Renders full command reference or per-command detailed help with usage examples |
| `project.go` | `/project` — Lists configured project aliases from config |
| `danger.go` | `/danger` — Runtime toggle for `--dangerously-skip-permissions` mode (on/off) |
| `reload.go` | `/reload` — Triggers hot-reload of configuration via injected `ReloadFunc` |

## For AI Agents

### Working In This Directory

- **Package**: `commands` (imported by root `main` package)
- All commands implement the `Command` interface — maintain this pattern when adding new commands
- Commands receive dependencies via constructor injection (interfaces, not concrete types)
- Never import the root `main` package from here — use interfaces to break the dependency cycle
- Chinese strings in user-facing output (descriptions, error messages) — keep consistent

### Adding a New Command

1. Create `newcmd.go` in this directory
2. Define a struct implementing `Command` interface (Name/Aliases/Description/Usage/Execute)
3. Constructor: `NewXxxCommand(deps...)` accepting interface parameters
4. Register in `main.go` via `router.Register(commands.NewXxxCommand(...))`
5. Add to help categories in `help.go` if the command is user-facing

### Testing Requirements

- Mock `SessionIface`, `ConfigIface`, `DangerModeIface`, `KeySender` for unit tests
- `FilterEnvForClaudeCode()` is a pure function — easy to test directly
- `formatDuration()`, `summarizeClaudeCmd()`, `getClaudeProcesses()` are testable utilities

### Common Patterns

- **Interface segregation**: Each command only depends on the interface slice it needs (`SessionIface` for session commands, `ConfigIface` for status, `KeySender` for key)
- **Thread-safe config updates**: `AskCommand` and `ShellCommand` use `sync.RWMutex` for hot-reload safety
- **Consistent error UX**: Commands return user-friendly error strings (not Go errors) — errors are displayed as chat messages
- **Session routing**: `MessageMeta.SessionKey()` returns `ChatID` for groups, `SenderID` for DMs — ensuring per-context session isolation

## Dependencies

### Internal

- Imported by root `main` package via `chatcc/commands`
- Does NOT import any root-level types directly (uses interfaces)

### External

- `os/exec` — For spawning `claude` CLI processes and `ps` for process detection
- Standard library only — no third-party dependencies in this package

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

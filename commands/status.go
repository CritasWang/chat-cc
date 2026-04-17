package commands

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ConfigIface 配置接口，用于获取配置信息
type ConfigIface interface {
	GetDefaultCWD() string
}

// SessionManagerIface 会话管理器接口，用于获取会话信息
type SessionManagerIface interface {
	ListSessions() []SessionInfo
}

type StatusCommand struct {
	config         ConfigIface
	sessionManager SessionManagerIface
	dangerMode     DangerModeIface
}

func NewStatusCommand(cfg ConfigIface, sm SessionManagerIface, dm DangerModeIface) *StatusCommand {
	return &StatusCommand{
		config:         cfg,
		sessionManager: sm,
		dangerMode:     dm,
	}
}

func (c *StatusCommand) Name() string        { return "status" }
func (c *StatusCommand) Aliases() []string   { return nil }
func (c *StatusCommand) Description() string { return "查看本地服务和系统状态" }
func (c *StatusCommand) Usage() string       { return `/status` }

func (c *StatusCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	var sysLines []string
	sysLines = append(sysLines, fmt.Sprintf("OS: `%s/%s`", runtime.GOOS, runtime.GOARCH))
	if out, err := exec.Command("uptime").Output(); err == nil {
		sysLines = append(sysLines, fmt.Sprintf("Uptime: `%s`", strings.TrimSpace(string(out))))
	}
	if c.config != nil {
		sysLines = append(sysLines, fmt.Sprintf("默认目录: `%s`", c.config.GetDefaultCWD()))
	}

	// Claude Code 活跃会话
	var sessionLines []string
	if c.sessionManager != nil {
		sessions := c.sessionManager.ListSessions()
		if len(sessions) > 0 {
			for _, session := range sessions {
				elapsed := time.Since(session.CreatedAt)
				sessionLines = append(sessionLines, fmt.Sprintf("• `%s` · `%s` · %s", session.Name, session.CWD, formatDuration(elapsed)))
			}
		}
	}
	if len(sessionLines) == 0 {
		sessionLines = append(sessionLines, "*(无活跃会话)*")
	}

	// 活跃 Claude 进程
	var procLines []string
	claudeProcs := getClaudeProcesses()
	for _, p := range claudeProcs {
		procLines = append(procLines, fmt.Sprintf("• [PID %s] %s · 运行 %s", p.pid, p.summary, p.elapsed))
	}
	if len(procLines) == 0 {
		procLines = append(procLines, "*(无活跃进程)*")
	}

	// tmux 列表
	tmuxOutput := "*(无活跃会话)*"
	if out, err := exec.Command("tmux", "list-sessions").Output(); err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			tmuxOutput = "```\n" + s + "\n```"
		}
	}

	// Claude Code 版本
	claudeVersion := "未安装或不在 PATH 中"
	if out, err := exec.Command("claude", "--version").Output(); err == nil {
		claudeVersion = strings.TrimSpace(string(out))
	}

	// Danger 模式
	dangerStatus := "🔒 Danger 模式：**关闭**（使用工具白名单）"
	dangerBtnLabel := "⚡ 开启 Danger"
	dangerBtnStyle := btnStyleDefault
	if c.dangerMode != nil && c.dangerMode.IsDangerMode() {
		dangerStatus = "⚠️ Danger 模式：**开启**（跳过所有权限检查）"
		dangerBtnLabel = "🔒 关闭 Danger"
		dangerBtnStyle = btnStyleDanger
	}

	elements := []cuElement{
		cuMD("**🖥 系统**\n" + strings.Join(sysLines, "  ·  ")),
		cuHr(),
		cuMD("**🔄 活跃会话**\n" + strings.Join(sessionLines, "\n")),
		cuHr(),
		cuMD("**🤖 Claude 进程**\n" + strings.Join(procLines, "\n")),
		cuHr(),
		cuMD("**📺 tmux 会话**\n" + tmuxOutput),
		cuHr(),
		cuMD("**🔧 Claude Code 版本**  `" + claudeVersion + "`"),
		cuHr(),
		cuMD(dangerStatus),
		cuHr(),
		cuBtnRow(
			cuCmdBtnRefresh("🔄 刷新", btnStylePrimary, "status", "", "status"),
			cuCmdBtnRefresh(dangerBtnLabel, dangerBtnStyle, "danger", "toggle", "status"),
			cuCmdBtn("♻️ 重载配置", btnStyleDefault, "reload", ""),
		),
		cuBtnRow(
			cuCmdBtn("📂 项目", btnStyleDefault, "project", ""),
			cuCmdBtn("📋 会话列表", btnStyleDefault, "session", "list"),
			cuCmdBtn("❓ 帮助", btnStyleDefault, "help", ""),
		),
		cuMD(fmt.Sprintf("*⏱️ 查询时间：%s*", time.Now().Format("2006-01-02 15:04:05"))),
	}

	return CardJSONMarker + cuBuild("📊 系统状态", "indigo", elements), nil
}

// claudeProcess 表示一个运行中的 claude 进程
type claudeProcess struct {
	pid     string
	summary string
	elapsed string
}

// getClaudeProcesses 检测系统中运行的 claude 进程
func getClaudeProcesses() []claudeProcess {
	// 使用 ps 获取 claude 进程: PID, 运行时间, 完整命令
	out, err := exec.Command("ps", "-eo", "pid,etime,command").Output()
	if err != nil {
		return nil
	}

	var procs []claudeProcess
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		// 只匹配 claude 进程（排除 grep 自身和 chatcc 进程）
		if !strings.Contains(line, "claude") {
			continue
		}
		if strings.Contains(line, "grep") || strings.Contains(line, "chatcc") {
			continue
		}
		// 排除 node mcp-server 等辅助进程
		if strings.Contains(line, "mcp-server") || strings.Contains(line, "node ") {
			continue
		}
		// 排除 hooks 和 shell-snapshots 辅助脚本
		if strings.Contains(line, "hooks/") || strings.Contains(line, "shell-snapshots") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}

		pid := fields[0]
		elapsed := fields[1]
		cmdFull := strings.Join(fields[2:], " ")

		// 生成摘要
		summary := summarizeClaudeCmd(cmdFull)
		if summary == "" {
			continue
		}

		procs = append(procs, claudeProcess{
			pid:     pid,
			summary: summary,
			elapsed: elapsed,
		})
	}
	return procs
}

// summarizeClaudeCmd 从完整命令行生成简洁摘要
func summarizeClaudeCmd(cmd string) string {
	// 只处理 claude 命令（可能是完整路径）
	if !strings.Contains(cmd, "claude") {
		return ""
	}

	// 检查是否是 vscode 集成
	if strings.Contains(cmd, "vscode") || strings.Contains(cmd, ".vscode") {
		return "VSCode 集成"
	}

	// 判断模式
	if strings.Contains(cmd, " -p ") {
		// ask 模式: claude -p "prompt"
		idx := strings.Index(cmd, " -p ")
		if idx >= 0 {
			prompt := cmd[idx+4:]
			// 去掉后续 flag
			if flagIdx := strings.Index(prompt, " --"); flagIdx > 0 {
				prompt = prompt[:flagIdx]
			}
			prompt = strings.TrimSpace(prompt)
			// 截断显示
			runes := []rune(prompt)
			if len(runes) > 50 {
				prompt = string(runes[:50]) + "..."
			}
			return fmt.Sprintf("ask 模式: %s", prompt)
		}
	}

	if strings.Contains(cmd, "--dangerously-skip-permissions") {
		return "交互模式 (danger)"
	}

	return "交互模式"
}

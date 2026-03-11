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

// SessionInfo 会话信息
type SessionInfo struct {
	Name      string
	CWD       string
	CreatedAt time.Time
	Active    bool
}

type StatusCommand struct {
	config         ConfigIface
	sessionManager SessionManagerIface
}

func NewStatusCommand(cfg ConfigIface, sm SessionManagerIface) *StatusCommand {
	return &StatusCommand{
		config:         cfg,
		sessionManager: sm,
	}
}

func (c *StatusCommand) Name() string        { return "status" }
func (c *StatusCommand) Aliases() []string   { return nil }
func (c *StatusCommand) Description() string { return "查看本地服务和系统状态" }
func (c *StatusCommand) Usage() string       { return `/status` }

func (c *StatusCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	var sb strings.Builder
	sb.WriteString("📊 系统状态\n\n")

	// 系统信息
	sb.WriteString(fmt.Sprintf("  OS: %s/%s\n", runtime.GOOS, runtime.GOARCH))

	// uptime
	if out, err := exec.Command("uptime").Output(); err == nil {
		sb.WriteString(fmt.Sprintf("  Uptime: %s\n", strings.TrimSpace(string(out))))
	}

	// 当前工作目录
	if c.config != nil {
		sb.WriteString(fmt.Sprintf("\n📁 默认工作目录:\n  %s\n", c.config.GetDefaultCWD()))
	}

	// Claude Code 活跃会话
	sb.WriteString("\n🔄 Claude Code 活跃会话:\n")
	if c.sessionManager != nil {
		sessions := c.sessionManager.ListSessions()
		if len(sessions) > 0 {
			for _, session := range sessions {
				elapsed := time.Since(session.CreatedAt)
				sb.WriteString(fmt.Sprintf("  • %s\n", session.Name))
				sb.WriteString(fmt.Sprintf("    工作目录: %s\n", session.CWD))
				sb.WriteString(fmt.Sprintf("    运行时间: %s\n", formatDuration(elapsed)))
			}
		} else {
			sb.WriteString("  (无活跃会话)\n")
		}
	} else {
		sb.WriteString("  (无会话管理器)\n")
	}

	// tmux 会话
	sb.WriteString("\n📺 tmux 会话:\n")
	if out, err := exec.Command("tmux", "list-sessions").Output(); err == nil {
		sessions := strings.TrimSpace(string(out))
		if sessions != "" {
			for _, line := range strings.Split(sessions, "\n") {
				sb.WriteString(fmt.Sprintf("  %s\n", line))
			}
		}
	} else {
		sb.WriteString("  (无活跃会话)\n")
	}

	// Claude Code 版本
	sb.WriteString("\n🤖 Claude Code:\n")
	if out, err := exec.Command("claude", "--version").Output(); err == nil {
		sb.WriteString(fmt.Sprintf("  版本: %s\n", strings.TrimSpace(string(out))))
	} else {
		sb.WriteString("  未安装或不在 PATH 中\n")
	}

	sb.WriteString(fmt.Sprintf("\n⏱️ 查询时间: %s", time.Now().Format("2006-01-02 15:04:05")))

	return sb.String(), nil
}

// formatDuration 格式化时长为易读格式
func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.0f秒", d.Seconds())
	}
	if d < time.Hour {
		return fmt.Sprintf("%.0f分钟", d.Minutes())
	}
	hours := int(d.Hours())
	minutes := int(d.Minutes()) % 60
	if minutes > 0 {
		return fmt.Sprintf("%d小时%d分钟", hours, minutes)
	}
	return fmt.Sprintf("%d小时", hours)
}

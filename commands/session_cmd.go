package commands

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// SessionInfo 会话信息（用于显示）
type SessionInfo struct {
	Name      string
	Label     string // 用户可见标签
	CWD       string
	CreatedAt time.Time
	Active    bool
	IsActive  bool // 是否为当前活跃会话
}

// SessionIface 会话管理器接口，避免循环依赖
type SessionIface interface {
	Start(key, cwd string) error
	StartNamed(key, label, cwd string) error
	Send(key, message string) (string, error)
	SendWithStream(key, message string, streamFn func(text string)) (string, error)
	SendKeys(key string, tmuxKeys ...string) error
	Stop(key string) error
	StopByLabel(key, label string) error
	Switch(key, target string) error
	GetSession(key string) (SessionInfo, bool)
	ListUserSessions(key string) []SessionInfo
	ListAllSessions() []SessionInfo
	KillByName(name string) error
}

// DangerModeIface 危险模式查询接口
type DangerModeIface interface {
	IsDangerMode() bool
}

type SessionCommand struct {
	sm SessionIface
}

func NewSessionCommand(sm SessionIface) *SessionCommand {
	return &SessionCommand{sm: sm}
}

func (c *SessionCommand) Name() string      { return "session" }
func (c *SessionCommand) Aliases() []string { return nil }
func (c *SessionCommand) Description() string {
	return "管理 Claude Code 持久会话（tmux）"
}
func (c *SessionCommand) Usage() string {
	return `/session start [--name <标签>] [目录或@别名]  启动新会话
/session stop [标签]                        关闭会话（默认关闭活跃会话）
/session switch <标签或序号>                切换活跃会话
/session list                               列出当前所有会话
/session status                             查看活跃会话详情
/session kill <会话名>                      终止指定会话`
}

func (c *SessionCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	parts := strings.SplitN(strings.TrimSpace(args), " ", 2)
	if len(parts) == 0 || parts[0] == "" {
		return c.Usage(), nil
	}

	subCmd := parts[0]
	subArgs := ""
	if len(parts) > 1 {
		subArgs = parts[1]
	}

	key := meta.SessionKey()

	switch subCmd {
	case "start":
		label, cwd := parseStartArgs(subArgs)
		if label != "" {
			if err := c.sm.StartNamed(key, label, cwd); err != nil {
				return fmt.Sprintf("启动失败: %s", err), nil
			}
		} else {
			if err := c.sm.Start(key, cwd); err != nil {
				return fmt.Sprintf("启动失败: %s", err), nil
			}
		}
		cwdDisplay := cwd
		if cwdDisplay == "" {
			cwdDisplay = "(默认目录)"
		}
		labelDisplay := label
		if labelDisplay == "" {
			labelDisplay = "(自动)"
		}
		return fmt.Sprintf("✅ Claude Code 会话已启动\n标签: %s\n工作目录: %s\n\n使用 /s <消息> 与 Claude 对话\n使用 /session list 查看所有会话\n使用 /session switch <标签> 切换会话\n使用 /session stop 关闭会话", labelDisplay, cwdDisplay), nil

	case "stop":
		label := strings.TrimSpace(subArgs)
		var err error
		if label != "" {
			err = c.sm.StopByLabel(key, label)
		} else {
			err = c.sm.Stop(key)
		}
		if err != nil {
			return fmt.Sprintf("关闭失败: %s", err), nil
		}
		if label != "" {
			return fmt.Sprintf("✅ 会话 %q 已关闭", label), nil
		}
		return "✅ 活跃会话已关闭", nil

	case "switch", "sw":
		target := strings.TrimSpace(subArgs)
		if target == "" {
			return "请指定要切换的会话标签或序号\n\n用法: /session switch <标签或序号>\n使用 /session list 查看所有会话", nil
		}
		if err := c.sm.Switch(key, target); err != nil {
			return fmt.Sprintf("切换失败: %s", err), nil
		}
		return fmt.Sprintf("✅ 已切换到会话: %s", target), nil

	case "new":
		// /session new [--name <label>] [cwd] 的快捷方式
		label, cwd := parseStartArgs(subArgs)
		if err := c.sm.StartNamed(key, label, cwd); err != nil {
			return fmt.Sprintf("创建会话失败: %s", err), nil
		}
		labelDisplay := label
		if labelDisplay == "" {
			labelDisplay = "(自动)"
		}
		return fmt.Sprintf("✅ 新会话已创建并切换\n标签: %s\n\n使用 /session list 查看所有会话", labelDisplay), nil

	case "status":
		session, ok := c.sm.GetSession(key)
		if !ok {
			return "❌ 当前没有活跃的会话\n\n使用 /session start [目录] 启动新会话", nil
		}
		return formatSessionDetail(session), nil

	case "list", "ls":
		sessions := c.sm.ListUserSessions(key)
		if len(sessions) == 0 {
			return "📋 当前没有任何会话\n\n使用 /session start [目录] 启动新会话", nil
		}
		return formatSessionList(sessions), nil

	case "kill":
		if subArgs == "" {
			return "❌ 请指定要终止的会话名称或标签\n\n使用 /session list 查看所有会话", nil
		}
		sessionName := strings.TrimSpace(subArgs)
		if err := c.sm.KillByName(sessionName); err != nil {
			return fmt.Sprintf("❌ 终止失败: %s", err), nil
		}
		return fmt.Sprintf("✅ 会话 %s 已终止", sessionName), nil

	default:
		return fmt.Sprintf("未知子命令: %s\n%s", subCmd, c.Usage()), nil
	}
}

// parseStartArgs 解析 start/new 命令参数
// 支持: --name <label> [cwd] 或直接 [cwd]
func parseStartArgs(args string) (label, cwd string) {
	args = strings.TrimSpace(args)
	if args == "" {
		return "", ""
	}

	if strings.HasPrefix(args, "--name ") {
		rest := args[7:]
		parts := strings.SplitN(rest, " ", 2)
		label = parts[0]
		if len(parts) > 1 {
			cwd = strings.TrimSpace(parts[1])
		}
		return label, cwd
	}

	return "", args
}

// formatSessionDetail 格式化单个会话详情
func formatSessionDetail(session SessionInfo) string {
	var sb strings.Builder
	sb.WriteString("📊 活跃会话详情\n\n")
	sb.WriteString(fmt.Sprintf("  标签: %s\n", session.Label))
	sb.WriteString(fmt.Sprintf("  tmux 名称: %s\n", session.Name))
	sb.WriteString(fmt.Sprintf("  工作目录: %s\n", session.CWD))
	sb.WriteString(fmt.Sprintf("  创建时间: %s\n", session.CreatedAt.Format("2006-01-02 15:04:05")))

	elapsed := time.Since(session.CreatedAt)
	sb.WriteString(fmt.Sprintf("  运行时间: %s\n", formatDuration(elapsed)))
	sb.WriteString(fmt.Sprintf("  状态: %s", getStatusText(session.Active)))

	return sb.String()
}

// formatSessionList 格式化会话列表（含活跃标识）
func formatSessionList(sessions []SessionInfo) string {
	var sb strings.Builder
	sb.WriteString("📋 会话列表\n\n")

	for i, session := range sessions {
		elapsed := time.Since(session.CreatedAt)
		activeMarker := "  "
		if session.IsActive {
			activeMarker = "▸ "
		}
		sb.WriteString(fmt.Sprintf("%s%d. [%s] %s\n", activeMarker, i+1, session.Label, session.Name))
		sb.WriteString(fmt.Sprintf("     工作目录: %s\n", session.CWD))
		sb.WriteString(fmt.Sprintf("     运行时间: %s\n", formatDuration(elapsed)))
		if i < len(sessions)-1 {
			sb.WriteString("\n")
		}
	}

	activeCount := 0
	for _, s := range sessions {
		if s.IsActive {
			activeCount++
		}
	}

	sb.WriteString(fmt.Sprintf("\n共 %d 个会话", len(sessions)))
	if activeCount > 0 {
		sb.WriteString(fmt.Sprintf("（▸ 标记为当前活跃）"))
	}
	sb.WriteString("\n\n💡 使用 /session switch <标签或序号> 切换会话")
	sb.WriteString("\n💡 使用 /session new [--name <标签>] [目录] 创建新会话")
	sb.WriteString("\n💡 使用 /session stop [标签] 关闭会话")

	return sb.String()
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

// getStatusText 获取状态文本
func getStatusText(active bool) string {
	if active {
		return "🟢 活跃"
	}
	return "🔴 已停止"
}

// SendCommand 是 /s 的快捷命令，直接发送消息到活跃会话
type SendCommand struct {
	sm SessionIface
}

func NewSendCommand(sm SessionIface) *SendCommand {
	return &SendCommand{sm: sm}
}

func (c *SendCommand) Name() string        { return "s" }
func (c *SendCommand) Aliases() []string   { return nil }
func (c *SendCommand) Description() string { return "向活跃的 Claude Code 会话发送消息" }
func (c *SendCommand) Usage() string       { return `/s <消息内容>` }

func (c *SendCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	msg := strings.TrimSpace(args)
	if msg == "" {
		return "请输入消息内容: /s <消息>", nil
	}

	key := meta.SessionKey()

	// 如果有流式回调，使用 SendWithStream
	if meta.StreamFn != nil {
		response, err := c.sm.SendWithStream(key, msg, meta.StreamFn)
		if err != nil {
			return fmt.Sprintf("发送失败: %s", err), nil
		}
		return response, nil
	}

	response, err := c.sm.Send(key, msg)
	if err != nil {
		return fmt.Sprintf("发送失败: %s", err), nil
	}

	return response, nil
}

package commands

import (
	"context"
	"fmt"
	"strings"
)

// SessionIface 会话管理器接口，避免循环依赖
type SessionIface interface {
	Start(key, cwd string) error
	Send(key, message string) (string, error)
	Stop(key string) error
}

type SessionCommand struct {
	sm     SessionIface
}

func NewSessionCommand(sm SessionIface) *SessionCommand {
	return &SessionCommand{sm: sm}
}

func (c *SessionCommand) Name() string        { return "session" }
func (c *SessionCommand) Aliases() []string    { return nil }
func (c *SessionCommand) Description() string  { return "管理 Claude Code 持久会话（tmux）" }
func (c *SessionCommand) Usage() string {
	return `/session start [目录或@别名]  — 启动交互会话
/session stop                — 关闭当前会话
/session status              — 查看会话状态`
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
		if err := c.sm.Start(key, subArgs); err != nil {
			return fmt.Sprintf("启动失败: %s", err), nil
		}
		cwd := subArgs
		if cwd == "" {
			cwd = "(默认目录)"
		}
		return fmt.Sprintf("✅ Claude Code 会话已启动\n工作目录: %s\n\n使用 /s <消息> 与 Claude 对话\n使用 /session stop 关闭会话", cwd), nil

	case "stop":
		if err := c.sm.Stop(key); err != nil {
			return fmt.Sprintf("关闭失败: %s", err), nil
		}
		return "会话已关闭", nil

	case "status":
		return "查询会话状态...", nil // TODO: 返回会话详情

	default:
		return fmt.Sprintf("未知子命令: %s\n%s", subCmd, c.Usage()), nil
	}
}

// SendCommand 是 /s 的快捷命令，直接发送消息到活跃会话
type SendCommand struct {
	sm SessionIface
}

func NewSendCommand(sm SessionIface) *SendCommand {
	return &SendCommand{sm: sm}
}

func (c *SendCommand) Name() string        { return "s" }
func (c *SendCommand) Aliases() []string    { return nil }
func (c *SendCommand) Description() string  { return "向活跃的 Claude Code 会话发送消息" }
func (c *SendCommand) Usage() string        { return `/s <消息内容>` }

func (c *SendCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	msg := strings.TrimSpace(args)
	if msg == "" {
		return "请输入消息内容: /s <消息>", nil
	}

	key := meta.SessionKey()
	response, err := c.sm.Send(key, msg)
	if err != nil {
		return fmt.Sprintf("发送失败: %s", err), nil
	}

	return response, nil
}

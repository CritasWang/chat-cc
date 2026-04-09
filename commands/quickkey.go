package commands

import (
	"context"
	"fmt"
)

// QuickKeyCommand 实现快捷键命令（/y /n /enter /esc /tab /1 /2 /3）
// 每个快捷命令转换为对应的 tmux 按键序列，发送到用户当前活跃会话
type QuickKeyCommand struct {
	name    string   // 命令名，如 "y"
	display string   // 友好显示名，如 "y↵ 允许"
	keys    []string // tmux 按键序列，如 ["y"] 或 ["Enter"]
	sm      SessionIface
}

// NewQuickKeyCommand 构造快捷键命令
func NewQuickKeyCommand(name, display string, keys []string, sm SessionIface) *QuickKeyCommand {
	return &QuickKeyCommand{
		name:    name,
		display: display,
		keys:    keys,
		sm:      sm,
	}
}

func (c *QuickKeyCommand) Name() string        { return c.name }
func (c *QuickKeyCommand) Aliases() []string   { return nil }
func (c *QuickKeyCommand) Description() string { return "快捷键: " + c.display }
func (c *QuickKeyCommand) Usage() string {
	return "/" + c.name + "  向活跃会话发送 " + c.display
}

func (c *QuickKeyCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	key := meta.SessionKey()
	if err := c.sm.SendKeys(key, c.keys...); err != nil {
		return fmt.Sprintf("❌ 发送失败: %s\n\n💡 请先使用 /session start 启动会话", err), nil
	}
	return fmt.Sprintf("⌨️ 已发送 %s", c.display), nil
}

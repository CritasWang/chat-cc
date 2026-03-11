package commands

import (
	"context"
	"fmt"
	"strings"
)

type DangerCommand struct {
	askCmd *AskCommand
}

func NewDangerCommand(askCmd *AskCommand) *DangerCommand {
	return &DangerCommand{askCmd: askCmd}
}

func (c *DangerCommand) Name() string        { return "danger" }
func (c *DangerCommand) Aliases() []string    { return nil }
func (c *DangerCommand) Description() string  { return "切换 Claude Code 权限绕过模式" }
func (c *DangerCommand) Usage() string {
	return `/danger on     开启（跳过所有权限检查）
/danger off    关闭（使用工具白名单）
/danger        查看当前状态`
}

func (c *DangerCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	switch strings.TrimSpace(strings.ToLower(args)) {
	case "on", "true", "1":
		c.askCmd.SetDangerMode(true)
		return "⚠️ Danger 模式已开启 — Claude Code 将跳过所有权限检查", nil
	case "off", "false", "0":
		c.askCmd.SetDangerMode(false)
		return "🔒 Danger 模式已关闭 — Claude Code 使用工具白名单", nil
	case "":
		status := "🔒 关闭（工具白名单）"
		if c.askCmd.IsDangerMode() {
			status = "⚠️ 开启（跳过权限检查）"
		}
		return fmt.Sprintf("Danger 模式: %s\n\n用法:\n%s", status, c.Usage()), nil
	default:
		return fmt.Sprintf("未知参数: %s\n\n%s", args, c.Usage()), nil
	}
}

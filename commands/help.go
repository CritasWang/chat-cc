package commands

import (
	"context"
	"fmt"
	"strings"
)

type HelpCommand struct {
	commands []Command // 注入所有已注册的命令
}

func NewHelpCommand() *HelpCommand {
	return &HelpCommand{}
}

// SetCommands 注入所有命令列表（在 router 注册完成后调用）
func (c *HelpCommand) SetCommands(cmds []Command) {
	c.commands = cmds
}

func (c *HelpCommand) Name() string        { return "help" }
func (c *HelpCommand) Aliases() []string    { return []string{"h", "?"} }
func (c *HelpCommand) Description() string  { return "显示帮助信息" }
func (c *HelpCommand) Usage() string        { return `/help [命令名]` }

func (c *HelpCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	target := strings.TrimSpace(args)

	// 指定命令的详细帮助
	if target != "" {
		for _, cmd := range c.commands {
			if cmd.Name() == target {
				aliases := ""
				if len(cmd.Aliases()) > 0 {
					aliases = fmt.Sprintf("\n别名: /%s", strings.Join(cmd.Aliases(), ", /"))
				}
				return fmt.Sprintf("📖 /%s — %s%s\n\n%s", cmd.Name(), cmd.Description(), aliases, cmd.Usage()), nil
			}
		}
		return fmt.Sprintf("未知命令: %s", target), nil
	}

	// 完整命令列表
	var sb strings.Builder
	sb.WriteString("📋 飞书机器人命令列表\n")
	sb.WriteString("━━━━━━━━━━━━━━━━━━━━\n\n")

	sb.WriteString("🤖 Claude Code\n")
	sb.WriteString("  /ask <提示词>              无状态问答\n")
	sb.WriteString("  /ask --cwd <目录> <提示词>  指定工作目录\n")
	sb.WriteString("  /ask @别名 <提示词>         用项目别名\n\n")

	sb.WriteString("💬 持久会话\n")
	sb.WriteString("  /session start [目录]      启动 tmux 会话\n")
	sb.WriteString("  /s <消息>                  发送到活跃会话\n")
	sb.WriteString("  /session stop              关闭会话\n")
	sb.WriteString("  /session status            查看会话状态\n\n")

	sb.WriteString("🛠 工具\n")
	sb.WriteString("  /shell <命令>              执行白名单命令\n")
	sb.WriteString("  /danger on|off             切换权限绕过模式\n")
	sb.WriteString("  /status                    查看系统状态\n")
	sb.WriteString("  /help [命令]               帮助信息\n\n")

	sb.WriteString("💡 示例\n")
	sb.WriteString("  /ask 帮我看看有什么文件\n")
	sb.WriteString("  /ask @server 看看迁移方案\n")
	sb.WriteString("  /session start /path/to/project\n")
	sb.WriteString("  /s 帮我重构这个函数\n")
	sb.WriteString("  /shell docker ps\n\n")

	sb.WriteString("直接发送消息（无 / 前缀）:\n")
	sb.WriteString("  有活跃会话 → 发送到会话\n")
	sb.WriteString("  无活跃会话 → 等同 /ask\n\n")

	sb.WriteString("输入 /help <命令名> 查看详细用法")
	return sb.String(), nil
}

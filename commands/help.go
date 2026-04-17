package commands

import (
	"context"
	"fmt"
	"strings"
)

type HelpCommand struct {
	commands []Command
}

func NewHelpCommand() *HelpCommand {
	return &HelpCommand{}
}

// SetCommands 注入所有命令列表（在 router 注册完成后调用）
func (c *HelpCommand) SetCommands(cmds []Command) {
	c.commands = cmds
}

func (c *HelpCommand) Name() string        { return "help" }
func (c *HelpCommand) Aliases() []string   { return []string{"h", "?"} }
func (c *HelpCommand) Description() string { return "显示帮助信息" }
func (c *HelpCommand) Usage() string       { return `/help [命令名]` }

func (c *HelpCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	target := strings.TrimSpace(args)

	// 指定命令的详细帮助（纯文本，走 TextToCard 渲染）
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

	// 完整命令列表 → 直接构建飞书卡片 JSON
	return CardJSONMarker + buildHelpCard(), nil
}

// buildHelpCard 构造带交互按钮的帮助卡片
func buildHelpCard() string {
	elements := []cuElement{
		// ⚡ 快捷按键区（直接点击发送到活跃会话）
		cuMD("**⚡ 快捷按键**（点击发送到活跃会话）"),
		cuBtnRow(
			cuKeyBtn("y", "y", "已确认 y↵"),
			cuKeyBtn("n", "n", "已拒绝 n↵"),
			cuKeyBtn("↵", "enter", "已发送 ↵"),
			cuKeyBtn("⎋", "esc", "已取消"),
			cuKeyBtn("⇥", "tab", "已发送 ⇥"),
		),
		cuBtnRow(
			cuKeyBtn("1", "1", "已选 1↵"),
			cuKeyBtn("2", "2", "已选 2↵"),
			cuKeyBtn("3", "3", "已选 3↵"),
			cuKeyBtn("↑", "up", "已发送 ↑"),
			cuKeyBtn("↓", "down", "已发送 ↓"),
		),
		cuHr(),

		// 🎯 常用功能（跳转卡片）
		cuMD("**🎯 常用功能**"),
		cuBtnRow(
			cuCmdBtn("📊 状态", btnStyleDefault, "status", ""),
			cuCmdBtn("📂 项目", btnStyleDefault, "project", ""),
			cuCmdBtn("📋 会话", btnStyleDefault, "session", "list"),
			cuCmdBtn("⚡ Danger", btnStyleDefault, "danger", ""),
			cuCmdBtn("♻️ 重载", btnStyleDefault, "reload", ""),
		),
		cuHr(),

		// 🎮 宏指令说明
		cuMD("**🎮 宏指令 /do**（秒杀 TUI 菜单）\n" +
			"`/do 2d sp ok`  ↓↓ 空格 回车\n" +
			"`/do 3d sp 2d sp ok`  多选操作\n" +
			"动作: `d`↓ `u`↑ `sp`空格 `ok`回车 `esc`取消  数字前缀=重复"),
		cuHr(),

		// 💬 会话
		cuMD("**💬 会话交互**\n" +
			"`/s <消息>`  发送到活跃会话\n" +
			"`/session start [目录]`  启动会话\n" +
			"`/session switch <标签>`  切换  ·  `/session list`  列出\n" +
			"`/session stop [标签]`  关闭\n" +
			"`/key <按键> [次数]`  特殊按键 (up/down/ctrl+c...)"),
		cuHr(),

		// 🤖 问答
		cuMD("**🤖 无状态问答**\n" +
			"`/ask <提示词>`  一次性问答\n" +
			"`/ask @别名 <提示词>`  指定项目目录"),
		cuHr(),

		// 🛠 管理
		cuMD("**🛠 管理**\n" +
			"`/status`  系统状态  ·  `/project`  项目别名\n" +
			"`/shell <命令>`  白名单命令  ·  `/danger on|off`  权限模式\n" +
			"`/reload`  热重载配置"),
		cuHr(),

		// Footer
		cuMD("*📺 实况转播自动运行 · 按钮直发 · 直接发消息=发到会话 · /help <命令> 查看详情*"),
	}

	return cuBuild("📋 ChatCC 命令手册", "blue", elements)
}

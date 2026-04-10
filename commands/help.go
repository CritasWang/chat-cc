package commands

import (
	"context"
	"encoding/json"
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

	// 完整命令列表 → 直接构建飞书卡片 JSON（命令用 backtick 渲染为可复制 inline code）
	return CardJSONMarker + buildHelpCard(), nil
}

// --- 飞书卡片 JSON 构建（自包含，不依赖 main 包的 card.go） ---

type helpCardText struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

type helpCardElement struct {
	Tag      string         `json:"tag"`
	Content  string         `json:"content,omitempty"`
	Elements []helpCardText `json:"elements,omitempty"`
}

type helpCard struct {
	Schema string `json:"schema"`
	Config struct {
		WideScreenMode bool `json:"wide_screen_mode"`
	} `json:"config"`
	Header struct {
		Title    helpCardText `json:"title"`
		Template string       `json:"template"`
	} `json:"header"`
	Body struct {
		Elements []helpCardElement `json:"elements"`
	} `json:"body"`
}

func buildHelpCard() string {
	elements := []helpCardElement{
		// ⚡ 快捷操作
		{Tag: "markdown", Content: "**⚡ 快捷操作**\n" +
			"`/y` 允许  ·  `/n` 拒绝  ·  `/enter` 回车  ·  `/esc` 取消\n" +
			"`/1` `/2` `/3` 数字选项  ·  `/tab` Tab"},
		{Tag: "hr"},

		// 🎮 宏指令
		{Tag: "markdown", Content: "**🎮 宏指令 /do**（秒杀 TUI 菜单）\n" +
			"`/do 2d sp ok`  ↓↓ 空格 回车\n" +
			"`/do 3d sp 2d sp ok`  多选操作\n" +
			"动作: `d`↓ `u`↑ `sp`空格 `ok`回车 `esc`取消  数字前缀=重复"},
		{Tag: "hr"},

		// 💬 会话
		{Tag: "markdown", Content: "**💬 会话交互**\n" +
			"`/s <消息>`  发送到活跃会话\n" +
			"`/session start [目录]`  启动会话\n" +
			"`/session switch <标签>`  切换  ·  `/session list`  列出\n" +
			"`/session stop [标签]`  关闭\n" +
			"`/key <按键> [次数]`  特殊按键 (up/down/ctrl+c...)"},
		{Tag: "hr"},

		// 🤖 问答
		{Tag: "markdown", Content: "**🤖 无状态问答**\n" +
			"`/ask <提示词>`  一次性问答\n" +
			"`/ask @别名 <提示词>`  指定项目目录"},
		{Tag: "hr"},

		// 🛠 管理
		{Tag: "markdown", Content: "**🛠 管理**\n" +
			"`/status`  系统状态  ·  `/project`  项目别名\n" +
			"`/shell <命令>`  白名单命令  ·  `/danger on|off`  权限模式\n" +
			"`/reload`  热重载配置"},
		{Tag: "hr"},

		// Footer（schema V2 不支持 note，用 markdown 斜体替代）
		{Tag: "markdown", Content: "*📺 实况转播自动运行 · 直接发消息=发到会话 · /help <命令> 查看详情*"},
	}

	card := helpCard{}
	card.Schema = "2.0"
	card.Config.WideScreenMode = true
	card.Header.Title = helpCardText{Tag: "plain_text", Content: "📋 ChatCC 命令手册"}
	card.Header.Template = "blue"
	card.Body.Elements = elements

	data, _ := json.Marshal(card)
	return string(data)
}

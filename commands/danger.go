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
func (c *DangerCommand) Aliases() []string   { return nil }
func (c *DangerCommand) Description() string { return "切换 Claude Code 权限绕过模式" }
func (c *DangerCommand) Usage() string {
	return `/danger on     开启（跳过所有权限检查）
/danger off    关闭（使用工具白名单）
/danger toggle 反转当前状态
/danger        查看当前状态`
}

func (c *DangerCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	switch strings.TrimSpace(strings.ToLower(args)) {
	case "on", "true", "1":
		c.askCmd.SetDangerMode(true)
		return CardJSONMarker + buildDangerCard(true, "⚠️ Danger 模式已开启"), nil
	case "off", "false", "0":
		c.askCmd.SetDangerMode(false)
		return CardJSONMarker + buildDangerCard(false, "🔒 Danger 模式已关闭"), nil
	case "toggle", "switch", "t":
		newState := !c.askCmd.IsDangerMode()
		c.askCmd.SetDangerMode(newState)
		msg := "🔒 Danger 模式已关闭"
		if newState {
			msg = "⚠️ Danger 模式已开启"
		}
		return CardJSONMarker + buildDangerCard(newState, msg), nil
	case "":
		return CardJSONMarker + buildDangerCard(c.askCmd.IsDangerMode(), ""), nil
	default:
		return fmt.Sprintf("未知参数: %s\n\n%s", args, c.Usage()), nil
	}
}

// buildDangerCard 构造 Danger 模式状态卡（含开关按钮）
// banner 非空时置于卡顶作为状态提示（刚切换完显示）
func buildDangerCard(on bool, banner string) string {
	var elements []cuElement

	if banner != "" {
		elements = append(elements, cuMD("**"+banner+"**"))
		elements = append(elements, cuHr())
	}

	if on {
		elements = append(elements,
			cuMD("**当前状态**：⚠️ **Danger 开启**\n跳过所有权限检查，Claude Code 可执行任意工具。"),
			cuHr(),
			cuBtnRow(
				cuCmdBtnRefresh("🔒 关闭 Danger", btnStylePrimary, "danger", "off", "danger"),
				cuCmdBtn("📊 查看状态", btnStyleDefault, "status", ""),
			),
			cuMD("*开启期间任何工具调用都不受白名单限制，请注意安全*"),
		)
	} else {
		elements = append(elements,
			cuMD("**当前状态**：🔒 **Danger 关闭**\nClaude Code 只能调用白名单内的工具。"),
			cuHr(),
			cuBtnRow(
				cuCmdBtnRefresh("⚡ 开启 Danger", btnStyleDanger, "danger", "on", "danger"),
				cuCmdBtn("📊 查看状态", btnStyleDefault, "status", ""),
			),
			cuMD("*关闭状态下 Claude Code 执行未授权工具会被拦截*"),
		)
	}

	return cuBuild("⚡ Danger 模式", "orange", elements)
}

package commands

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// ProjectConfigIface 项目配置接口
type ProjectConfigIface interface {
	GetProjects() map[string]string
}

type ProjectCommand struct {
	config ProjectConfigIface
}

func NewProjectCommand(cfg ProjectConfigIface) *ProjectCommand {
	return &ProjectCommand{config: cfg}
}

func (c *ProjectCommand) Name() string        { return "project" }
func (c *ProjectCommand) Aliases() []string   { return []string{"p"} }
func (c *ProjectCommand) Description() string { return "查看已配置的项目别名" }
func (c *ProjectCommand) Usage() string {
	return `/project - 列出所有配置的项目别名及其目录`
}

// 每行按钮数（避免元素数量超过飞书上限）
const projectBtnCols = 4

func (c *ProjectCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	if c.config == nil {
		return "配置未加载", nil
	}

	projects := c.config.GetProjects()

	if len(projects) == 0 {
		elements := []cuElement{
			cuMD("**(未配置任何项目)**\n\n💡 在 config.yaml 中配置 `projects` 字段即可添加项目别名"),
			cuHr(),
			cuBtnRow(
				cuCmdBtn("♻️ 重载配置", btnStylePrimary, "reload", ""),
				cuCmdBtn("📊 查看状态", btnStyleDefault, "status", ""),
			),
		}
		return CardJSONMarker + cuBuild("📂 项目列表", "blue", elements), nil
	}

	aliases := make([]string, 0, len(projects))
	for alias := range projects {
		aliases = append(aliases, alias)
	}
	sort.Strings(aliases)

	var elements []cuElement

	// 1. 顶部说明（单 markdown）
	elements = append(elements, cuMD(fmt.Sprintf(
		"共 **%d** 个项目别名 · 点击 `@alias` 按钮直接启动会话 · 👁 查看路径",
		len(projects),
	)))
	elements = append(elements, cuHr())

	// 2. 所有项目路径合并为一块 markdown（每行一个）
	var pathLines []string
	for _, alias := range aliases {
		pathLines = append(pathLines, fmt.Sprintf("• **@%s** · `%s`", alias, projects[alias]))
	}
	elements = append(elements, cuMD(strings.Join(pathLines, "\n")))
	elements = append(elements, cuHr())

	// 3. 启动按钮网格（每行 4 个）
	var buttons []cuElement
	for _, alias := range aliases {
		buttons = append(buttons, cuCmdBtn(
			"💬 @"+alias, btnStylePrimary,
			"session", fmt.Sprintf("start --name %s @%s", alias, alias),
		))
	}
	for i := 0; i < len(buttons); i += projectBtnCols {
		end := i + projectBtnCols
		if end > len(buttons) {
			end = len(buttons)
		}
		elements = append(elements, cuBtnRow(buttons[i:end]...))
	}

	// 4. 底部操作（单行）
	elements = append(elements, cuHr())
	elements = append(elements, cuBtnRow(
		cuCmdBtn("📋 会话列表", btnStyleDefault, "session", "list"),
		cuCmdBtn("♻️ 重载", btnStyleDefault, "reload", ""),
		cuCmdBtn("📊 状态", btnStyleDefault, "status", ""),
	))
	elements = append(elements, cuMD("*或使用 `/ask @别名 <提示词>` 快速问答*"))

	return CardJSONMarker + cuBuild("📂 项目列表", "blue", elements), nil
}

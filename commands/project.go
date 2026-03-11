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

func (c *ProjectCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	if c.config == nil {
		return "配置未加载", nil
	}

	projects := c.config.GetProjects()

	if len(projects) == 0 {
		return "📂 项目列表\n\n  (未配置任何项目)\n\n💡 提示: 在 config.yaml 中配置 projects 字段", nil
	}

	var sb strings.Builder
	sb.WriteString("📂 项目列表\n\n")

	// 按别名排序以获得一致的输出
	aliases := make([]string, 0, len(projects))
	for alias := range projects {
		aliases = append(aliases, alias)
	}
	sort.Strings(aliases)

	for _, alias := range aliases {
		path := projects[alias]
		sb.WriteString(fmt.Sprintf("  @%s\n", alias))
		sb.WriteString(fmt.Sprintf("    → %s\n\n", path))
	}

	sb.WriteString(fmt.Sprintf("共 %d 个项目\n", len(projects)))
	sb.WriteString("\n💡 使用方式:\n")
	sb.WriteString("  /ask @项目别名 <提示词>\n")
	sb.WriteString("  /session start @项目别名")

	return sb.String(), nil
}

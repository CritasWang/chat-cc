package commands

import (
	"context"
)

// ReloadFunc 热重载函数签名
type ReloadFunc func() (string, error)

type ReloadCommand struct {
	reloadFn ReloadFunc
}

func NewReloadCommand(fn ReloadFunc) *ReloadCommand {
	return &ReloadCommand{reloadFn: fn}
}

func (c *ReloadCommand) Name() string        { return "reload" }
func (c *ReloadCommand) Aliases() []string   { return nil }
func (c *ReloadCommand) Description() string { return "热重载配置文件" }
func (c *ReloadCommand) Usage() string       { return "/reload" }

func (c *ReloadCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	result, err := c.reloadFn()
	if err != nil {
		elements := []cuElement{
			cuMD("**重载失败**\n\n```\n" + err.Error() + "\n```"),
			cuHr(),
			cuBtnRow(
				cuCmdBtn("🔄 重试", btnStylePrimary, "reload", ""),
				cuCmdBtn("📊 查看状态", btnStyleDefault, "status", ""),
			),
		}
		return CardJSONMarker + cuBuild("❌ 重载失败", "red", elements), nil
	}

	elements := []cuElement{
		cuMD(result),
		cuHr(),
		cuBtnRow(
			cuCmdBtn("🔄 再次重载", btnStylePrimary, "reload", ""),
			cuCmdBtn("📊 查看状态", btnStyleDefault, "status", ""),
			cuCmdBtn("📂 项目", btnStyleDefault, "project", ""),
		),
	}
	return CardJSONMarker + cuBuild("✅ 重载完成", "green", elements), nil
}

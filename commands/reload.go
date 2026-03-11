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
func (c *ReloadCommand) Aliases() []string    { return nil }
func (c *ReloadCommand) Description() string  { return "热重载配置文件" }
func (c *ReloadCommand) Usage() string        { return "/reload" }

func (c *ReloadCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	result, err := c.reloadFn()
	if err != nil {
		return "❌ 重载失败: " + err.Error(), nil
	}
	return result, nil
}

package main

import (
	"fmt"
	"strings"
	"context"

	"chatcc/commands"
)

// Router 命令路由器
type Router struct {
	commands map[string]commands.Command // name/alias → command
	ordered  []commands.Command          // 保持注册顺序（用于 help）
}

func NewRouter() *Router {
	return &Router{
		commands: make(map[string]commands.Command),
	}
}

// Register 注册命令
func (r *Router) Register(cmd commands.Command) {
	r.commands[cmd.Name()] = cmd
	for _, alias := range cmd.Aliases() {
		r.commands[alias] = cmd
	}
	r.ordered = append(r.ordered, cmd)
}

// AllCommands 返回所有命令（按注册顺序）
func (r *Router) AllCommands() []commands.Command {
	return r.ordered
}

// Dispatch 解析消息并分发到对应命令
// 消息格式: /command args 或 直接文本（作为 /ask 的快捷方式）
func (r *Router) Dispatch(ctx context.Context, text string, meta *commands.MessageMeta) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", nil
	}

	// 以 / 开头的消息视为命令
	if strings.HasPrefix(text, "/") {
		cmdLine := text[1:] // 去掉 /
		parts := strings.SplitN(cmdLine, " ", 2)
		cmdName := strings.ToLower(parts[0])
		args := ""
		if len(parts) > 1 {
			args = parts[1]
		}

		cmd, ok := r.commands[cmdName]
		if !ok {
			return fmt.Sprintf("未知命令: /%s\n输入 /help 查看可用命令", cmdName), nil
		}

		return cmd.Execute(ctx, args, meta)
	}

	// 非命令消息：如果有活跃 tmux 会话，发送到会话；否则当作 /ask
	if sendCmd, ok := r.commands["s"]; ok {
		// 尝试发送到活跃会话
		result, err := sendCmd.Execute(ctx, text, meta)
		if err == nil && !strings.Contains(result, "没有活跃的会话") {
			return result, nil
		}
	}

	// 回退到 /ask
	if askCmd, ok := r.commands["ask"]; ok {
		return askCmd.Execute(ctx, text, meta)
	}

	return "请使用 /help 查看可用命令", nil
}

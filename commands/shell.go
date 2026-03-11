package commands

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type ShellCommand struct {
	mu        sync.RWMutex
	whitelist []string
}

func NewShellCommand(whitelist []string) *ShellCommand {
	return &ShellCommand{whitelist: whitelist}
}

// SetWhitelist 热更新白名单
func (c *ShellCommand) SetWhitelist(whitelist []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.whitelist = whitelist
}

func (c *ShellCommand) getWhitelist() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.whitelist
}

func (c *ShellCommand) Name() string        { return "shell" }
func (c *ShellCommand) Aliases() []string    { return []string{"sh"} }
func (c *ShellCommand) Description() string  { return "执行白名单内的 shell 命令" }
func (c *ShellCommand) Usage() string {
	cmds := strings.Join(c.getWhitelist(), "\n  ")
	return fmt.Sprintf("/shell <命令>\n\n允许的命令:\n  %s", cmds)
}

func (c *ShellCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	cmd := strings.TrimSpace(args)
	if cmd == "" {
		return c.Usage(), nil
	}

	// 白名单检查
	if !c.isAllowed(cmd) {
		return fmt.Sprintf("命令不在白名单中: %s\n\n%s", cmd, c.Usage()), nil
	}

	execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	shellCmd := exec.CommandContext(execCtx, "bash", "-c", cmd)
	var stdout, stderr bytes.Buffer
	shellCmd.Stdout = &stdout
	shellCmd.Stderr = &stderr

	err := shellCmd.Run()

	result := stdout.String()
	if stderr.Len() > 0 {
		result += "\n[stderr]\n" + stderr.String()
	}

	if err != nil {
		if execCtx.Err() == context.DeadlineExceeded {
			return "命令执行超时（30秒）", nil
		}
		result += fmt.Sprintf("\n[exit: %s]", err)
	}

	result = strings.TrimSpace(result)
	if result == "" {
		result = "(无输出)"
	}

	return result, nil
}

func (c *ShellCommand) isAllowed(cmd string) bool {
	for _, prefix := range c.getWhitelist() {
		if strings.HasPrefix(cmd, prefix) {
			return true
		}
	}
	return false
}

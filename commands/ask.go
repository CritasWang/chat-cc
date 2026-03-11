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

// AskConfig 传入 Ask 命令所需的配置
type AskConfig struct {
	ClaudeBin      string
	DefaultCWD     string
	AllowedTools   []string
	DangerMode     bool
	ResolveCWD     func(string) string
}

type AskCommand struct {
	config AskConfig
	mu     sync.RWMutex
}

// SetDangerMode 运行时切换 danger 模式
func (c *AskCommand) SetDangerMode(on bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.config.DangerMode = on
}

// IsDangerMode 查询当前 danger 模式状态
func (c *AskCommand) IsDangerMode() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.config.DangerMode
}

// UpdateConfig 热更新配置
func (c *AskCommand) UpdateConfig(claudeBin, defaultCWD string, allowedTools []string, dangerMode bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if claudeBin != "" {
		c.config.ClaudeBin = claudeBin
	}
	if defaultCWD != "" {
		c.config.DefaultCWD = defaultCWD
	}
	c.config.AllowedTools = allowedTools
	c.config.DangerMode = dangerMode
}

func NewAskCommand(cfg AskConfig) *AskCommand {
	return &AskCommand{config: cfg}
}

func (c *AskCommand) Name() string        { return "ask" }
func (c *AskCommand) Aliases() []string    { return nil }
func (c *AskCommand) Description() string  { return "向 Claude Code 提问（无状态模式）" }
func (c *AskCommand) Usage() string {
	return `/ask [--cwd <目录>] <提示词>
/ask @project_alias <提示词>
示例:
  /ask 帮我看看当前目录有什么文件
  /ask --cwd /path/to/project 分析这个项目结构
  /ask @myproject 最近有什么改动`
}

func (c *AskCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	if strings.TrimSpace(args) == "" {
		return c.Usage(), nil
	}

	cwd, prompt := c.parseArgs(args)
	resolvedCWD := c.config.ResolveCWD(cwd)

	// 构建 claude 命令
	cmdArgs := []string{"-p", prompt, "--output-format", "text"}

	// 添加工具权限
	if c.IsDangerMode() {
		cmdArgs = append(cmdArgs, "--dangerously-skip-permissions")
	} else {
		for _, tool := range c.config.AllowedTools {
			cmdArgs = append(cmdArgs, "--allowedTools", tool)
		}
	}

	// 设置超时
	timeout := 5 * time.Minute
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(execCtx, c.config.ClaudeBin, cmdArgs...)
	cmd.Dir = resolvedCWD

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if execCtx.Err() == context.DeadlineExceeded {
			return "⏰ Claude Code 执行超时（5分钟）", nil
		}
		errMsg := stderr.String()
		if errMsg == "" {
			errMsg = err.Error()
		}
		return fmt.Sprintf("执行失败: %s", errMsg), nil
	}

	result := strings.TrimSpace(stdout.String())
	if result == "" {
		result = "(无输出)"
	}

	// 飞书消息有长度限制，截断过长的输出
	if len(result) > 4000 {
		result = result[:4000] + "\n...(输出已截断)"
	}

	return result, nil
}

// parseArgs 解析参数: --cwd <dir> 或 @alias
func (c *AskCommand) parseArgs(args string) (cwd, prompt string) {
	cwd = c.config.DefaultCWD

	// 处理 --cwd 参数
	if strings.HasPrefix(args, "--cwd ") {
		rest := args[6:]
		parts := strings.SplitN(rest, " ", 2)
		if len(parts) == 2 {
			cwd = parts[0]
			prompt = parts[1]
			return
		}
	}

	// 处理 @alias 参数
	if strings.HasPrefix(args, "@") {
		parts := strings.SplitN(args, " ", 2)
		if len(parts) == 2 {
			cwd = parts[0] // 包含 @ 前缀
			prompt = parts[1]
			return
		}
	}

	prompt = args
	return
}

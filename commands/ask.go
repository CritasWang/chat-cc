package commands

import (
	"bytes"
	"context"
	"fmt"
	"os"
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
	TimeoutMinutes int // 超时时间（分钟），默认 50
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
func (c *AskCommand) UpdateConfig(claudeBin, defaultCWD string, allowedTools []string, dangerMode bool, timeoutMinutes int) {
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
	if timeoutMinutes > 0 {
		c.config.TimeoutMinutes = timeoutMinutes
	}
}

func NewAskCommand(cfg AskConfig) *AskCommand {
	// 设置默认超时
	if cfg.TimeoutMinutes <= 0 {
		cfg.TimeoutMinutes = 50
	}
	return &AskCommand{config: cfg}
}

// filterEnvForClaudeCode 过滤环境变量，移除可能导致嵌套会话检测的变量
// 这可以防止 "Claude Code cannot be launched inside another Claude Code session" 错误
func filterEnvForClaudeCode(parentEnv []string) []string {
	filtered := make([]string, 0, len(parentEnv))

	// 需要过滤的环境变量前缀/名称（防止嵌套会话检测）
	blockedPrefixes := []string{
		"CLAUDECODE",           // Claude Code 会话标识
		"ANTHROPIC_",           // Anthropic 相关的会话变量
		"CLAUDE_SESSION",       // Claude 会话相关
		"AGENT_SDK_",          // Agent SDK 相关
	}

	for _, env := range parentEnv {
		blocked := false
		for _, prefix := range blockedPrefixes {
			if strings.HasPrefix(env, prefix) {
				blocked = true
				break
			}
		}
		if !blocked {
			filtered = append(filtered, env)
		}
	}

	return filtered
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
	timeout := time.Duration(c.config.TimeoutMinutes) * time.Minute
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(execCtx, c.config.ClaudeBin, cmdArgs...)
	cmd.Dir = resolvedCWD

	// 过滤环境变量，防止嵌套 Claude Code 会话错误
	// 移除 CLAUDECODE 等可能触发嵌套会话检测的环境变量
	cmd.Env = filterEnvForClaudeCode(os.Environ())

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if execCtx.Err() == context.DeadlineExceeded {
			return fmt.Sprintf("⏰ Claude Code 执行超时（%d分钟）", c.config.TimeoutMinutes), nil
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

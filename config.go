package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	AppID     string `yaml:"app_id"`
	AppSecret string `yaml:"app_secret"`

	// 安全控制
	AllowedUsers []string `yaml:"allowed_users"` // 允许的用户 open_id 列表，空则不限制
	AllowedChats []string `yaml:"allowed_chats"` // 允许的群聊 chat_id 列表，空则不限制

	// Claude Code 配置
	ClaudeBin  string            `yaml:"claude_bin"`  // claude 可执行文件路径，默认 "claude"
	DefaultCWD string            `yaml:"default_cwd"` // 默认工作目录
	Projects   map[string]string `yaml:"projects"`    // 项目别名 → 目录映射

	// Claude Code 权限模式
	ClaudeAllowedTools []string `yaml:"claude_allowed_tools"` // claude -p 时允许的工具
	ClaudeDangerMode   bool     `yaml:"claude_danger_mode"`   // --dangerously-skip-permissions

	// Shell 白名单
	ShellWhitelist []string `yaml:"shell_whitelist"`

	// Hook 服务端口（供 Claude Code hooks 回调）
	HookPort int `yaml:"hook_port"`

	// 默认通知目标（hooks 不指定 chat_id 时使用）
	NotifyChatID string `yaml:"notify_chat_id"`

	// 超时配置（分钟）
	ClaudeAskTimeout     int `yaml:"claude_ask_timeout"`     // /ask 命令超时（默认 50 分钟）
	ClaudeSessionTimeout int `yaml:"claude_session_timeout"` // /session 会话响应超时（默认 50 分钟）

	// 消息分块配置
	MaxChunkSize int `yaml:"max_chunk_size"` // 消息分块大小（默认 3500 字符）

	// 日志级别
	LogLevel string `yaml:"log_level"` // debug, info, warn, error
}

func DefaultConfig() *Config {
	return &Config{
		ClaudeBin:  "claude",
		DefaultCWD: ".",
		Projects:   make(map[string]string),
		ClaudeAllowedTools: []string{
			"Read", "Glob", "Grep", "Bash(git status)", "Bash(git log)",
		},
		ShellWhitelist: []string{
			"docker ps",
			"git status",
			"git log",
			"systemctl status",
			"df -h",
			"free -h",
			"uptime",
		},
		HookPort:             9876,
		LogLevel:             "info",
		ClaudeAskTimeout:     50,   // 默认 50 分钟
		ClaudeSessionTimeout: 50,   // 默认 50 分钟
		MaxChunkSize:         3500, // 默认 3500 字符
	}
}

func LoadConfig(path string) (*Config, error) {
	cfg := DefaultConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil // 使用默认配置
		}
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}

	if cfg.Projects == nil {
		cfg.Projects = make(map[string]string)
	}

	return cfg, nil
}

// ResolveCWD 解析工作目录：支持 @alias 和绝对路径
func (c *Config) ResolveCWD(input string) string {
	if input == "" {
		return c.DefaultCWD
	}
	// @project_alias
	if len(input) > 1 && input[0] == '@' {
		alias := input[1:]
		if dir, ok := c.Projects[alias]; ok {
			return dir
		}
	}
	return input
}

// GetDefaultCWD 获取默认工作目录
func (c *Config) GetDefaultCWD() string {
	return c.DefaultCWD
}

// GetProjects 获取项目别名映射
func (c *Config) GetProjects() map[string]string {
	return c.Projects
}

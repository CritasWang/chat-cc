package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"chatcc/commands"
)

// Session 表示一个 tmux 中运行的 Claude Code 会话
type Session struct {
	Name      string
	CWD       string
	CreatedAt time.Time
	Active    bool
}

// SessionManager 管理多个 tmux Claude Code 会话
type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*Session // key: chatID 或 userID
	config   *Config
}

func NewSessionManager(cfg *Config) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		config:   cfg,
	}
}

// Start 创建一个新的 tmux 会话并启动 Claude Code
func (sm *SessionManager) Start(key, cwd string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if s, ok := sm.sessions[key]; ok && s.Active {
		return fmt.Errorf("会话 %s 已存在，请先 /session stop", s.Name)
	}

	name := fmt.Sprintf("cc-%s", sanitizeName(key))
	resolvedCWD := sm.config.ResolveCWD(cwd)

	// 构建 claude 命令
	claudeCmd := sm.config.ClaudeBin
	if sm.config.ClaudeDangerMode {
		claudeCmd += " --dangerously-skip-permissions"
	}

	// 创建 tmux 会话
	// 注意：通过 tmux 启动时，需要确保环境变量不会导致嵌套会话检测
	cmd := exec.Command("tmux", "new-session", "-d", "-s", name,
		"-c", resolvedCWD,
		fmt.Sprintf("cd %s && %s", shellQuote(resolvedCWD), claudeCmd))

	// 过滤环境变量，防止嵌套 Claude Code 会话错误
	// 移除 CLAUDECODE 等可能触发嵌套会话检测的环境变量
	cmd.Env = commands.FilterEnvForClaudeCode(os.Environ())

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("创建 tmux 会话失败: %w", err)
	}

	// 等待 Claude Code 启动
	time.Sleep(2 * time.Second)

	sm.sessions[key] = &Session{
		Name:      name,
		CWD:       resolvedCWD,
		CreatedAt: time.Now(),
		Active:    true,
	}

	return nil
}

// Send 向 tmux 会话发送消息并等待响应
func (sm *SessionManager) Send(key, message string) (string, error) {
	sm.mu.RLock()
	s, ok := sm.sessions[key]
	sm.mu.RUnlock()

	if !ok || !s.Active {
		return "", fmt.Errorf("没有活跃的会话，请先 /session start [目录]")
	}

	// 记录发送前的 pane 内容行数
	beforeContent, err := sm.capturePane(s.Name)
	if err != nil {
		return "", fmt.Errorf("捕获会话内容失败: %w", err)
	}
	beforeLines := len(strings.Split(beforeContent, "\n"))

	// 发送消息到 tmux
	cmd := exec.Command("tmux", "send-keys", "-t", s.Name, message, "Enter")
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("发送消息失败: %w", err)
	}

	// 轮询等待输出稳定
	response, err := sm.waitForResponse(s.Name, beforeLines)
	if err != nil {
		return "", err
	}

	return response, nil
}

// Stop 关闭 tmux 会话
func (sm *SessionManager) Stop(key string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	s, ok := sm.sessions[key]
	if !ok {
		return fmt.Errorf("没有找到会话")
	}

	// 先发 exit，再 kill
	exec.Command("tmux", "send-keys", "-t", s.Name, "exit", "Enter").Run()
	time.Sleep(500 * time.Millisecond)
	exec.Command("tmux", "kill-session", "-t", s.Name).Run()

	s.Active = false
	delete(sm.sessions, key)

	return nil
}

// GetSession 获取会话信息
func (sm *SessionManager) GetSession(key string) (*Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	s, ok := sm.sessions[key]
	return s, ok
}

// ListSessions 列出所有活跃会话
func (sm *SessionManager) ListSessions() []*Session {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	var result []*Session
	for _, s := range sm.sessions {
		if s.Active {
			result = append(result, s)
		}
	}
	return result
}

// ListAllSessions 列出所有活跃会话（返回副本供命令使用）
func (sm *SessionManager) ListAllSessions() []commands.SessionInfo {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	var result []commands.SessionInfo
	for _, s := range sm.sessions {
		if s.Active {
			result = append(result, commands.SessionInfo{
				Name:      s.Name,
				CWD:       s.CWD,
				CreatedAt: s.CreatedAt,
				Active:    s.Active,
			})
		}
	}
	return result
}

// GetSessionByKey 获取指定 key 的会话信息（供命令使用）
func (sm *SessionManager) GetSessionByKey(key string) (commands.SessionInfo, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	s, ok := sm.sessions[key]
	if !ok || !s.Active {
		return commands.SessionInfo{}, false
	}

	return commands.SessionInfo{
		Name:      s.Name,
		CWD:       s.CWD,
		CreatedAt: s.CreatedAt,
		Active:    s.Active,
	}, true
}

// KillByName 通过会话名称终止会话
func (sm *SessionManager) KillByName(name string) error {
	sm.mu.Lock()

	// 查找对应的会话
	var targetKey string
	var targetName string
	for key, s := range sm.sessions {
		if s.Name == name && s.Active {
			targetKey = key
			targetName = s.Name
			break
		}
	}
	if targetKey == "" {
		sm.mu.Unlock()
		return fmt.Errorf("未找到名为 %s 的活跃会话", name)
	}

	// 持锁期间标记非活跃并从 map 中删除
	sm.sessions[targetKey].Active = false
	delete(sm.sessions, targetKey)
	sm.mu.Unlock()

	// 锁外执行 tmux 清理（避免持锁期间 sleep）
	exec.Command("tmux", "send-keys", "-t", targetName, "exit", "Enter").Run()
	time.Sleep(500 * time.Millisecond)
	exec.Command("tmux", "kill-session", "-t", targetName).Run()

	return nil
}

// capturePane 捕获 tmux pane 内容
func (sm *SessionManager) capturePane(name string) (string, error) {
	cmd := exec.Command("tmux", "capture-pane", "-t", name, "-p", "-S", "-500")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// waitForResponse 轮询 tmux 输出直到稳定
func (sm *SessionManager) waitForResponse(name string, beforeLines int) (string, error) {
	// 先等一小段时间让 Claude 开始处理
	time.Sleep(1 * time.Second)

	var lastContent string
	stableCount := 0

	// 使用配置的超时时间（默认 50 分钟）
	timeoutMinutes := sm.config.ClaudeSessionTimeout
	if timeoutMinutes <= 0 {
		timeoutMinutes = 50
	}
	maxWait := timeoutMinutes * 60 // 转换为秒

	for i := 0; i < maxWait*2; i++ { // 每 500ms 检查一次
		content, err := sm.capturePane(name)
		if err != nil {
			return "", fmt.Errorf("捕获输出失败: %w", err)
		}

		// 检测交互式提示
		if isInteractivePrompt(content) {
			newOutput := extractNewOutput(content, beforeLines)
			// 返回带有交互提示标识的输出
			return newOutput + "\n\n⚠️ 检测到交互式提示，Claude Code 正在等待输入。\n💡 请使用 /s 命令发送您的响应。", nil
		}

		if content == lastContent && content != "" {
			stableCount++
			// 连续 4 次（2秒）没有变化，认为输出完成
			if stableCount >= 4 {
				// 提取新增的输出
				return extractNewOutput(content, beforeLines), nil
			}
		} else {
			stableCount = 0
			lastContent = content
		}

		time.Sleep(500 * time.Millisecond)
	}

	// 超时，返回已有输出
	if lastContent != "" {
		return extractNewOutput(lastContent, beforeLines) + fmt.Sprintf("\n⚠️ [输出可能不完整，已超时 %d 分钟]", timeoutMinutes), nil
	}
	return "", fmt.Errorf("等待响应超时（%d 分钟）", timeoutMinutes)
}

// extractNewOutput 从 pane 内容中提取新增输出
func extractNewOutput(content string, beforeLines int) string {
	lines := strings.Split(content, "\n")
	if beforeLines >= len(lines) {
		return strings.TrimSpace(content)
	}
	newLines := lines[beforeLines:]
	output := strings.Join(newLines, "\n")
	output = stripANSI(output)
	return strings.TrimSpace(output)
}

// stripANSI 移除 ANSI 转义码
func stripANSI(s string) string {
	re := regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[@-~]`)
	return re.ReplaceAllString(s, "")
}

// sanitizeName 清理名称用于 tmux session name
func sanitizeName(s string) string {
	re := regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	result := re.ReplaceAllString(s, "-")
	if len(result) > 20 {
		result = result[:20]
	}
	return result
}

// shellQuote 简单 shell 引号转义
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}


// isInteractivePrompt 检测输出是否包含交互式提示
// 检测常见的交互提示模式，如 y/n 问题、确认提示等
func isInteractivePrompt(content string) bool {
	// 移除 ANSI 转义码
	cleanContent := stripANSI(content)

	// 获取最后几行（交互提示通常在末尾）
	lines := strings.Split(cleanContent, "\n")
	if len(lines) == 0 {
		return false
	}

	// 检查最后 3 行
	checkLines := 3
	if len(lines) < checkLines {
		checkLines = len(lines)
	}

	lastLines := strings.Join(lines[len(lines)-checkLines:], "\n")
	lastLinesLower := strings.ToLower(lastLines)

	// 常见的交互式提示模式（仅保留无歧义的严格模式）
	interactivePatterns := []string{
		"(y/n)",
		"[y/n]",
		"(yes/no)",
		"[yes/no]",
		"continue? [y/n",
		"proceed? [y/n",
		"are you sure?",
		"press enter to continue",
		"y or n",
		"yes or no",
	}

	for _, pattern := range interactivePatterns {
		if strings.Contains(lastLinesLower, pattern) {
			// 额外检查：确保不是在代码块或输出中
			// 如果最后一行很长（>100字符），可能是输出而非提示
			lastLine := strings.TrimSpace(lines[len(lines)-1])
			if len(lastLine) < 100 {
				return true
			}
		}
	}

	return false
}


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
	mu             sync.RWMutex
	sessions       map[string]*Session // key: chatID 或 userID
	config         *Config
	dangerModeFunc func() bool // 运行时获取 danger 模式状态
}

func NewSessionManager(cfg *Config, dangerModeFunc func() bool) *SessionManager {
	return &SessionManager{
		sessions:       make(map[string]*Session),
		config:         cfg,
		dangerModeFunc: dangerModeFunc,
	}
}

// Start 创建一个新的 tmux 会话并启动 Claude Code
func (sm *SessionManager) Start(key, cwd string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if s, ok := sm.sessions[key]; ok && s.Active {
		// 检查 tmux 中会话是否真的还活着
		if sm.tmuxSessionExists(s.Name) {
			return fmt.Errorf("会话 %s 已存在，请先 /session stop", s.Name)
		}
		// 内存中标记活跃但 tmux 已死，清理后继续创建
		delete(sm.sessions, key)
	}

	name := fmt.Sprintf("cc-%s", sanitizeName(key))
	resolvedCWD := sm.config.ResolveCWD(cwd)

	// 验证工作目录是否存在
	if info, err := os.Stat(resolvedCWD); err != nil || !info.IsDir() {
		return fmt.Errorf("工作目录不存在或不是目录: %s", resolvedCWD)
	}

	// 构建 claude 命令
	// 优先使用运行时 danger 模式状态（/danger on|off 切换），回退到配置文件值
	claudeCmd := sm.config.ClaudeBin
	isDanger := sm.config.ClaudeDangerMode
	if sm.dangerModeFunc != nil {
		isDanger = sm.dangerModeFunc()
	}
	if isDanger {
		claudeCmd += " --dangerously-skip-permissions"
	}

	// 如果之前存在同名 tmux 会话（残留），先清理
	exec.Command("tmux", "kill-session", "-t", name).Run()

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

	// 设置 remain-on-exit，当 claude 进程退出时保留窗口以便诊断
	exec.Command("tmux", "set-option", "-t", name, "remain-on-exit", "on").Run()

	// 等待 Claude Code 启动
	time.Sleep(3 * time.Second)

	// 验证 tmux 会话是否仍然存活
	if !sm.tmuxSessionExists(name) {
		return fmt.Errorf("tmux 会话创建后立即退出，claude 可能启动失败。\n请检查:\n  1. claude 命令是否可用: %s\n  2. 工作目录是否正确: %s", claudeCmd, resolvedCWD)
	}

	// 检查 pane 是否仍在运行（remain-on-exit 会让 session 存在但 pane 可能已 dead）
	paneStatus := sm.getPaneStatus(name)
	if paneStatus == "dead" {
		// 捕获错误输出用于诊断
		errOutput, _ := sm.capturePane(name)
		// 清理死亡会话
		exec.Command("tmux", "kill-session", "-t", name).Run()
		diagnostic := ""
		if errOutput != "" {
			// 取最后几行作为诊断信息
			lines := strings.Split(strings.TrimSpace(errOutput), "\n")
			start := 0
			if len(lines) > 10 {
				start = len(lines) - 10
			}
			diagnostic = "\n诊断输出:\n" + strings.Join(lines[start:], "\n")
		}
		return fmt.Errorf("claude 进程已退出，会话启动失败。%s\n请检查:\n  1. claude 命令: %s\n  2. 工作目录: %s", diagnostic, claudeCmd, resolvedCWD)
	}

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

	// 检查 tmux 会话是否真的还存在
	if !sm.tmuxSessionExists(s.Name) {
		// 会话已死，清理内存状态
		sm.mu.Lock()
		s.Active = false
		delete(sm.sessions, key)
		sm.mu.Unlock()
		return "", fmt.Errorf("tmux 会话已断开（可能 claude 进程已退出）。\n请使用 /session start [目录] 重新启动")
	}

	// 检查 pane 是否仍在运行
	if sm.getPaneStatus(s.Name) == "dead" {
		// 捕获最后输出用于诊断
		lastOutput, _ := sm.capturePane(s.Name)
		// 清理
		sm.mu.Lock()
		s.Active = false
		delete(sm.sessions, key)
		sm.mu.Unlock()
		exec.Command("tmux", "kill-session", "-t", s.Name).Run()

		diagnostic := ""
		if lastOutput != "" {
			lines := strings.Split(strings.TrimSpace(lastOutput), "\n")
			start := 0
			if len(lines) > 5 {
				start = len(lines) - 5
			}
			diagnostic = "\n最后输出:\n" + strings.Join(lines[start:], "\n")
		}
		return "", fmt.Errorf("claude 进程已退出，会话已断开。%s\n请使用 /session start [目录] 重新启动", diagnostic)
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

// ListSessions 列出所有活跃会话（同步 tmux 真实状态）
func (sm *SessionManager) ListSessions() []*Session {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	var result []*Session
	var deadKeys []string

	for key, s := range sm.sessions {
		if !s.Active {
			continue
		}
		if !sm.tmuxSessionExists(s.Name) || sm.getPaneStatus(s.Name) == "dead" {
			deadKeys = append(deadKeys, key)
			if sm.tmuxSessionExists(s.Name) {
				exec.Command("tmux", "kill-session", "-t", s.Name).Run()
			}
			continue
		}
		result = append(result, s)
	}

	for _, key := range deadKeys {
		sm.sessions[key].Active = false
		delete(sm.sessions, key)
	}

	return result
}

// ListAllSessions 列出所有活跃会话（返回副本供命令使用）
// 同时与真实 tmux 状态同步，清理已死亡的会话
func (sm *SessionManager) ListAllSessions() []commands.SessionInfo {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	var result []commands.SessionInfo
	var deadKeys []string

	for key, s := range sm.sessions {
		if !s.Active {
			continue
		}
		// 检查 tmux 会话是否真的还在
		if !sm.tmuxSessionExists(s.Name) {
			deadKeys = append(deadKeys, key)
			continue
		}
		// 检查 pane 是否还活着
		paneStatus := sm.getPaneStatus(s.Name)
		if paneStatus == "dead" {
			deadKeys = append(deadKeys, key)
			// 清理已死的 tmux 会话
			exec.Command("tmux", "kill-session", "-t", s.Name).Run()
			continue
		}
		result = append(result, commands.SessionInfo{
			Name:      s.Name,
			CWD:       s.CWD,
			CreatedAt: s.CreatedAt,
			Active:    s.Active,
		})
	}

	// 清理已死亡的会话
	for _, key := range deadKeys {
		sm.sessions[key].Active = false
		delete(sm.sessions, key)
	}

	return result
}

// GetSessionByKey 获取指定 key 的会话信息（供命令使用）
// 同时验证 tmux 会话是否真实存在
func (sm *SessionManager) GetSessionByKey(key string) (commands.SessionInfo, bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	s, ok := sm.sessions[key]
	if !ok || !s.Active {
		return commands.SessionInfo{}, false
	}

	// 验证 tmux 会话是否真的还在
	if !sm.tmuxSessionExists(s.Name) || sm.getPaneStatus(s.Name) == "dead" {
		s.Active = false
		delete(sm.sessions, key)
		if sm.tmuxSessionExists(s.Name) {
			exec.Command("tmux", "kill-session", "-t", s.Name).Run()
		}
		return commands.SessionInfo{}, false
	}

	return commands.SessionInfo{
		Name:      s.Name,
		CWD:       s.CWD,
		CreatedAt: s.CreatedAt,
		Active:    s.Active,
	}, true
}

// SendKeys 向 tmux 会话发送原始按键（不自动追加 Enter）
func (sm *SessionManager) SendKeys(key string, tmuxKeys ...string) error {
	sm.mu.RLock()
	s, ok := sm.sessions[key]
	sm.mu.RUnlock()

	if !ok || !s.Active {
		return fmt.Errorf("没有活跃的会话，请先 /session start [目录]")
	}

	args := append([]string{"send-keys", "-t", s.Name}, tmuxKeys...)
	cmd := exec.Command("tmux", args...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("发送按键失败: %w", err)
	}
	return nil
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

// tmuxSessionExists 检查 tmux 会话是否真实存在
func (sm *SessionManager) tmuxSessionExists(name string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", name)
	return cmd.Run() == nil
}

// getPaneStatus 获取 tmux pane 的运行状态（如 "running" 或 "dead"）
func (sm *SessionManager) getPaneStatus(name string) string {
	cmd := exec.Command("tmux", "display-message", "-t", name, "-p", "#{pane_dead}")
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	if strings.TrimSpace(string(out)) == "1" {
		return "dead"
	}
	return "running"
}

// capturePane 捕获 tmux pane 内容
func (sm *SessionManager) capturePane(name string) (string, error) {
	cmd := exec.Command("tmux", "capture-pane", "-t", name, "-p", "-S", "-500")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("tmux capture-pane 失败 (会话: %s): %w", name, err)
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


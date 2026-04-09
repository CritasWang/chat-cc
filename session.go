package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"chatcc/commands"
)

// SessionInteractionListener 会话交互监听器
// 用于通知 SessionMonitor 会话刚被用户驱动过，避免重复通知
type SessionInteractionListener interface {
	OnSessionInteracted(tmuxName string)
}

// Session 表示一个 tmux 中运行的 Claude Code 会话
type Session struct {
	Name      string // tmux session name (e.g. "cc-abc123-1")
	Label     string // 用户可见标签 (e.g. "default", "feature-x")
	CWD       string
	CreatedAt time.Time
	Active    bool
	UserKey   string // 归属的 user/chat key
	ChatID    string // 创建时的飞书 chat_id，用于主动通知路由
	ChatType  string // "p2p" 或 "group"
}

// SessionManager 管理多个 tmux Claude Code 会话
// 支持每个 user/chat 拥有多个会话，并可在它们之间切换
type SessionManager struct {
	mu             sync.RWMutex
	sessions       map[string]*Session // tmuxName → Session
	activeSession  map[string]string   // userKey → active tmuxName
	userSessions   map[string][]string // userKey → ordered list of tmuxNames
	config         *Config
	dangerModeFunc func() bool // 运行时获取 danger 模式状态
	counter        int64       // 用于生成唯一会话名
	listener       SessionInteractionListener
}

func NewSessionManager(cfg *Config, dangerModeFunc func() bool) *SessionManager {
	return &SessionManager{
		sessions:       make(map[string]*Session),
		activeSession:  make(map[string]string),
		userSessions:   make(map[string][]string),
		config:         cfg,
		dangerModeFunc: dangerModeFunc,
	}
}

// SetInteractionListener 注册交互监听器（SessionMonitor 用）
func (sm *SessionManager) SetInteractionListener(l SessionInteractionListener) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.listener = l
}

// notifyInteracted 在锁外通知 listener（调用方必须不持锁）
func (sm *SessionManager) notifyInteracted(tmuxName string) {
	sm.mu.RLock()
	l := sm.listener
	sm.mu.RUnlock()
	if l != nil && tmuxName != "" {
		l.OnSessionInteracted(tmuxName)
	}
}

// Start 创建一个新的 tmux 会话并启动 Claude Code
// label 为空则自动生成 (default, session-2, session-3...)
func (sm *SessionManager) Start(key, cwd, chatID, chatType string) error {
	return sm.StartNamed(key, "", cwd, chatID, chatType)
}

// StartNamed 创建一个带标签的 tmux 会话
func (sm *SessionManager) StartNamed(key, label, cwd, chatID, chatType string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// 自动生成标签
	if label == "" {
		existing := sm.userSessions[key]
		if len(existing) == 0 {
			label = "default"
		} else {
			label = fmt.Sprintf("session-%d", len(existing)+1)
		}
	}

	// 检查同 key 下是否已有同名标签
	for _, tmuxName := range sm.userSessions[key] {
		if s, ok := sm.sessions[tmuxName]; ok && s.Label == label && s.Active {
			return fmt.Errorf("已存在名为 %q 的活跃会话，请用其他名称或先 /session stop %s", label, label)
		}
	}

	// 生成唯一 tmux session name
	seq := atomic.AddInt64(&sm.counter, 1)
	name := fmt.Sprintf("cc-%s-%d", sanitizeName(key), seq)
	resolvedCWD := sm.config.ResolveCWD(cwd)

	// 验证工作目录是否存在
	if info, err := os.Stat(resolvedCWD); err != nil || !info.IsDir() {
		return fmt.Errorf("工作目录不存在或不是目录: %s", resolvedCWD)
	}

	// 构建 claude 命令
	claudeCmd := sm.config.ClaudeBin
	isDanger := sm.config.ClaudeDangerMode
	if sm.dangerModeFunc != nil {
		isDanger = sm.dangerModeFunc()
	}
	if isDanger {
		claudeCmd += " --dangerously-skip-permissions"
	}

	// 清理可能的残留同名 tmux 会话
	exec.Command("tmux", "kill-session", "-t", name).Run()

	// 创建 tmux 会话
	cmd := exec.Command("tmux", "new-session", "-d", "-s", name,
		"-c", resolvedCWD,
		fmt.Sprintf("cd %s && %s", shellQuote(resolvedCWD), claudeCmd))

	cmd.Env = commands.FilterEnvForClaudeCode(os.Environ())

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("创建 tmux 会话失败: %w", err)
	}

	// 设置 remain-on-exit
	exec.Command("tmux", "set-option", "-t", name, "remain-on-exit", "on").Run()

	// 等待 Claude Code 启动
	time.Sleep(3 * time.Second)

	// 验证 tmux 会话是否存活
	if !sm.tmuxSessionExists(name) {
		return fmt.Errorf("tmux 会话创建后立即退出，claude 可能启动失败。\n请检查:\n  1. claude 命令是否可用: %s\n  2. 工作目录是否正确: %s", claudeCmd, resolvedCWD)
	}

	// 检查 pane 是否仍在运行
	paneStatus := sm.getPaneStatus(name)
	if paneStatus == "dead" {
		errOutput, _ := sm.capturePane(name)
		exec.Command("tmux", "kill-session", "-t", name).Run()
		diagnostic := ""
		if errOutput != "" {
			lines := strings.Split(strings.TrimSpace(errOutput), "\n")
			start := 0
			if len(lines) > 10 {
				start = len(lines) - 10
			}
			diagnostic = "\n诊断输出:\n" + strings.Join(lines[start:], "\n")
		}
		return fmt.Errorf("claude 进程已退出，会话启动失败。%s\n请检查:\n  1. claude 命令: %s\n  2. 工作目录: %s", diagnostic, claudeCmd, resolvedCWD)
	}

	session := &Session{
		Name:      name,
		Label:     label,
		CWD:       resolvedCWD,
		CreatedAt: time.Now(),
		Active:    true,
		UserKey:   key,
		ChatID:    chatID,
		ChatType:  chatType,
	}

	sm.sessions[name] = session
	sm.userSessions[key] = append(sm.userSessions[key], name)
	sm.activeSession[key] = name // 新建的会话自动成为活跃会话

	return nil
}

// Switch 切换活跃会话（按标签或索引）
func (sm *SessionManager) Switch(key, target string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	tmuxNames := sm.userSessions[key]
	if len(tmuxNames) == 0 {
		return fmt.Errorf("没有任何会话，请先 /session start")
	}

	// 尝试按标签匹配
	for _, tmuxName := range tmuxNames {
		s, ok := sm.sessions[tmuxName]
		if !ok || !s.Active {
			continue
		}
		if s.Label == target || s.Name == target {
			sm.activeSession[key] = tmuxName
			return nil
		}
	}

	// 尝试按序号匹配 (1-based)
	var idx int
	if _, err := fmt.Sscanf(target, "%d", &idx); err == nil {
		// 构建活跃会话列表
		var activeSessions []string
		for _, tmuxName := range tmuxNames {
			if s, ok := sm.sessions[tmuxName]; ok && s.Active {
				activeSessions = append(activeSessions, tmuxName)
			}
		}
		if idx >= 1 && idx <= len(activeSessions) {
			sm.activeSession[key] = activeSessions[idx-1]
			return nil
		}
	}

	return fmt.Errorf("未找到会话: %s\n请使用 /session list 查看可用会话", target)
}

// Send 向活跃 tmux 会话发送消息并等待响应
func (sm *SessionManager) Send(key, message string) (string, error) {
	return sm.SendWithStream(key, message, nil)
}

// SendWithStream 向活跃会话发送消息，并通过 streamFn 回调推送中间输出
func (sm *SessionManager) SendWithStream(key, message string, streamFn func(text string)) (string, error) {
	sm.mu.RLock()
	tmuxName := sm.activeSession[key]
	s, ok := sm.sessions[tmuxName]
	sm.mu.RUnlock()

	if !ok || !s.Active {
		return "", fmt.Errorf("没有活跃的会话，请先 /session start [目录]")
	}

	// 检查 tmux 会话是否真的还存在
	if !sm.tmuxSessionExists(s.Name) {
		sm.cleanupDeadSession(key, s.Name)
		return "", fmt.Errorf("tmux 会话已断开（可能 claude 进程已退出）。\n请使用 /session start [目录] 重新启动")
	}

	// 检查 pane 是否仍在运行
	if sm.getPaneStatus(s.Name) == "dead" {
		lastOutput, _ := sm.capturePane(s.Name)
		sm.cleanupDeadSession(key, s.Name)
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

	// 通知监听器：用户主动驱动了此会话，重置监控状态
	sm.notifyInteracted(s.Name)

	// 轮询等待输出稳定（带流式回调）
	response, err := sm.waitForResponse(s.Name, beforeLines, streamFn)
	if err != nil {
		return "", err
	}

	// 再次通知：本轮交互结束
	sm.notifyInteracted(s.Name)

	return response, nil
}

// Stop 关闭活跃会话或按标签关闭
func (sm *SessionManager) Stop(key string) error {
	return sm.StopByLabel(key, "")
}

// StopByLabel 关闭指定标签的会话，label 为空则关闭活跃会话
func (sm *SessionManager) StopByLabel(key, label string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	var targetName string
	if label == "" {
		// 关闭活跃会话
		targetName = sm.activeSession[key]
	} else {
		// 按标签查找
		for _, tmuxName := range sm.userSessions[key] {
			if s, ok := sm.sessions[tmuxName]; ok && s.Active && s.Label == label {
				targetName = tmuxName
				break
			}
		}
	}

	if targetName == "" {
		return fmt.Errorf("没有找到要关闭的会话")
	}

	s, ok := sm.sessions[targetName]
	if !ok {
		return fmt.Errorf("没有找到会话")
	}

	// 先发 exit，再 kill
	exec.Command("tmux", "send-keys", "-t", s.Name, "exit", "Enter").Run()
	time.Sleep(500 * time.Millisecond)
	exec.Command("tmux", "kill-session", "-t", s.Name).Run()

	s.Active = false
	sm.removeSessionFromUser(key, targetName)

	// 如果关闭的是活跃会话，切换到下一个
	if sm.activeSession[key] == targetName {
		sm.autoSwitchActive(key)
	}

	return nil
}

// GetSession 获取活跃会话信息
func (sm *SessionManager) GetSession(key string) (*Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	tmuxName := sm.activeSession[key]
	s, ok := sm.sessions[tmuxName]
	return s, ok
}

// GetSessionByKey 获取活跃会话信息（返回 SessionInfo）
func (sm *SessionManager) GetSessionByKey(key string) (commands.SessionInfo, bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	tmuxName := sm.activeSession[key]
	s, ok := sm.sessions[tmuxName]
	if !ok || !s.Active {
		return commands.SessionInfo{}, false
	}

	// 验证 tmux 会话是否真的还在
	if !sm.tmuxSessionExists(s.Name) || sm.getPaneStatus(s.Name) == "dead" {
		s.Active = false
		sm.removeSessionFromUser(key, tmuxName)
		if sm.tmuxSessionExists(s.Name) {
			exec.Command("tmux", "kill-session", "-t", s.Name).Run()
		}
		sm.autoSwitchActive(key)
		return commands.SessionInfo{}, false
	}

	return commands.SessionInfo{
		Name:      s.Name,
		Label:     s.Label,
		CWD:       s.CWD,
		CreatedAt: s.CreatedAt,
		Active:    s.Active,
		IsActive:  true, // 这是当前活跃会话
	}, true
}

// ListSessions 列出指定 key 的所有活跃会话（同步 tmux 真实状态）
func (sm *SessionManager) ListSessions() []*Session {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	var result []*Session
	var deadNames []string

	for tmuxName, s := range sm.sessions {
		if !s.Active {
			continue
		}
		if !sm.tmuxSessionExists(s.Name) || sm.getPaneStatus(s.Name) == "dead" {
			deadNames = append(deadNames, tmuxName)
			if sm.tmuxSessionExists(s.Name) {
				exec.Command("tmux", "kill-session", "-t", s.Name).Run()
			}
			continue
		}
		result = append(result, s)
	}

	for _, name := range deadNames {
		if s, ok := sm.sessions[name]; ok {
			s.Active = false
			sm.removeSessionFromUser(s.UserKey, name)
			sm.autoSwitchActive(s.UserKey)
		}
	}

	return result
}

// ListAllSessions 列出所有活跃会话（返回副本供命令使用）
func (sm *SessionManager) ListAllSessions() []commands.SessionInfo {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	var result []commands.SessionInfo
	var deadNames []string

	for tmuxName, s := range sm.sessions {
		if !s.Active {
			continue
		}
		if !sm.tmuxSessionExists(s.Name) {
			deadNames = append(deadNames, tmuxName)
			continue
		}
		if sm.getPaneStatus(s.Name) == "dead" {
			deadNames = append(deadNames, tmuxName)
			exec.Command("tmux", "kill-session", "-t", s.Name).Run()
			continue
		}
		isActive := sm.activeSession[s.UserKey] == tmuxName
		result = append(result, commands.SessionInfo{
			Name:      s.Name,
			Label:     s.Label,
			CWD:       s.CWD,
			CreatedAt: s.CreatedAt,
			Active:    s.Active,
			IsActive:  isActive,
		})
	}

	for _, name := range deadNames {
		if s, ok := sm.sessions[name]; ok {
			s.Active = false
			sm.removeSessionFromUser(s.UserKey, name)
			sm.autoSwitchActive(s.UserKey)
		}
	}

	return result
}

// ListUserSessions 列出指定 key 的会话（供命令使用）
func (sm *SessionManager) ListUserSessions(key string) []commands.SessionInfo {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	var result []commands.SessionInfo
	var deadNames []string

	for _, tmuxName := range sm.userSessions[key] {
		s, ok := sm.sessions[tmuxName]
		if !ok || !s.Active {
			continue
		}
		if !sm.tmuxSessionExists(s.Name) || sm.getPaneStatus(s.Name) == "dead" {
			deadNames = append(deadNames, tmuxName)
			if sm.tmuxSessionExists(s.Name) {
				exec.Command("tmux", "kill-session", "-t", s.Name).Run()
			}
			continue
		}
		isActive := sm.activeSession[key] == tmuxName
		result = append(result, commands.SessionInfo{
			Name:      s.Name,
			Label:     s.Label,
			CWD:       s.CWD,
			CreatedAt: s.CreatedAt,
			Active:    s.Active,
			IsActive:  isActive,
		})
	}

	for _, name := range deadNames {
		if s, ok := sm.sessions[name]; ok {
			s.Active = false
			sm.removeSessionFromUser(key, name)
		}
	}
	if len(deadNames) > 0 {
		sm.autoSwitchActive(key)
	}

	return result
}

// SendKeys 向活跃 tmux 会话发送原始按键
func (sm *SessionManager) SendKeys(key string, tmuxKeys ...string) error {
	sm.mu.RLock()
	tmuxName := sm.activeSession[key]
	s, ok := sm.sessions[tmuxName]
	sm.mu.RUnlock()

	if !ok || !s.Active {
		return fmt.Errorf("没有活跃的会话，请先 /session start [目录]")
	}

	args := append([]string{"send-keys", "-t", s.Name}, tmuxKeys...)
	cmd := exec.Command("tmux", args...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("发送按键失败: %w", err)
	}

	// 通知监听器：用户主动驱动了此会话，重置监控状态
	sm.notifyInteracted(s.Name)
	return nil
}

// KillByName 通过会话名称终止会话
func (sm *SessionManager) KillByName(name string) error {
	sm.mu.Lock()

	var targetKey string
	var targetName string
	for tmuxName, s := range sm.sessions {
		if (s.Name == name || s.Label == name) && s.Active {
			targetKey = s.UserKey
			targetName = tmuxName
			break
		}
	}
	if targetKey == "" {
		sm.mu.Unlock()
		return fmt.Errorf("未找到名为 %s 的活跃会话", name)
	}

	s := sm.sessions[targetName]
	s.Active = false
	sm.removeSessionFromUser(targetKey, targetName)
	if sm.activeSession[targetKey] == targetName {
		sm.autoSwitchActive(targetKey)
	}
	sessionName := s.Name
	sm.mu.Unlock()

	// 锁外执行 tmux 清理
	exec.Command("tmux", "send-keys", "-t", sessionName, "exit", "Enter").Run()
	time.Sleep(500 * time.Millisecond)
	exec.Command("tmux", "kill-session", "-t", sessionName).Run()

	return nil
}

// --- 内部辅助方法 ---

// cleanupDeadSession 清理死亡会话（调用方需确保不持有写锁）
func (sm *SessionManager) cleanupDeadSession(key, tmuxName string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if s, ok := sm.sessions[tmuxName]; ok {
		s.Active = false
	}
	sm.removeSessionFromUser(key, tmuxName)
	if sm.activeSession[key] == tmuxName {
		sm.autoSwitchActive(key)
	}
}

// removeSessionFromUser 从 userSessions 列表中移除（调用方需持有锁）
func (sm *SessionManager) removeSessionFromUser(key, tmuxName string) {
	sessions := sm.userSessions[key]
	for i, name := range sessions {
		if name == tmuxName {
			sm.userSessions[key] = append(sessions[:i], sessions[i+1:]...)
			break
		}
	}
	delete(sm.sessions, tmuxName)
}

// autoSwitchActive 自动切换到下一个可用会话（调用方需持有锁）
func (sm *SessionManager) autoSwitchActive(key string) {
	delete(sm.activeSession, key)
	for _, tmuxName := range sm.userSessions[key] {
		if s, ok := sm.sessions[tmuxName]; ok && s.Active {
			sm.activeSession[key] = tmuxName
			return
		}
	}
}

// tmuxSessionExists 检查 tmux 会话是否真实存在
func (sm *SessionManager) tmuxSessionExists(name string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", name)
	return cmd.Run() == nil
}

// getPaneStatus 获取 tmux pane 的运行状态
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

// CapturePane 捕获 tmux pane 内容（公开方法，供 OutputStreamer 使用）
func (sm *SessionManager) CapturePane(name string) (string, error) {
	return sm.capturePane(name)
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

// GetActiveSessionName 获取活跃会话的 tmux 名称（供外部组件使用）
func (sm *SessionManager) GetActiveSessionName(key string) string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.activeSession[key]
}

// HasActiveSession 判断 userKey 是否存在活跃会话
func (sm *SessionManager) HasActiveSession(key string) bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	tmuxName := sm.activeSession[key]
	s, ok := sm.sessions[tmuxName]
	return ok && s.Active
}

// SnapshotActive 返回当前所有活跃会话的拷贝，供 SessionMonitor 在锁外使用
// 返回的切片中每个 *Session 都是一个独立副本，外部可以安全读取字段
func (sm *SessionManager) SnapshotActive() []*Session {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	result := make([]*Session, 0, len(sm.sessions))
	for _, s := range sm.sessions {
		if !s.Active {
			continue
		}
		// 浅拷贝：Session 字段都是值类型
		cp := *s
		result = append(result, &cp)
	}
	return result
}

// waitForResponse 轮询 tmux 输出直到稳定，支持流式回调
func (sm *SessionManager) waitForResponse(name string, beforeLines int, streamFn func(string)) (string, error) {
	// 先等一小段时间让 Claude 开始处理
	time.Sleep(1 * time.Second)

	var lastContent string
	var lastStreamedContent string
	stableCount := 0
	lastStreamTime := time.Now()

	// 流式推送配置
	streamInterval := time.Duration(sm.config.StreamInterval) * time.Second
	streamMinDelta := sm.config.StreamMinDelta
	streamEnabled := sm.config.StreamEnabled && streamFn != nil

	// 使用配置的超时时间
	timeoutMinutes := sm.config.ClaudeSessionTimeout
	if timeoutMinutes <= 0 {
		timeoutMinutes = 50
	}
	maxWait := timeoutMinutes * 60

	for i := 0; i < maxWait*2; i++ { // 每 500ms 检查一次
		content, err := sm.capturePane(name)
		if err != nil {
			return "", fmt.Errorf("捕获输出失败: %w", err)
		}

		// 检测交互式提示
		if isInteractivePrompt(content) {
			newOutput := extractNewOutput(content, beforeLines)
			return newOutput + "\n\n⚠️ 检测到交互式提示，Claude Code 正在等待输入。\n💡 请使用 /s 命令发送您的响应。", nil
		}

		if content == lastContent && content != "" {
			stableCount++
			if stableCount >= 4 {
				return extractNewOutput(content, beforeLines), nil
			}
		} else {
			stableCount = 0
			lastContent = content
		}

		// 流式推送中间输出
		if streamEnabled && time.Since(lastStreamTime) >= streamInterval {
			newOutput := extractNewOutput(content, beforeLines)
			newOutput = strings.TrimSpace(newOutput)
			if newOutput != "" && newOutput != lastStreamedContent {
				delta := len([]rune(newOutput)) - len([]rune(lastStreamedContent))
				if delta >= streamMinDelta {
					streamFn(newOutput)
					lastStreamedContent = newOutput
					lastStreamTime = time.Now()
				}
			}
		}

		time.Sleep(500 * time.Millisecond)
	}

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

// 包级编译的正则（避免每次调用重复编译）
var (
	ansiEscapeRe = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[@-~]`)
	nameCleanRe  = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
)

// stripANSI 移除 ANSI 转义码
func stripANSI(s string) string {
	return ansiEscapeRe.ReplaceAllString(s, "")
}

// sanitizeName 清理名称用于 tmux session name
func sanitizeName(s string) string {
	result := nameCleanRe.ReplaceAllString(s, "-")
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
func isInteractivePrompt(content string) bool {
	cleanContent := stripANSI(content)

	lines := strings.Split(cleanContent, "\n")
	if len(lines) == 0 {
		return false
	}

	checkLines := 3
	if len(lines) < checkLines {
		checkLines = len(lines)
	}

	lastLines := strings.Join(lines[len(lines)-checkLines:], "\n")
	lastLinesLower := strings.ToLower(lastLines)

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
			lastLine := strings.TrimSpace(lines[len(lines)-1])
			if len(lastLine) < 100 {
				return true
			}
		}
	}

	return false
}

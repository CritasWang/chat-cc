package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"strings"
	"sync"
	"time"

	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

// SessionState 每个会话的监控状态（用于去重）
type SessionState struct {
	LastContent      string    // 上一次捕获的 pane 内容
	StableSince      time.Time // 内容开始稳定的时刻
	StartTime        time.Time // 会话创建时间（用于计算耗时）
	NotifiedComplete bool      // 是否已经为本次稳定状态推送过"完成"通知
	NotifiedPrompt   string    // 上一次推送的"等待输入"提示 hash（空 = 未推送）
	CWD              string
	Label            string
}

// SessionMonitor 后台监控所有活跃 tmux 会话
// 检测：1) 会话任务完成 → 发送完成卡片  2) 会话等待交互输入 → 发送等待卡片
// 实现 SessionInteractionListener 接口，让 SessionManager 通知用户交互事件
type SessionMonitor struct {
	mu              sync.Mutex
	interval        time.Duration
	stableThreshold time.Duration
	enabled         bool
	skipPrompt      bool // LiveStreamer 启用时跳过 prompt 通知（避免重复）
	sm              *SessionManager
	replier         *Replier
	cancel          context.CancelFunc
	state           map[string]*SessionState // tmuxName → state
}

// NewSessionMonitor 构造监控器（尚未启动）
func NewSessionMonitor(sm *SessionManager, replier *Replier) *SessionMonitor {
	return &SessionMonitor{
		sm:              sm,
		replier:         replier,
		state:           make(map[string]*SessionState),
		interval:        5 * time.Second,
		stableThreshold: 8 * time.Second,
	}
}

// SetSkipPrompt 当 LiveStreamer 启用时调用，跳过 prompt 通知（实况卡片已包含提示）
func (m *SessionMonitor) SetSkipPrompt(skip bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.skipPrompt = skip
}

// Configure 启动 / 停止 / 热更新监控器
// enabled=false 时会停止正在运行的监控
func (m *SessionMonitor) Configure(enabled bool, intervalSec, stableSec int) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if intervalSec <= 0 {
		intervalSec = 5
	}
	if stableSec <= 0 {
		stableSec = 8
	}
	newInterval := time.Duration(intervalSec) * time.Second
	newStable := time.Duration(stableSec) * time.Second

	// 无变化则跳过
	if m.enabled == enabled && m.interval == newInterval && m.stableThreshold == newStable {
		return
	}

	// 停止已有
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}

	m.enabled = enabled
	m.interval = newInterval
	m.stableThreshold = newStable

	if enabled {
		ctx, cancel := context.WithCancel(context.Background())
		m.cancel = cancel
		go m.run(ctx, newInterval)
		log.Printf("会话监视器已启动: 每 %d 秒轮询，稳定阈值 %d 秒", intervalSec, stableSec)
	} else {
		log.Println("会话监视器已禁用")
	}
}

// Stop 停止监控循环
func (m *SessionMonitor) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
}

// OnSessionInteracted 实现 SessionInteractionListener 接口
// 用户主动驱动了会话（/s 或 /key），重置该会话的通知状态
func (m *SessionMonitor) OnSessionInteracted(tmuxName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if st, ok := m.state[tmuxName]; ok {
		st.NotifiedComplete = false
		st.NotifiedPrompt = ""
		st.StableSince = time.Time{}
	}
}

// run 监控主循环
func (m *SessionMonitor) run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.scanOnce()
		}
	}
}

// scanOnce 扫一遍所有活跃会话
func (m *SessionMonitor) scanOnce() {
	sessions := m.sm.SnapshotActive()

	now := time.Now()
	// 构建本轮活跃名称集合，用于清理已消失的会话状态
	activeNames := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		activeNames[s.Name] = true
	}

	// 清理死会话的 state（持锁）
	m.mu.Lock()
	for name := range m.state {
		if !activeNames[name] {
			delete(m.state, name)
		}
	}
	m.mu.Unlock()

	// 逐个处理（捕获 pane 不持锁，避免阻塞其他操作）
	for _, s := range sessions {
		content, err := m.sm.CapturePane(s.Name)
		if err != nil {
			log.Printf("monitor 捕获 pane 失败: session=%s err=%v", s.Name, err)
			continue
		}
		m.handleSession(s, content, now)
	}
}

// handleSession 处理单个会话的分类与通知
func (m *SessionMonitor) handleSession(s *Session, content string, now time.Time) {
	m.mu.Lock()
	st, exists := m.state[s.Name]
	if !exists {
		// 新发现的会话，初始化状态。首次扫描不发通知，视为已完成（避免启动时误报）
		st = &SessionState{
			LastContent:      content,
			StableSince:      now,
			StartTime:        s.CreatedAt,
			NotifiedComplete: true, // 首次扫描视为已处理
			CWD:              s.CWD,
			Label:            s.Label,
		}
		m.state[s.Name] = st
		m.mu.Unlock()
		return
	}

	// 更新标签/CWD（可能被覆盖）
	st.Label = s.Label
	st.CWD = s.CWD

	cleaned := stripANSI(content)
	isPrompt := isInteractivePrompt(content)

	// 内容变化检测
	if content != st.LastContent {
		st.LastContent = content
		st.StableSince = now
		st.NotifiedComplete = false
		// 内容变了，允许下次再推送 prompt
		if !isPrompt {
			st.NotifiedPrompt = ""
		}
	}

	// 决策分支
	var (
		shouldNotifyComplete bool
		shouldNotifyPrompt   bool
		promptHash           string
		promptType           string
	)

	if isPrompt && !m.skipPrompt {
		// skipPrompt=true 时 LiveStreamer 已在实况卡片内显示操作提示，不再单独发卡片
		promptHash = hashPromptTail(cleaned)
		if st.NotifiedPrompt != promptHash {
			shouldNotifyPrompt = true
			promptType = detectPromptType(cleaned)
			st.NotifiedPrompt = promptHash
		}
	} else if !st.NotifiedComplete && !st.StableSince.IsZero() && now.Sub(st.StableSince) >= m.stableThreshold {
		shouldNotifyComplete = true
		st.NotifiedComplete = true
	}

	// 复制需要在锁外使用的数据
	label := st.Label
	cwd := st.CWD
	startTime := st.StartTime
	m.mu.Unlock()

	// 锁外发送通知
	if shouldNotifyComplete {
		m.sendCompleteNotification(s, label, cwd, cleaned, now.Sub(startTime))
	}
	if shouldNotifyPrompt {
		m.sendPromptNotification(s, label, cleaned, promptType)
	}
}

// sendCompleteNotification 发送"会话完成"通知
func (m *SessionMonitor) sendCompleteNotification(s *Session, label, cwd, tail string, duration time.Duration) {
	cardJSON := BuildSessionCompleteCard(label, cwd, tail, duration)
	receiveID, idType := notifyTarget(s)
	if receiveID == "" {
		log.Printf("monitor 无法路由完成通知: session=%s (缺少 chatID/userKey)", s.Name)
		return
	}
	if _, err := m.replier.SendCardToChatWithIDType(receiveID, idType, cardJSON); err != nil {
		log.Printf("monitor 推送完成通知失败: session=%s err=%v", s.Name, err)
	} else {
		log.Printf("monitor 已推送完成通知: session=%s label=%s", s.Name, label)
	}
}

// sendPromptNotification 发送"等待输入"通知
func (m *SessionMonitor) sendPromptNotification(s *Session, label, tail, promptType string) {
	cardJSON := BuildPromptWaitingCard(label, tail, promptType)
	receiveID, idType := notifyTarget(s)
	if receiveID == "" {
		log.Printf("monitor 无法路由等待输入通知: session=%s (缺少 chatID/userKey)", s.Name)
		return
	}
	if _, err := m.replier.SendCardToChatWithIDType(receiveID, idType, cardJSON); err != nil {
		log.Printf("monitor 推送等待输入通知失败: session=%s err=%v", s.Name, err)
	} else {
		log.Printf("monitor 已推送等待输入通知: session=%s label=%s type=%s", s.Name, label, promptType)
	}
}

// notifyTarget 根据会话信息返回通知的 receiveID + receiveIdType
// 群聊: Session.ChatID + chat_id
// 单聊: Session.UserKey (即 sender open_id) + open_id
// 若 ChatID 为空但是群聊会话（向后兼容老数据），退化到 UserKey
func notifyTarget(s *Session) (string, string) {
	if s.ChatType == "group" && s.ChatID != "" {
		return s.ChatID, larkim.ReceiveIdTypeChatId
	}
	// p2p 或缺少 ChatID 的情况
	if s.ChatID != "" {
		return s.ChatID, larkim.ReceiveIdTypeChatId
	}
	if s.UserKey != "" {
		return s.UserKey, larkim.ReceiveIdTypeOpenId
	}
	return "", ""
}

// hashPromptTail 提取最后 3 行非空内容的 hash，用于 prompt 去重
func hashPromptTail(content string) string {
	lines := strings.Split(strings.TrimSpace(content), "\n")
	tail := lines
	if len(lines) > 3 {
		tail = lines[len(lines)-3:]
	}
	joined := strings.Join(tail, "\n")
	h := sha256.Sum256([]byte(joined))
	return hex.EncodeToString(h[:8])
}

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// LiveStreamer 实况转播器
// 为每个活跃 tmux 会话维护一张飞书卡片，每 3 秒捕获终端最后 15 行
// 通过 Message.Patch 原地刷新，呈现"动态终端监控"效果
type LiveStreamer struct {
	mu      sync.Mutex
	sm      *SessionManager
	replier *Replier
	cards   map[string]*streamCard // tmuxName -> card state
	cancel  context.CancelFunc
}

// streamCard 单个会话的实况卡片状态
type streamCard struct {
	msgID       string // 飞书卡片消息 ID（用于 PATCH 更新）
	lastHash    string // 上次推送内容的 hash，内容不变时跳过 API 调用
	receiveID   string // 通知目标 ID
	receiveType string // open_id / chat_id
	label       string
	cwd         string
}

// NewLiveStreamer 构造实况转播器
func NewLiveStreamer(sm *SessionManager, replier *Replier) *LiveStreamer {
	return &LiveStreamer{
		sm:      sm,
		replier: replier,
		cards:   make(map[string]*streamCard),
	}
}

// Start 启动实况转播（后台 goroutine）
func (ls *LiveStreamer) Start() {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	if ls.cancel != nil {
		ls.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	ls.cancel = cancel
	go ls.run(ctx)
	log.Println("实况转播器已启动: 每 3 秒刷新")
}

// Stop 停止实况转播
func (ls *LiveStreamer) Stop() {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	if ls.cancel != nil {
		ls.cancel()
		ls.cancel = nil
	}
}

// run 主循环：每 3 秒扫描一次所有活跃会话
func (ls *LiveStreamer) run(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ls.scanOnce()
		}
	}
}

// scanOnce 扫描所有活跃会话，更新对应的实况卡片
func (ls *LiveStreamer) scanOnce() {
	sessions := ls.sm.SnapshotActive()

	// 构建活跃名称集合，用于清理已消失的会话
	activeNames := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		activeNames[s.Name] = true
	}

	// 清理已结束会话的卡片状态
	ls.mu.Lock()
	for name := range ls.cards {
		if !activeNames[name] {
			delete(ls.cards, name)
		}
	}
	ls.mu.Unlock()

	// 逐个处理活跃会话
	for _, s := range sessions {
		ls.handleSession(s)
	}
}

// handleSession 捕获单个会话的终端内容并更新飞书卡片
func (ls *LiveStreamer) handleSession(s *Session) {
	// 捕获最后 15 行终端内容
	content, err := captureTail(s.Name, 15)
	if err != nil {
		return
	}

	// 清洗 ANSI 转义码
	cleaned := stripANSI(content)
	cleaned = strings.TrimRight(cleaned, "\n ")

	// 跳过空内容
	if cleaned == "" {
		return
	}

	// 计算内容 hash，内容不变则跳过 API 调用
	h := sha256.Sum256([]byte(cleaned))
	contentHash := hex.EncodeToString(h[:8])

	// 检测交互提示，生成操作提示文本
	promptHint := ""
	if isInteractivePrompt(content) {
		promptType := detectPromptType(content)
		promptHint = buildPromptHint(promptType)
	}

	// 构建卡片 JSON
	cardJSON := BuildLiveTerminalCard(s.Label, cleaned, promptHint)

	ls.mu.Lock()
	card, exists := ls.cards[s.Name]
	if !exists {
		// 新会话：确定通知目标
		receiveID, receiveType := notifyTarget(s)
		if receiveID == "" {
			ls.mu.Unlock()
			return
		}
		card = &streamCard{
			receiveID:   receiveID,
			receiveType: receiveType,
			label:       s.Label,
			cwd:         s.CWD,
		}
		ls.cards[s.Name] = card
	}

	// 内容无变化且卡片已创建 → 跳过
	if card.lastHash == contentHash && card.msgID != "" {
		ls.mu.Unlock()
		return
	}
	card.lastHash = contentHash
	msgID := card.msgID
	receiveID := card.receiveID
	receiveType := card.receiveType
	ls.mu.Unlock()

	if msgID == "" {
		// 首次：创建实况卡片
		newID, err := ls.replier.SendCardToChatWithIDType(receiveID, receiveType, cardJSON)
		if err != nil {
			log.Printf("streamer 创建卡片失败: session=%s err=%v", s.Name, err)
			return
		}
		ls.mu.Lock()
		if c, ok := ls.cards[s.Name]; ok {
			c.msgID = newID
		}
		ls.mu.Unlock()
		log.Printf("streamer 创建实况卡片: session=%s label=%s", s.Name, s.Label)
	} else {
		// 更新已有卡片（原地 PATCH）
		if err := ls.replier.UpdateCard(msgID, cardJSON); err != nil {
			log.Printf("streamer 更新卡片失败: session=%s err=%v", s.Name, err)
		}
	}
}

// captureTail 捕获 tmux pane 最后 N 行内容
func captureTail(tmuxName string, lines int) (string, error) {
	cmd := exec.Command("tmux", "capture-pane", "-t", tmuxName, "-p", "-S", "-15")
	// 使用固定参数 -S -15 捕获最后 15 行，比 -S -500 更轻量
	_ = lines // 参数预留，实际使用固定值
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// buildPromptHint 根据交互提示类型生成快捷操作提示文本
func buildPromptHint(promptType string) string {
	switch promptType {
	case "yn":
		return "**⌨️ 等待输入** `/y` 允许 · `/n` 拒绝 · `/esc` 取消"
	case "menu":
		return "**⌨️ 等待选择** `/1` `/2` `/3` 选项 · `/do 2d sp ok` 组合操作"
	case "enter":
		return "**⌨️ 等待确认** `/enter` 继续 · `/esc` 取消"
	default:
		return "**⌨️ 等待输入** `/y` `/n` `/enter` `/esc` · `/s <文本>` 自由输入"
	}
}

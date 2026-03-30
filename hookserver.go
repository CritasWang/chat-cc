package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
)

// HookServer 提供 HTTP 端点供 Claude Code hooks 回调
type HookServer struct {
	port          int
	replier       *Replier
	defaultChatID string
	mu            sync.RWMutex
	// 存储最近的 hook 通知（可供查询）
	lastNotifications []HookNotification
}

// HookNotification Claude Code hook 发来的通知
type HookNotification struct {
	Event   string `json:"event"`
	Tool    string `json:"tool,omitempty"`
	Message string `json:"message,omitempty"`
	ChatID  string `json:"chat_id,omitempty"` // 指定推送到哪个飞书聊天，为空则用默认

	// 结构化字段（task_complete 事件使用）
	Project     string `json:"project,omitempty"`
	SessionID   string `json:"session_id,omitempty"`
	Duration    string `json:"duration,omitempty"`
	FileCount   int    `json:"file_count,omitempty"`
	Turns       int    `json:"turns,omitempty"`
	Prompt      string `json:"prompt,omitempty"`
	Summary     string `json:"summary,omitempty"`
	CompletedAt string `json:"completed_at,omitempty"`
}

func NewHookServer(port int, replier *Replier, defaultChatID string) *HookServer {
	return &HookServer{
		port:          port,
		replier:       replier,
		defaultChatID: defaultChatID,
	}
}

// SetDefaultChatID 热更新默认通知目标
func (hs *HookServer) SetDefaultChatID(chatID string) {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	hs.defaultChatID = chatID
}

// Start 启动 HTTP 服务
func (hs *HookServer) Start() {
	mux := http.NewServeMux()

	// Claude Code hooks 回调端点
	mux.HandleFunc("/notify", hs.handleNotify)

	// 健康检查
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	addr := fmt.Sprintf(":%d", hs.port)
	log.Printf("Hook 服务启动: http://localhost%s", addr)

	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("Hook 服务异常: %v", err)
		}
	}()
}

func (hs *HookServer) handleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var notif HookNotification
	if err := json.NewDecoder(r.Body).Decode(&notif); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	log.Printf("收到 hook 通知: event=%s tool=%s msg=%s", notif.Event, notif.Tool, notif.Message)

	// 保存通知
	hs.mu.Lock()
	hs.lastNotifications = append(hs.lastNotifications, notif)
	if len(hs.lastNotifications) > 100 {
		hs.lastNotifications = hs.lastNotifications[len(hs.lastNotifications)-50:]
	}
	hs.mu.Unlock()

	// 如果指定了 chat_id，主动推送到飞书；否则用默认
	chatID := notif.ChatID
	if chatID == "" {
		hs.mu.RLock()
		chatID = hs.defaultChatID
		hs.mu.RUnlock()
	}
	if chatID == "" {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok", "info": "no chat_id"})
		return
	}

	// 结构化 task_complete 事件 → 飞书卡片
	if notif.Event == "task_complete" && notif.Project != "" {
		cardJSON := buildTaskCompleteCard(&notif)
		if _, err := hs.replier.SendCardToChat(chatID, cardJSON); err != nil {
			log.Printf("推送飞书卡片失败: %v, 降级纯文本", err)
			// 降级：拼纯文本发送
			fallbackMsg := buildTaskCompleteFallback(&notif)
			if _, err2 := hs.replier.SendToChat(chatID, fallbackMsg); err2 != nil {
				log.Printf("降级纯文本也失败: %v", err2)
			}
		}
	} else if notif.Message != "" {
		// 兼容旧格式：纯文本消息
		if _, err := hs.replier.SendToChat(chatID, notif.Message); err != nil {
			log.Printf("推送飞书失败: %v", err)
		}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// buildTaskCompleteCard 构建任务完成的飞书卡片
func buildTaskCompleteCard(n *HookNotification) string {
	var elements []cardElement

	// 元信息行：项目 · session · 时间 · 耗时 · 文件数 · 轮次
	metaParts := []string{fmt.Sprintf("📁 **%s**", n.Project)}
	if n.SessionID != "" {
		metaParts = append(metaParts, n.SessionID)
	}
	if n.CompletedAt != "" {
		metaParts = append(metaParts, n.CompletedAt)
	}
	if n.Duration != "" {
		metaParts = append(metaParts, fmt.Sprintf("⏱ %s", n.Duration))
	}
	if n.FileCount > 0 {
		metaParts = append(metaParts, fmt.Sprintf("📂 %d 个文件", n.FileCount))
	}
	if n.Turns > 0 {
		metaParts = append(metaParts, fmt.Sprintf("🔄 %d 轮", n.Turns))
	}

	metaLine := ""
	for i, p := range metaParts {
		if i > 0 {
			metaLine += "  ·  "
		}
		metaLine += p
	}
	elements = append(elements, cardElement{Tag: "markdown", Content: metaLine})

	// 用户输入
	if n.Prompt != "" {
		elements = append(elements, cardElement{Tag: "hr"})
		elements = append(elements, cardElement{
			Tag:     "markdown",
			Content: fmt.Sprintf("**📝 用户输入**\n%s", n.Prompt),
		})
	}

	// 任务摘要
	if n.Summary != "" {
		elements = append(elements, cardElement{Tag: "hr"})
		elements = append(elements, cardElement{
			Tag:     "markdown",
			Content: fmt.Sprintf("**📋 任务摘要**\n%s", n.Summary),
		})
	}

	return buildCard("✅ Claude Code 任务完成", "green", elements)
}

// buildTaskCompleteFallback 卡片发送失败时的纯文本降级
func buildTaskCompleteFallback(n *HookNotification) string {
	msg := fmt.Sprintf("✅ Claude Code 任务完成\n📁 %s · %s · %s",
		n.Project, n.SessionID, n.CompletedAt)
	if n.Duration != "" {
		msg += fmt.Sprintf(" · ⏱%s", n.Duration)
	}
	if n.FileCount > 0 {
		msg += fmt.Sprintf(" · 📂%d个文件", n.FileCount)
	}
	if n.Turns > 0 {
		msg += fmt.Sprintf(" · 🔄%d轮", n.Turns)
	}
	if n.Prompt != "" {
		msg += fmt.Sprintf("\n\n📝 %s", n.Prompt)
	}
	if n.Summary != "" {
		msg += fmt.Sprintf("\n\n📋 %s", n.Summary)
	}
	return msg
}

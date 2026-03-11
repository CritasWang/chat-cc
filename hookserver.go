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
	port           int
	replier        *Replier
	defaultChatID  string
	mu             sync.RWMutex
	// 存储最近的 hook 通知（可供查询）
	lastNotifications []HookNotification
}

// HookNotification Claude Code hook 发来的通知
type HookNotification struct {
	Event   string `json:"event"`
	Tool    string `json:"tool,omitempty"`
	Message string `json:"message,omitempty"`
	ChatID  string `json:"chat_id,omitempty"` // 指定推送到哪个飞书聊天，为空则用默认
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
	if chatID != "" && notif.Message != "" {
		if _, err := hs.replier.SendToChat(chatID, notif.Message); err != nil {
			log.Printf("推送飞书失败: %v", err)
		}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

package main

import (
	"context"
	"log"
	"sync"
	"time"
)

// StatusPusher 定时将系统状态以卡片形式推送到飞书群聊
type StatusPusher struct {
	mu       sync.Mutex
	interval time.Duration
	chatID   string
	replier  *Replier
	statusFn func() (string, error) // 生成状态文本
	cancel   context.CancelFunc
}

// NewStatusPusher 创建状态推送器
func NewStatusPusher(replier *Replier, statusFn func() (string, error)) *StatusPusher {
	return &StatusPusher{
		replier:  replier,
		statusFn: statusFn,
	}
}

// Configure 配置推送参数并启动/重启定时器
// intervalMinutes=0 或 chatID="" 时禁用推送
func (sp *StatusPusher) Configure(intervalMinutes int, chatID string) {
	sp.mu.Lock()
	defer sp.mu.Unlock()

	newInterval := time.Duration(intervalMinutes) * time.Minute

	// 如果没变化，跳过
	if sp.interval == newInterval && sp.chatID == chatID {
		return
	}

	// 停止已有定时器
	if sp.cancel != nil {
		sp.cancel()
		sp.cancel = nil
	}

	sp.interval = newInterval
	sp.chatID = chatID

	// 启动新定时器
	if intervalMinutes > 0 && chatID != "" {
		ctx, cancel := context.WithCancel(context.Background())
		sp.cancel = cancel
		go sp.run(ctx, newInterval, chatID)
		log.Printf("状态定时推送已启动: 每 %d 分钟推送到 %s", intervalMinutes, chatID)
	} else {
		log.Println("状态定时推送已禁用")
	}
}

func (sp *StatusPusher) run(ctx context.Context, interval time.Duration, chatID string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sp.push(chatID)
		}
	}
}

func (sp *StatusPusher) push(chatID string) {
	text, err := sp.statusFn()
	if err != nil {
		log.Printf("生成状态信息失败: %v", err)
		return
	}

	cardJSON := TextToCard(text)
	if _, err := sp.replier.SendCardToChat(chatID, cardJSON); err != nil {
		log.Printf("推送状态卡片失败: %v", err)
	} else {
		log.Printf("状态卡片已推送到 %s", chatID)
	}
}

// Stop 停止定时推送
func (sp *StatusPusher) Stop() {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.cancel != nil {
		sp.cancel()
		sp.cancel = nil
	}
}

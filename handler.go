package main

import (
	"context"
	"encoding/json"
	"log"
	"strings"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"

	"feishu-bot/commands"
)

// textContent 飞书文本消息 content JSON 结构
type textContent struct {
	Text string `json:"text"`
}

// NewEventHandler 创建飞书事件处理器
func NewEventHandler(cfg *Config, router *Router, replier *Replier) *dispatcher.EventDispatcher {
	// WebSocket 模式下 verificationToken 和 eventEncryptKey 传空字符串
	handler := dispatcher.NewEventDispatcher("", "")

	handler.OnP2MessageReceiveV1(func(ctx context.Context, event *larkim.P2MessageReceiveV1) error {
		if event.Event == nil || event.Event.Message == nil {
			return nil
		}

		msg := event.Event.Message
		sender := event.Event.Sender

		// 只处理文本消息
		if msg.MessageType == nil || *msg.MessageType != "text" {
			return nil
		}

		// 权限检查
		senderID := ""
		if sender != nil && sender.SenderId != nil && sender.SenderId.OpenId != nil {
			senderID = *sender.SenderId.OpenId
		}
		if !isAllowed(cfg, senderID, getStr(msg.ChatId)) {
			log.Printf("拒绝未授权消息: sender=%s chat=%s", senderID, getStr(msg.ChatId))
			return nil
		}

		// 解析消息内容
		content := getStr(msg.Content)
		var tc textContent
		if err := json.Unmarshal([]byte(content), &tc); err != nil {
			log.Printf("解析消息内容失败: %v, raw: %s", err, content)
			return nil
		}

		text := strings.TrimSpace(tc.Text)
		if text == "" {
			return nil
		}

		// 群聊中需要去掉 @机器人 的部分
		mentionBot := false
		if msg.Mentions != nil {
			for _, m := range msg.Mentions {
				if m.Key != nil && m.Name != nil {
					text = strings.ReplaceAll(text, *m.Key, "")
					mentionBot = true
				}
			}
			text = strings.TrimSpace(text)
		}

		// 构建消息元数据
		meta := &commands.MessageMeta{
			MessageID:  getStr(msg.MessageId),
			ChatID:     getStr(msg.ChatId),
			ChatType:   getStr(msg.ChatType),
			SenderID:   senderID,
			MentionBot: mentionBot,
		}

		log.Printf("收到消息: sender=%s chat=%s text=%s", senderID, meta.ChatID, text)

		// 异步处理命令（避免阻塞事件循环）
		go func() {
			// 先回复"处理中"
			processingMsgID := ""
			if isLongRunning(text) {
				id, err := replier.Reply(meta.MessageID, "⏳ 处理中...")
				if err == nil {
					processingMsgID = id
				}
			}

			result, err := router.Dispatch(context.Background(), text, meta)
			if err != nil {
				result = "内部错误: " + err.Error()
			}

			if result != "" {
				// 如果之前发了"处理中"，更新那条消息
				if processingMsgID != "" {
					// 对于长消息，先更新为提示，然后分块回复
					if len(result) > 3500 {
						replier.Update(processingMsgID, "✅ 处理完成，正在发送结果...")
						replier.ReplyChunked(meta.MessageID, result, 3500)
					} else if updateErr := replier.Update(processingMsgID, result); updateErr != nil {
						// 更新失败则发新消息
						replier.Reply(meta.MessageID, result)
					}
				} else {
					// 使用分块回复处理长消息
					if len(result) > 3500 {
						replier.ReplyChunked(meta.MessageID, result, 3500)
					} else {
						replier.Reply(meta.MessageID, result)
					}
				}
			}
		}()

		return nil
	})

	// 日志配置
	handler.InitConfig(func(config *larkcore.Config) {
		switch cfg.LogLevel {
		case "debug":
			config.LogLevel = larkcore.LogLevelDebug
		case "warn":
			config.LogLevel = larkcore.LogLevelWarn
		case "error":
			config.LogLevel = larkcore.LogLevelError
		default:
			config.LogLevel = larkcore.LogLevelInfo
		}
	})

	return handler
}

// isAllowed 检查发送者/群聊是否在允许列表中
func isAllowed(cfg *Config, senderID, chatID string) bool {
	// 未配置限制则允许所有
	if len(cfg.AllowedUsers) == 0 && len(cfg.AllowedChats) == 0 {
		return true
	}

	for _, u := range cfg.AllowedUsers {
		if u == senderID {
			return true
		}
	}
	for _, c := range cfg.AllowedChats {
		if c == chatID {
			return true
		}
	}
	return false
}

// isLongRunning 判断命令是否可能长时间执行
func isLongRunning(text string) bool {
	text = strings.ToLower(text)
	if strings.HasPrefix(text, "/ask") || strings.HasPrefix(text, "/s ") {
		return true
	}
	// 非命令消息也可能需要较长时间
	if !strings.HasPrefix(text, "/") {
		return true
	}
	return false
}

func getStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

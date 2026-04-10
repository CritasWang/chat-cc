package main

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"

	"chatcc/commands"
)

// textContent 飞书文本消息 content JSON 结构
type textContent struct {
	Text string `json:"text"`
}

// NewEventHandler 创建飞书事件处理器
func NewEventHandler(cfg *Config, router *Router, replier *Replier) *dispatcher.EventDispatcher {
	// WebSocket 模式下 verificationToken 和 eventEncryptKey 传空字符串
	handler := dispatcher.NewEventDispatcher("", "")

	// 用于限制每个聊天只有一次流式推送（避免重复卡片）
	var streamMu sync.Mutex
	streamMsgIDs := make(map[string]string) // chatKey → 最近一次流式推送的 messageID

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

		// 为长时间运行的命令设置流式输出回调
		// 当实况转播器启用时，跳过 handler 级流式推送（LiveStreamer 已覆盖）
		if cfg.StreamEnabled && !cfg.LiveStreamEnabled && isLongRunning(text) {
			chatKey := meta.SessionKey()
			meta.StreamFn = func(text string) {
				streamMu.Lock()
				lastMsgID := streamMsgIDs[chatKey]
				streamMu.Unlock()

				// 构建流式更新卡片
				cardJSON := BuildCardJSON("📡 进度更新", text, "indigo")

				if lastMsgID != "" {
					// 更新已有的流式推送消息（原地更新，减少消息刷屏）
					if err := replier.UpdateCard(lastMsgID, cardJSON); err != nil {
						log.Printf("更新流式卡片失败: %v, 降级为新消息", err)
						// 降级为新消息
						if newID, err := replier.ReplyCard(meta.MessageID, text); err == nil {
							streamMu.Lock()
							streamMsgIDs[chatKey] = newID
							streamMu.Unlock()
						}
					}
				} else {
					// 首次流式推送：创建新卡片
					if newID, err := replier.ReplyCard(meta.MessageID, "📡 进度更新\n━━━━━━━━━━━━━━━━━━━━\n"+text); err == nil {
						streamMu.Lock()
						streamMsgIDs[chatKey] = newID
						streamMu.Unlock()
					}
				}
			}
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

			// 清理流式推送状态
			if meta.StreamFn != nil {
				chatKey := meta.SessionKey()
				streamMu.Lock()
				// 更新流式卡片为"已完成"
				if lastMsgID, ok := streamMsgIDs[chatKey]; ok && lastMsgID != "" {
					go replier.UpdateCard(lastMsgID, BuildCardJSON("✅ 处理完成", "最终结果见下方回复", "green"))
				}
				delete(streamMsgIDs, chatKey)
				streamMu.Unlock()
			}

			if result != "" {
				if processingMsgID != "" {
					replier.Update(processingMsgID, "✅ 处理完成")
				}

				// 检测命令是否返回预构建的卡片 JSON（如 /help）
				if strings.HasPrefix(result, commands.CardJSONMarker) {
					cardJSON := strings.TrimPrefix(result, commands.CardJSONMarker)
					if _, err := replier.ReplyCardJSON(meta.MessageID, cardJSON); err != nil {
						log.Printf("预构建卡片回复失败，降级纯文本: %v", err)
						replier.Reply(meta.MessageID, "命令执行成功，但卡片渲染失败")
					}
				} else if len(result) > cfg.MaxChunkSize {
					// 以卡片形式回复，失败则降级为纯文本
					if err := replier.ReplyCardChunked(meta.MessageID, result, cfg.MaxChunkSize); err != nil {
						log.Printf("卡片分块回复失败，降级纯文本: %v", err)
						replier.ReplyChunked(meta.MessageID, result, cfg.MaxChunkSize)
					}
				} else {
					if _, err := replier.ReplyCard(meta.MessageID, result); err != nil {
						log.Printf("卡片回复失败，降级纯文本: %v", err)
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

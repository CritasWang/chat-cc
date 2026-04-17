package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher/callback"

	"chatcc/commands"
)

// cardActionDeps 卡片回调所需的依赖集合
type cardActionDeps struct {
	cfg            *Config
	router         *Router
	replier        *Replier
	statusCard     func() string                                 // /status 卡片生成器（用于 refresh=status）
	sessionListFn  func(meta *commands.MessageMeta) string       // /session list 卡片生成器
	projectCardFn  func() string                                 // /project 卡片生成器
	dangerCardFn   func() string                                 // /danger 卡片生成器
	sendCardToChat func(chatID, cardJSON string) (string, error) // 兜底发送
}

// NewCardActionHandler 构造飞书卡片回调事件处理器
// 按钮 payload 约定:
//
//	{"cmd":"xxx", "args":"...", "echo":"...", "refresh":"...", "silent":true}
//
//	cmd     目标命令（如 "session", "key"）
//	args    命令参数（拼成 "/cmd args"）
//	echo    若非空：直接 Toast 反馈，不再执行命令
//	refresh 非空：命令执行完后按 refresh 类型重建卡片覆盖原消息（status/session_list/project/danger/help）
//	silent  非空：不落地任何聊天消息，只返回 Toast
func NewCardActionHandler(deps cardActionDeps) func(context.Context, *callback.CardActionTriggerEvent) (*callback.CardActionTriggerResponse, error) {
	return func(ctx context.Context, event *callback.CardActionTriggerEvent) (*callback.CardActionTriggerResponse, error) {
		if event == nil || event.Event == nil || event.Event.Action == nil {
			return nil, nil
		}
		evt := event.Event

		senderID := ""
		if evt.Operator != nil {
			senderID = evt.Operator.OpenID
		}
		chatID := ""
		messageID := ""
		if evt.Context != nil {
			chatID = evt.Context.OpenChatID
			messageID = evt.Context.OpenMessageID
		}

		// 权限校验
		if !isAllowed(deps.cfg, senderID, chatID) {
			log.Printf("拒绝未授权卡片回调: sender=%s chat=%s", senderID, chatID)
			return toastResp("error", "未授权"), nil
		}

		value := evt.Action.Value
		cmdName, _ := value["cmd"].(string)
		args, _ := value["args"].(string)
		echo, _ := value["echo"].(string)
		refresh, _ := value["refresh"].(string)
		silent, _ := value["silent"].(bool)

		log.Printf("卡片回调: sender=%s chat=%s cmd=%s args=%s refresh=%s", senderID, chatID, cmdName, args, refresh)

		// 重建 MessageMeta（没有 ChatType，前缀判定）
		meta := &commands.MessageMeta{
			MessageID:  messageID,
			ChatID:     chatID,
			ChatType:   chatTypeFromID(chatID),
			SenderID:   senderID,
			MentionBot: true,
		}

		// 无 cmd 时按 echo 处理（纯 Toast 按钮）
		if cmdName == "" {
			if echo != "" {
				return toastResp("info", echo), nil
			}
			return toastResp("info", "✓"), nil
		}

		// 执行命令
		cmdLine := "/" + cmdName
		if args != "" {
			cmdLine += " " + args
		}

		result, err := deps.router.Dispatch(ctx, cmdLine, meta)
		if err != nil {
			return toastResp("error", fmt.Sprintf("执行失败: %s", err)), nil
		}

		// 优先 echo（即时 Toast），其次 result 的前 80 字作为 Toast
		toastText := echo
		if toastText == "" {
			toastText = shortToast(result)
		}

		// 刷新原卡片（如需要）
		var cardResp *callback.Card
		if refresh != "" {
			cardJSON := renderRefreshCard(deps, refresh, meta)
			if cardJSON != "" {
				if data := jsonToMap(cardJSON); data != nil {
					cardResp = &callback.Card{Type: "raw", Data: data}
				}
			}
		}

		// 非 silent 模式下，若命令有实质回复，落地一条新消息到聊天
		if !silent && result != "" && refresh == "" {
			go sendResultAsMessage(deps, meta, result)
		}

		return &callback.CardActionTriggerResponse{
			Toast: &callback.Toast{Type: toastType(result), Content: toastText},
			Card:  cardResp,
		}, nil
	}
}

// chatTypeFromID 根据 chat_id 前缀推断聊天类型
// 飞书 chat_id 前缀:  oc_ = 群聊;  单聊通常以 ou_ 或其他前缀（fallback p2p）
func chatTypeFromID(chatID string) string {
	if strings.HasPrefix(chatID, "oc_") {
		return "group"
	}
	return "p2p"
}

// toastResp 只返回 Toast 不修改卡片
func toastResp(toastType, content string) *callback.CardActionTriggerResponse {
	if content == "" {
		content = "✓"
	}
	return &callback.CardActionTriggerResponse{
		Toast: &callback.Toast{Type: toastType, Content: content},
	}
}

// toastType 根据回复内容推断 Toast 等级
func toastType(text string) string {
	switch {
	case strings.Contains(text, "❌") || strings.Contains(text, "错误") || strings.Contains(text, "失败"):
		return "error"
	case strings.Contains(text, "⚠️") || strings.Contains(text, "警告"):
		return "warning"
	case strings.Contains(text, "✅") || strings.Contains(text, "成功"):
		return "success"
	default:
		return "info"
	}
}

// shortToast 截取命令回复的关键行作为 Toast 文本
func shortToast(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return "✓"
	}
	// 去掉 CardJSONMarker 前缀（如果命令返回的是预构建卡片）
	if strings.HasPrefix(text, commands.CardJSONMarker) {
		return "✓ 已完成"
	}
	// 取第一行
	firstLine := text
	if idx := strings.Index(text, "\n"); idx >= 0 {
		firstLine = text[:idx]
	}
	runes := []rune(firstLine)
	if len(runes) > 80 {
		return string(runes[:80]) + "…"
	}
	return firstLine
}

// renderRefreshCard 根据 refresh 类型生成新卡片 JSON
func renderRefreshCard(deps cardActionDeps, kind string, meta *commands.MessageMeta) string {
	switch kind {
	case "status":
		if deps.statusCard != nil {
			return deps.statusCard()
		}
	case "session_list", "sessions":
		if deps.sessionListFn != nil {
			return deps.sessionListFn(meta)
		}
	case "project":
		if deps.projectCardFn != nil {
			return deps.projectCardFn()
		}
	case "danger":
		if deps.dangerCardFn != nil {
			return deps.dangerCardFn()
		}
	}
	return ""
}

// jsonToMap 把卡片 JSON 字符串转成 map[string]interface{}（SDK 要求 Card.Data 为可序列化对象）
func jsonToMap(jsonStr string) map[string]interface{} {
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(jsonStr), &m); err != nil {
		log.Printf("卡片 JSON 反解析失败: %v", err)
		return nil
	}
	return m
}

// sendResultAsMessage 把命令执行结果作为新消息发送到原聊天（非 silent 且无 refresh 时）
func sendResultAsMessage(deps cardActionDeps, meta *commands.MessageMeta, result string) {
	if result == "" || deps.replier == nil || meta.ChatID == "" {
		return
	}
	if strings.HasPrefix(result, commands.CardJSONMarker) {
		cardJSON := strings.TrimPrefix(result, commands.CardJSONMarker)
		if _, err := deps.replier.SendCardToChat(meta.ChatID, cardJSON); err != nil {
			log.Printf("卡片回调结果卡片发送失败: %v", err)
		}
		return
	}
	// 长回复走卡片
	if _, err := deps.replier.SendCardToChat(meta.ChatID, TextToCard(result)); err != nil {
		// 降级纯文本
		if _, err2 := deps.replier.SendToChat(meta.ChatID, result); err2 != nil {
			log.Printf("卡片回调结果发送失败: %v / %v", err, err2)
		}
	}
}

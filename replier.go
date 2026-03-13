package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"unicode/utf8"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

// Replier 飞书消息回复器
type Replier struct {
	client *lark.Client
}

func NewReplier(client *lark.Client) *Replier {
	return &Replier{client: client}
}

// Reply 回复一条消息，返回新消息的 messageID
func (r *Replier) Reply(messageID, text string) (string, error) {
	content, _ := json.Marshal(map[string]string{"text": text})

	resp, err := r.client.Im.Message.Reply(context.Background(),
		larkim.NewReplyMessageReqBuilder().
			MessageId(messageID).
			Body(larkim.NewReplyMessageReqBodyBuilder().
				MsgType(larkim.MsgTypeText).
				Content(string(content)).
				Build()).
			Build())

	if err != nil {
		log.Printf("回复消息失败: %v", err)
		return "", err
	}

	if !resp.Success() {
		log.Printf("回复消息失败: code=%d msg=%s", resp.Code, resp.Msg)
		return "", fmt.Errorf("feishu API error: %d %s", resp.Code, resp.Msg)
	}

	msgID := ""
	if resp.Data != nil && resp.Data.MessageId != nil {
		msgID = *resp.Data.MessageId
	}
	return msgID, nil
}

// Update 更新已发送的消息内容
func (r *Replier) Update(messageID, text string) error {
	content, _ := json.Marshal(map[string]string{"text": text})

	resp, err := r.client.Im.Message.Patch(context.Background(),
		larkim.NewPatchMessageReqBuilder().
			MessageId(messageID).
			Body(larkim.NewPatchMessageReqBodyBuilder().
				Content(string(content)).
				Build()).
			Build())

	if err != nil {
		return err
	}

	if !resp.Success() {
		return fmt.Errorf("feishu API error: %d %s", resp.Code, resp.Msg)
	}

	return nil
}

// SendToChat 主动向聊天发送消息
func (r *Replier) SendToChat(chatID, text string) (string, error) {
	content, _ := json.Marshal(map[string]string{"text": text})

	resp, err := r.client.Im.Message.Create(context.Background(),
		larkim.NewCreateMessageReqBuilder().
			ReceiveIdType(larkim.ReceiveIdTypeChatId).
			Body(larkim.NewCreateMessageReqBodyBuilder().
				MsgType(larkim.MsgTypeText).
				ReceiveId(chatID).
				Content(string(content)).
				Build()).
			Build())

	if err != nil {
		return "", err
	}

	if !resp.Success() {
		return "", fmt.Errorf("feishu API error: %d %s", resp.Code, resp.Msg)
	}

	msgID := ""
	if resp.Data != nil && resp.Data.MessageId != nil {
		msgID = *resp.Data.MessageId
	}
	return msgID, nil
}

// ReplyChunked 将长消息分块回复，避免消息截断
// maxChunkSize: 每块最大字符数，默认 3500（为 4000 限制留有余量）
func (r *Replier) ReplyChunked(messageID, text string, maxChunkSize int) error {
	if maxChunkSize <= 0 {
		maxChunkSize = 3500
	}

	// 如果消息短于限制，直接发送
	if utf8.RuneCountInString(text) <= maxChunkSize {
		_, err := r.Reply(messageID, text)
		return err
	}

	// 分块发送
	chunks := splitIntoChunks(text, maxChunkSize)
	totalChunks := len(chunks)

	for i, chunk := range chunks {
		// 添加分块标识
		chunkText := chunk
		if totalChunks > 1 {
			chunkText = fmt.Sprintf("[%d/%d]\n%s", i+1, totalChunks, chunk)
		}

		if _, err := r.Reply(messageID, chunkText); err != nil {
			log.Printf("发送第 %d/%d 块消息失败: %v", i+1, totalChunks, err)
			return err
		}
	}

	return nil
}

// ReplyCard 以卡片形式回复消息
func (r *Replier) ReplyCard(messageID, text string) (string, error) {
	cardJSON := TextToCard(text)

	resp, err := r.client.Im.Message.Reply(context.Background(),
		larkim.NewReplyMessageReqBuilder().
			MessageId(messageID).
			Body(larkim.NewReplyMessageReqBodyBuilder().
				MsgType(larkim.MsgTypeInteractive).
				Content(cardJSON).
				Build()).
			Build())

	if err != nil {
		log.Printf("回复卡片消息失败: %v", err)
		return "", err
	}

	if !resp.Success() {
		log.Printf("回复卡片消息失败: code=%d msg=%s", resp.Code, resp.Msg)
		return "", fmt.Errorf("feishu API error: %d %s", resp.Code, resp.Msg)
	}

	msgID := ""
	if resp.Data != nil && resp.Data.MessageId != nil {
		msgID = *resp.Data.MessageId
	}
	return msgID, nil
}

// ReplyCardChunked 将长消息分块以卡片形式回复
func (r *Replier) ReplyCardChunked(messageID, text string, maxBodyRunes int) error {
	cards := TextToCardChunks(text, maxBodyRunes)
	for i, cardJSON := range cards {
		resp, err := r.client.Im.Message.Reply(context.Background(),
			larkim.NewReplyMessageReqBuilder().
				MessageId(messageID).
				Body(larkim.NewReplyMessageReqBodyBuilder().
					MsgType(larkim.MsgTypeInteractive).
					Content(cardJSON).
					Build()).
				Build())

		if err != nil {
			log.Printf("发送第 %d/%d 张卡片失败: %v", i+1, len(cards), err)
			return err
		}

		if !resp.Success() {
			log.Printf("发送第 %d/%d 张卡片失败: code=%d msg=%s", i+1, len(cards), resp.Code, resp.Msg)
			return fmt.Errorf("feishu API error: %d %s", resp.Code, resp.Msg)
		}
	}
	return nil
}

// SendCardToChat 主动向聊天发送卡片消息
func (r *Replier) SendCardToChat(chatID, cardJSON string) (string, error) {
	resp, err := r.client.Im.Message.Create(context.Background(),
		larkim.NewCreateMessageReqBuilder().
			ReceiveIdType(larkim.ReceiveIdTypeChatId).
			Body(larkim.NewCreateMessageReqBodyBuilder().
				MsgType(larkim.MsgTypeInteractive).
				ReceiveId(chatID).
				Content(cardJSON).
				Build()).
			Build())

	if err != nil {
		log.Printf("发送卡片到聊天失败: %v", err)
		return "", err
	}

	if !resp.Success() {
		log.Printf("发送卡片到聊天失败: code=%d msg=%s", resp.Code, resp.Msg)
		return "", fmt.Errorf("feishu API error: %d %s", resp.Code, resp.Msg)
	}

	msgID := ""
	if resp.Data != nil && resp.Data.MessageId != nil {
		msgID = *resp.Data.MessageId
	}
	return msgID, nil
}

// splitIntoChunks 智能分块：优先在段落、句子边界分块，UTF-8 安全
func splitIntoChunks(text string, maxSize int) []string {
	if utf8.RuneCountInString(text) <= maxSize {
		return []string{text}
	}

	var chunks []string
	remaining := text

	for len(remaining) > 0 {
		if utf8.RuneCountInString(remaining) <= maxSize {
			chunks = append(chunks, remaining)
			break
		}

		// Convert to runes to find safe split position
		runes := []rune(remaining)
		// Start from maxSize rune position
		splitPos := string(runes[:maxSize])
		byteLen := len(splitPos)

		// Try to find best split point within the chunk (working with string, all positions are byte-safe because we search for known substrings)
		chunk := splitPos
		if pos := strings.LastIndex(chunk, "\n\n"); pos > byteLen/2 {
			byteLen = pos + 2
		} else if pos := strings.LastIndex(chunk, "\n"); pos > byteLen/2 {
			byteLen = pos + 1
		} else if pos := strings.LastIndex(chunk, "。"); pos > byteLen/2 {
			byteLen = pos + len("。")
		} else if pos := strings.LastIndex(chunk, ". "); pos > byteLen/2 {
			byteLen = pos + 2
		} else if pos := strings.LastIndex(chunk, "，"); pos > byteLen/2 {
			byteLen = pos + len("，")
		} else if pos := strings.LastIndex(chunk, ", "); pos > byteLen/2 {
			byteLen = pos + 2
		} else if pos := strings.LastIndex(chunk, " "); pos > byteLen/2 {
			byteLen = pos + 1
		}
		// If none found, byteLen stays at the rune-safe position

		chunks = append(chunks, remaining[:byteLen])
		remaining = remaining[byteLen:]
	}

	return chunks
}

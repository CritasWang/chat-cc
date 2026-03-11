package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

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
	if len(text) <= maxChunkSize {
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

// splitIntoChunks 智能分块：优先在段落、句子边界分块
func splitIntoChunks(text string, maxSize int) []string {
	if len(text) <= maxSize {
		return []string{text}
	}

	var chunks []string
	remaining := text

	for len(remaining) > 0 {
		if len(remaining) <= maxSize {
			chunks = append(chunks, remaining)
			break
		}

		// 尝试在 maxSize 范围内找最佳分割点
		splitPos := maxSize

		// 1. 优先在段落边界（双换行）分割
		chunk := remaining[:maxSize]
		if pos := findLastOccurrence(chunk, "\n\n"); pos > maxSize/2 {
			splitPos = pos + 2
		} else if pos := findLastOccurrence(chunk, "\n"); pos > maxSize/2 {
			// 2. 其次在单换行分割
			splitPos = pos + 1
		} else if pos := findLastOccurrence(chunk, "。"); pos > maxSize/2 {
			// 3. 中文句号
			splitPos = pos + len("。")
		} else if pos := findLastOccurrence(chunk, ". "); pos > maxSize/2 {
			// 4. 英文句号+空格
			splitPos = pos + 2
		} else if pos := findLastOccurrence(chunk, "，"); pos > maxSize/2 {
			// 5. 中文逗号
			splitPos = pos + len("，")
		} else if pos := findLastOccurrence(chunk, ", "); pos > maxSize/2 {
			// 6. 英文逗号+空格
			splitPos = pos + 2
		} else if pos := findLastOccurrence(chunk, " "); pos > maxSize/2 {
			// 7. 最后尝试空格
			splitPos = pos + 1
		}
		// 8. 如果都找不到，就在 maxSize 处硬切割

		chunks = append(chunks, remaining[:splitPos])
		remaining = remaining[splitPos:]
	}

	return chunks
}

// findLastOccurrence 查找字符串最后一次出现的位置
func findLastOccurrence(s, substr string) int {
	idx := -1
	offset := 0
	for {
		pos := indexOf(s[offset:], substr)
		if pos == -1 {
			break
		}
		idx = offset + pos
		offset = idx + len(substr)
	}
	return idx
}

// indexOf 返回子串在字符串中的位置，未找到返回 -1
func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

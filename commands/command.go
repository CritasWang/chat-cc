package commands

import "context"

// CardJSONMarker 标记命令返回的是预构建的飞书卡片 JSON
// handler 检测到此前缀时直接发送，不经过 TextToCard 转换
const CardJSONMarker = "\x00CARD\x00"

// Command 定义命令接口
type Command interface {
	// Name 命令名称，如 "ask", "session", "shell"
	Name() string

	// Aliases 命令别名，如 "s" 是 "session send" 的别名
	Aliases() []string

	// Description 命令描述，用于 /help
	Description() string

	// Usage 使用方法
	Usage() string

	// Execute 执行命令
	// args: 命令参数（去掉命令名后的部分）
	// meta: 消息元数据（发送者、聊天等信息）
	// 返回回复文本和可能的错误
	Execute(ctx context.Context, args string, meta *MessageMeta) (string, error)
}

// MessageMeta 消息元数据
type MessageMeta struct {
	MessageID  string            // 消息 ID，用于回复
	ChatID     string            // 聊天 ID
	ChatType   string            // 聊天类型: p2p, group
	SenderID   string            // 发送者 open_id
	SenderName string            // 发送者名称
	MentionBot bool              // 是否 @了机器人（群聊中需要）
	StreamFn   func(text string) // 可选: 流式输出回调，用于推送中间结果到聊天
}

// SessionKey 根据消息元数据生成会话 key
// 群聊用 chatID，单聊用 senderID
func (m *MessageMeta) SessionKey() string {
	if m.ChatType == "group" {
		return m.ChatID
	}
	return m.SenderID
}

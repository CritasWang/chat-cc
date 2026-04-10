package commands

import (
	"context"
	"fmt"
	"strings"
)

// DoCommand 宏指令：将简短的按键描述符批量转换为 tmux 按键序列
// 用户在飞书中看到 TUI 菜单后，一条 /do 命令即可秒杀所有多选操作
//
// 语法: /do 2d sp ok → Down Down Space Enter
type DoCommand struct {
	sm SessionIface
}

func NewDoCommand(sm SessionIface) *DoCommand {
	return &DoCommand{sm: sm}
}

func (c *DoCommand) Name() string      { return "do" }
func (c *DoCommand) Aliases() []string { return nil }
func (c *DoCommand) Description() string {
	return "宏指令：快速发送组合键序列（配合实况终端使用）"
}
func (c *DoCommand) Usage() string {
	return `/do <动作序列>

动作:
  d / down   ↓ 下箭头      u / up     ↑ 上箭头
  l / left   ← 左箭头      r / right  → 右箭头
  sp / space ␣ 空格        ok / enter ↵ 回车
  tab        ⇥ Tab          esc        ⎋ Esc
  y          y+回车          n          n+回车

数字前缀 = 重复: 2d = 按两次↓, 3sp = 按三次空格

示例:
  /do 2d sp ok       ↓↓ 空格 回车（选中第3项并确认）
  /do 3d sp 2d sp ok 多选菜单操作
  /do y              快速确认
  /do esc            取消当前操作`
}

func (c *DoCommand) Execute(ctx context.Context, args string, meta *MessageMeta) (string, error) {
	args = strings.TrimSpace(args)
	if args == "" {
		return c.Usage(), nil
	}

	tokens := strings.Fields(args)
	var allKeys [][]string // 每个元素是一次 send-keys 的参数
	var display []string

	for _, token := range tokens {
		repeat, action := parseDoToken(token)
		tmuxKeys, displayName, ok := mapDoAction(action)
		if !ok {
			return fmt.Sprintf("❌ 未知动作: %s\n\n%s", token, c.Usage()), nil
		}
		for i := 0; i < repeat; i++ {
			allKeys = append(allKeys, tmuxKeys)
			display = append(display, displayName)
		}
	}

	if len(allKeys) == 0 {
		return "❌ 没有有效的动作", nil
	}

	key := meta.SessionKey()
	for _, keys := range allKeys {
		if err := c.sm.SendKeys(key, keys...); err != nil {
			return fmt.Sprintf("❌ 发送失败: %s\n💡 请先使用 /session start 启动会话", err), nil
		}
	}

	return fmt.Sprintf("⌨️ 已执行: %s", strings.Join(display, " ")), nil
}

// parseDoToken 解析 token，提取数字前缀和动作名
// "2d" → (2, "d"), "sp" → (1, "sp"), "3down" → (3, "down")
func parseDoToken(token string) (int, string) {
	token = strings.ToLower(token)

	// 找到第一个非数字字符的位置
	i := 0
	for i < len(token) && token[i] >= '0' && token[i] <= '9' {
		i++
	}

	// 没有数字前缀
	if i == 0 {
		return 1, token
	}
	// 纯数字（如 "1" "2" "3"）→ 当作字面按键
	if i == len(token) {
		return 1, token
	}

	n := 0
	fmt.Sscanf(token[:i], "%d", &n)
	if n < 1 {
		n = 1
	}
	if n > 20 { // 安全上限
		n = 20
	}
	return n, token[i:]
}

// doActionMap 动作 → tmux 按键 + 显示名
var doActionMap = map[string]struct {
	keys    []string
	display string
}{
	"d":     {[]string{"Down"}, "↓"},
	"down":  {[]string{"Down"}, "↓"},
	"u":     {[]string{"Up"}, "↑"},
	"up":    {[]string{"Up"}, "↑"},
	"l":     {[]string{"Left"}, "←"},
	"left":  {[]string{"Left"}, "←"},
	"r":     {[]string{"Right"}, "→"},
	"right": {[]string{"Right"}, "→"},
	"sp":    {[]string{"Space"}, "␣"},
	"space": {[]string{"Space"}, "␣"},
	"ok":    {[]string{"Enter"}, "↵"},
	"enter": {[]string{"Enter"}, "↵"},
	"tab":   {[]string{"Tab"}, "⇥"},
	"esc":   {[]string{"Escape"}, "⎋"},
	"y":     {[]string{"y", "Enter"}, "y↵"},
	"n":     {[]string{"n", "Enter"}, "n↵"},
	// 数字选项：发送数字 + 回车
	"1": {[]string{"1", "Enter"}, "1↵"},
	"2": {[]string{"2", "Enter"}, "2↵"},
	"3": {[]string{"3", "Enter"}, "3↵"},
	"4": {[]string{"4", "Enter"}, "4↵"},
	"5": {[]string{"5", "Enter"}, "5↵"},
}

func mapDoAction(action string) ([]string, string, bool) {
	if m, ok := doActionMap[action]; ok {
		return m.keys, m.display, true
	}
	return nil, "", false
}

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf8"
)

// --- Feishu Card JSON structures (schema 2.0) ---

type feishuCard struct {
	Schema string      `json:"schema"`
	Config cardConfig  `json:"config"`
	Header *cardHeader `json:"header,omitempty"`
	Body   cardBody    `json:"body"`
}

type cardBody struct {
	Elements []cardElement `json:"elements"`
}

type cardConfig struct {
	WideScreenMode bool `json:"wide_screen_mode"`
}

type cardHeader struct {
	Title    cardText `json:"title"`
	Template string   `json:"template"` // blue, green, red, orange, purple, indigo, grey
}

type cardText struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

// cardElement supports three element types:
//   - markdown: {tag:"markdown", content:"..."}
//   - hr:       {tag:"hr"}
//   - note:     已废弃(schema V2 不支持)，改用 markdown + 斜体替代
type cardElement struct {
	Tag      string     `json:"tag"`
	Content  string     `json:"content,omitempty"`  // for markdown
	Elements []cardText `json:"elements,omitempty"` // for note
}

// buildCard assembles a schema 2.0 Feishu interactive card JSON.
func buildCard(title, color string, elements []cardElement) string {
	if len(elements) == 0 {
		elements = []cardElement{{Tag: "markdown", Content: " "}}
	}
	card := feishuCard{
		Schema: "2.0",
		Config: cardConfig{WideScreenMode: true},
		Body:   cardBody{Elements: elements},
	}
	if title != "" {
		card.Header = &cardHeader{
			Title:    cardText{Tag: "plain_text", Content: title},
			Template: color,
		}
	}
	data, err := json.Marshal(card)
	if err != nil {
		log.Printf("card json marshal error: %v", err)
		fallback := feishuCard{
			Schema: "2.0",
			Config: cardConfig{WideScreenMode: true},
			Body:   cardBody{Elements: []cardElement{{Tag: "markdown", Content: "消息渲染失败"}}},
		}
		data, _ = json.Marshal(fallback)
	}
	return string(data)
}

// BuildCardJSON builds a card with a single markdown content block.
func BuildCardJSON(title, body, color string) string {
	elements := []cardElement{
		{Tag: "markdown", Content: body},
	}
	return buildCard(title, color, elements)
}

// TextToCard converts command response text into a structured Feishu card.
//   - Extracts first line as card header
//   - Splits body into sections by emoji-prefixed lines
//   - Renders each section as a markdown element with hr dividers
//   - Detects footer-like content (timestamps, hints) and renders as note element
func TextToCard(text string) string {
	if strings.TrimSpace(text) == "" {
		return BuildCardJSON("ChatCC", " ", "blue")
	}

	// Split into title (first line) and body (rest)
	lines := strings.SplitN(text, "\n", 2)
	titleLine := strings.TrimSpace(lines[0])
	body := ""
	if len(lines) > 1 {
		body = lines[1]
	}

	// Remove decorative lines
	body = strings.TrimSpace(body)
	body = strings.TrimPrefix(body, "━━━━━━━━━━━━━━━━━━━━")
	body = strings.TrimSpace(body)

	cleanTitle := stripEmoji(titleLine)
	if cleanTitle == "" {
		cleanTitle = titleLine
	}
	color := inferCardColor(text)

	// Short single-line response → compact card without header
	if body == "" {
		return BuildCardJSON("", titleLine, color)
	}

	// Parse body into sections by emoji-prefixed headers
	sections := parseSections(body)

	// Build card elements: markdown sections separated by hr
	var elements []cardElement
	lastIdx := len(sections) - 1
	for i, section := range sections {
		if i > 0 {
			elements = append(elements, cardElement{Tag: "hr"})
		}
		// Last section: check if it's a footer (timestamp, hint)
		if i == lastIdx && isFooterSection(section) {
			elements = append(elements, cardElement{
				Tag:     "markdown",
				Content: "*" + strings.TrimSpace(section) + "*",
			})
		} else {
			elements = append(elements, cardElement{
				Tag:     "markdown",
				Content: formatSection(section),
			})
		}
	}

	return buildCard(cleanTitle, color, elements)
}

// isFooterSection detects footer-like content (timestamps, usage hints).
// Only short sections (≤2 non-empty lines) qualify.
func isFooterSection(section string) bool {
	trimmed := strings.TrimSpace(section)
	nonEmpty := 0
	for _, l := range strings.Split(trimmed, "\n") {
		if strings.TrimSpace(l) != "" {
			nonEmpty++
		}
	}
	if nonEmpty > 2 {
		return false
	}
	if strings.Contains(trimmed, "⏱️") {
		return true
	}
	if strings.HasPrefix(trimmed, "输入") && strings.Contains(trimmed, "/") {
		return true
	}
	return false
}

// parseSections splits text into sections by emoji-prefixed header lines.
// Each emoji-prefixed non-indented line starts a new section.
func parseSections(text string) []string {
	lines := strings.Split(text, "\n")
	var sections []string
	var current []string

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		isHeader := trimmed != "" &&
			!strings.HasPrefix(line, " ") &&
			!strings.HasPrefix(line, "\t") &&
			hasLeadingEmoji(trimmed)

		if isHeader && len(current) > 0 {
			sec := strings.TrimSpace(strings.Join(current, "\n"))
			if sec != "" {
				sections = append(sections, sec)
			}
			current = []string{line}
		} else {
			current = append(current, line)
		}
	}

	if len(current) > 0 {
		sec := strings.TrimSpace(strings.Join(current, "\n"))
		if sec != "" {
			sections = append(sections, sec)
		}
	}

	return sections
}

// formatSection formats a text section for Feishu markdown rendering.
//   - Emoji-prefixed headers are bolded
//   - Command definitions (/cmd ...) get the command name bolded
//   - Decorative lines are stripped
func formatSection(text string) string {
	text = strings.ReplaceAll(text, "━━━━━━━━━━━━━━━━━━━━", "")

	lines := strings.Split(text, "\n")
	var result []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			result = append(result, "")
			continue
		}
		// Emoji-prefixed headers → bold
		if !strings.HasPrefix(trimmed, " ") && hasLeadingEmoji(trimmed) {
			result = append(result, "**"+trimmed+"**")
			continue
		}
		// Indented command definitions: /cmd args → bold the /command name
		if strings.HasPrefix(trimmed, "/") {
			indent := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
			result = append(result, indent+boldCommandName(trimmed))
			continue
		}
		result = append(result, line)
	}
	return strings.Join(result, "\n")
}

// boldCommandName bolds the /command portion of a command definition line.
// e.g. "/ask <提示词>  无状态问答" → "**/ask** <提示词>  无状态问答"
func boldCommandName(line string) string {
	idx := strings.IndexByte(line, ' ')
	if idx < 0 {
		return "**" + line + "**"
	}
	return "**" + line[:idx] + "**" + line[idx:]
}

// inferCardColor detects appropriate card color from content keywords.
func inferCardColor(text string) string {
	switch {
	case strings.Contains(text, "错误") || strings.Contains(text, "失败") || strings.Contains(text, "未知命令"):
		return "red"
	case strings.Contains(text, "✅") || strings.Contains(text, "成功") || strings.Contains(text, "完成"):
		return "green"
	case strings.Contains(text, "⚠️") || strings.Contains(text, "警告"):
		return "orange"
	case strings.Contains(text, "📊") || strings.Contains(text, "状态"):
		return "indigo"
	case strings.Contains(text, "📋") || strings.Contains(text, "帮助") || strings.Contains(text, "命令列表"):
		return "blue"
	case strings.Contains(text, "⌨️"):
		return "purple"
	case strings.Contains(text, "🔒") || strings.Contains(text, "⚡") || strings.Contains(text, "danger"):
		return "orange"
	default:
		return "blue"
	}
}

// stripEmoji removes leading emoji characters from a string.
func stripEmoji(s string) string {
	runes := []rune(s)
	start := 0
	for start < len(runes) {
		r := runes[start]
		if r > 0x1F000 || (r >= 0x2600 && r <= 0x27BF) || (r >= 0xFE00 && r <= 0xFE0F) || r == 0x200D || r == 0x20E3 {
			start++
			continue
		}
		if r == ' ' && start > 0 {
			start++
			continue
		}
		break
	}
	if start >= len(runes) {
		return s
	}
	return string(runes[start:])
}

// hasLeadingEmoji checks if a line starts with an emoji character.
func hasLeadingEmoji(s string) bool {
	if s == "" {
		return false
	}
	r := []rune(s)[0]
	return r > 0x1F000 || (r >= 0x2600 && r <= 0x27BF)
}

// MaxCardBodyRunes is the max rune count per card body.
const MaxCardBodyRunes = 3000

// BuildLiveTerminalCard 构建实况终端卡片（用于 LiveStreamer 原地刷新）
// 包含终端最后 N 行输出，检测到交互提示时追加操作提示栏
func BuildLiveTerminalCard(sessionLabel, content, promptHint string) string {
	var elements []cardElement

	// 终端内容（代码块）
	if content != "" {
		elements = append(elements, cardElement{
			Tag:     "markdown",
			Content: fmt.Sprintf("```\n%s\n```", content),
		})
	} else {
		elements = append(elements, cardElement{
			Tag:     "markdown",
			Content: "*(等待输出...)*",
		})
	}

	// 交互提示栏（检测到 [Y/n] 等时显示）
	if promptHint != "" {
		elements = append(elements, cardElement{Tag: "hr"})
		elements = append(elements, cardElement{
			Tag:     "markdown",
			Content: promptHint,
		})
	}

	// 时间戳 footer（schema V2 不支持 note，用 markdown 斜体替代）
	elements = append(elements, cardElement{
		Tag:     "markdown",
		Content: fmt.Sprintf("*更新于 %s · /s 发消息 · /do 组合键*", time.Now().Format("15:04:05")),
	})

	title := "📺 实况终端"
	if sessionLabel != "" {
		title = fmt.Sprintf("📺 %s", sessionLabel)
	}

	return buildCard(title, "indigo", elements)
}

// BuildSessionCompleteCard 构建「会话任务完成」通知卡片
// 绿色头部，包含工作目录、耗时、最后若干行输出
func BuildSessionCompleteCard(sessionLabel, cwd, tail string, duration time.Duration) string {
	// 元信息行
	metaParts := []string{}
	if sessionLabel != "" {
		metaParts = append(metaParts, fmt.Sprintf("🏷 **%s**", sessionLabel))
	}
	if cwd != "" {
		metaParts = append(metaParts, fmt.Sprintf("📁 `%s`", cwd))
	}
	if duration > 0 {
		metaParts = append(metaParts, fmt.Sprintf("⏱ %s", formatDurationShort(duration)))
	}
	metaLine := strings.Join(metaParts, "  ·  ")

	elements := []cardElement{
		{Tag: "markdown", Content: metaLine},
	}

	// 截取最后 20 行输出作为摘要
	tail = strings.TrimSpace(stripANSI(tail))
	if tail != "" {
		lines := strings.Split(tail, "\n")
		if len(lines) > 20 {
			lines = lines[len(lines)-20:]
		}
		// 限制每行最长 200 字符
		for i, l := range lines {
			if utf8.RuneCountInString(l) > 200 {
				runes := []rune(l)
				lines[i] = string(runes[:200]) + "…"
			}
		}
		summary := strings.Join(lines, "\n")
		elements = append(elements, cardElement{Tag: "hr"})
		elements = append(elements, cardElement{
			Tag:     "markdown",
			Content: fmt.Sprintf("**📋 最后输出**\n```\n%s\n```", summary),
		})
	}

	// footer（schema V2 不支持 note，用 markdown 斜体替代）
	elements = append(elements, cardElement{
		Tag:     "markdown",
		Content: fmt.Sprintf("*于 %s 完成 · 使用 /s 继续对话*", time.Now().Format("2006-01-02 15:04:05")),
	})

	return buildCard("✅ 会话已完成", "green", elements)
}

// formatDurationShort 格式化 duration 为短文本
func formatDurationShort(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.0fs", d.Seconds())
	}
	if d < time.Hour {
		m := int(d.Minutes())
		s := int(d.Seconds()) % 60
		if s == 0 {
			return fmt.Sprintf("%dm", m)
		}
		return fmt.Sprintf("%dm%ds", m, s)
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	return fmt.Sprintf("%dh%dm", h, m)
}

// TextToCardChunks splits long text into multiple structured card JSON strings.
func TextToCardChunks(text string, maxBodyRunes int) []string {
	if maxBodyRunes <= 0 {
		maxBodyRunes = MaxCardBodyRunes
	}
	if utf8.RuneCountInString(text) <= maxBodyRunes {
		return []string{TextToCard(text)}
	}

	// Extract title
	lines := strings.SplitN(text, "\n", 2)
	titleLine := strings.TrimSpace(lines[0])
	cleanTitle := stripEmoji(titleLine)
	if cleanTitle == "" {
		cleanTitle = titleLine
	}
	color := inferCardColor(text)

	body := ""
	if len(lines) > 1 {
		body = strings.TrimSpace(lines[1])
		body = strings.TrimPrefix(body, "━━━━━━━━━━━━━━━━━━━━")
		body = strings.TrimSpace(body)
	}

	// Split body into size-limited chunks
	bodyChunks := splitIntoChunks(body, maxBodyRunes)
	var cards []string
	for i, chunk := range bodyChunks {
		title := cleanTitle
		if len(bodyChunks) > 1 {
			title = fmt.Sprintf("%s [%d/%d]", cleanTitle, i+1, len(bodyChunks))
		}
		// Each chunk gets section formatting
		sections := parseSections(chunk)
		var elements []cardElement
		for j, section := range sections {
			if j > 0 {
				elements = append(elements, cardElement{Tag: "hr"})
			}
			elements = append(elements, cardElement{
				Tag:     "markdown",
				Content: formatSection(section),
			})
		}
		cards = append(cards, buildCard(title, color, elements))
	}
	return cards
}

// BuildPromptWaitingCard 构建「会话等待输入」通知卡片
// 橙色头部，包含提示文本和快捷命令说明
func BuildPromptWaitingCard(sessionLabel, tail, promptType string) string {
	var elements []cardElement

	// 提示文本：提取最后几行
	tail = strings.TrimSpace(stripANSI(tail))
	if tail != "" {
		lines := strings.Split(tail, "\n")
		// 只取最后 10 行
		if len(lines) > 10 {
			lines = lines[len(lines)-10:]
		}
		promptText := strings.Join(lines, "\n")
		elements = append(elements, cardElement{
			Tag:     "markdown",
			Content: fmt.Sprintf("```\n%s\n```", promptText),
		})
	}

	elements = append(elements, cardElement{Tag: "hr"})

	// 根据提示类型调整快捷命令展示
	var quickHelp string
	switch promptType {
	case "yn":
		quickHelp = "**💬 快捷回复：**\n" +
			"`/y` 允许  ·  `/n` 拒绝  ·  `/esc` 取消\n" +
			"或使用 `/s <自定义回复>` 发送任意文本"
	case "menu":
		quickHelp = "**💬 快捷回复：**\n" +
			"`/1` 选项1  ·  `/2` 选项2  ·  `/3` 选项3\n" +
			"`/enter` 确认  ·  `/esc` 取消\n" +
			"或使用 `/s <自定义回复>` 发送任意文本"
	case "enter":
		quickHelp = "**💬 快捷回复：**\n" +
			"`/enter` 继续  ·  `/esc` 取消\n" +
			"或使用 `/s <自定义回复>` 发送任意文本"
	default: // "generic"
		quickHelp = "**💬 快捷回复：**\n" +
			"`/y` 允许  ·  `/n` 拒绝  ·  `/enter` 回车  ·  `/esc` 取消\n" +
			"`/1` `/2` `/3` 数字选项  ·  `/tab` Tab\n" +
			"或使用 `/s <自定义回复>` 发送任意文本"
	}
	elements = append(elements, cardElement{
		Tag:     "markdown",
		Content: quickHelp,
	})

	title := "⌨️ 等待输入"
	if sessionLabel != "" {
		title = fmt.Sprintf("⌨️ 会话 %s 等待输入", sessionLabel)
	}

	return buildCard(title, "orange", elements)
}

// detectPromptType 根据 pane 内容推断交互提示类型
// 返回: "yn" | "enter" | "menu" | "generic"
func detectPromptType(content string) string {
	cleaned := stripANSI(content)
	lines := strings.Split(cleaned, "\n")
	if len(lines) == 0 {
		return "generic"
	}

	// 取最后 5 行用于分析
	checkLines := 5
	if len(lines) < checkLines {
		checkLines = len(lines)
	}
	lastLines := strings.ToLower(strings.Join(lines[len(lines)-checkLines:], "\n"))

	// y/n 类提示（含 Claude Code 专属格式）
	ynPatterns := []string{
		"(y/n)", "[y/n]", "(yes/no)", "[yes/no]",
		"continue? [y/n", "proceed? [y/n",
		"are you sure?", "y or n", "yes or no",
		"yes (y) / no (n)", "allow once", "allow?",
		"deny (n)", "do you trust", "yes / no",
	}
	for _, p := range ynPatterns {
		if strings.Contains(lastLines, p) {
			return "yn"
		}
	}

	// 数字选项菜单
	menuPatterns := []string{"1.", "1)", "1:"}
	for _, p := range menuPatterns {
		if strings.Contains(lastLines, p) && (strings.Contains(lastLines, "2.") || strings.Contains(lastLines, "2)") || strings.Contains(lastLines, "2:")) {
			return "menu"
		}
	}

	// press enter 类
	enterPatterns := []string{
		"press enter", "continue", "press any key",
	}
	for _, p := range enterPatterns {
		if strings.Contains(lastLines, p) {
			return "enter"
		}
	}

	return "generic"
}

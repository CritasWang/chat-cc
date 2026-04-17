package commands

import "encoding/json"

// 本文件提供 commands 包内使用的飞书卡片 schema 2.0 构造器，
// 与主包 card.go 保持结构同构（两份代码独立演进、避免循环依赖）。
// 命令返回 CardJSONMarker + JSON 后由 main 包直接发送。

type cuText struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

type cuBehavior struct {
	Type  string                 `json:"type"`            // callback / open_url
	Value map[string]interface{} `json:"value,omitempty"` // 回调 payload
	URL   string                 `json:"url,omitempty"`
}

type cuElement struct {
	Tag      string   `json:"tag"`
	Content  string   `json:"content,omitempty"` // markdown
	Elements []cuText `json:"elements,omitempty"`

	// button
	Text      *cuText      `json:"text,omitempty"`
	Type      string       `json:"type,omitempty"` // default/primary/danger/primary_filled
	Size      string       `json:"size,omitempty"`
	Width     string       `json:"width,omitempty"`
	Behaviors []cuBehavior `json:"behaviors,omitempty"`

	// column_set (schema 2.0 用于按钮横向排布，action 已弃用)
	Columns           []cuColumn `json:"columns,omitempty"`
	FlexMode          string     `json:"flex_mode,omitempty"`
	HorizontalSpacing string     `json:"horizontal_spacing,omitempty"`
}

type cuColumn struct {
	Tag           string      `json:"tag"` // "column"
	Width         string      `json:"width,omitempty"`
	Weight        int         `json:"weight,omitempty"`
	VerticalAlign string      `json:"vertical_align,omitempty"`
	Elements      []cuElement `json:"elements"`
}

type cuCard struct {
	Schema string `json:"schema"`
	Config struct {
		WideScreenMode bool `json:"wide_screen_mode"`
	} `json:"config"`
	Header *cuHeader `json:"header,omitempty"`
	Body   struct {
		Elements []cuElement `json:"elements"`
	} `json:"body"`
}

type cuHeader struct {
	Title    cuText `json:"title"`
	Template string `json:"template"`
}

const (
	btnStyleDefault = "default"
	btnStylePrimary = "primary"
	btnStyleDanger  = "danger"
	btnStyleFilled  = "primary_filled"
)

// cuBuild 组装一张卡片为 JSON 字符串
func cuBuild(title, color string, elements []cuElement) string {
	c := cuCard{Schema: "2.0"}
	c.Config.WideScreenMode = true
	if title != "" {
		c.Header = &cuHeader{
			Title:    cuText{Tag: "plain_text", Content: title},
			Template: color,
		}
	}
	c.Body.Elements = elements
	data, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	return string(data)
}

// cuBtn 构造带 callback 行为的按钮
func cuBtn(text, style string, value map[string]interface{}) cuElement {
	if style == "" {
		style = btnStyleDefault
	}
	return cuElement{
		Tag:   "button",
		Text:  &cuText{Tag: "plain_text", Content: text},
		Type:  style,
		Size:  "medium",
		Width: "default",
		Behaviors: []cuBehavior{
			{Type: "callback", Value: value},
		},
	}
}

// cuBtnRow 一行按钮组（schema 2.0 用 column_set，action 标签已弃用）
func cuBtnRow(buttons ...cuElement) cuElement {
	columns := make([]cuColumn, len(buttons))
	for i, b := range buttons {
		columns[i] = cuColumn{
			Tag:           "column",
			Width:         "weighted",
			Weight:        1,
			VerticalAlign: "center",
			Elements:      []cuElement{b},
		}
	}
	return cuElement{
		Tag:               "column_set",
		FlexMode:          "wrap",
		HorizontalSpacing: "8px",
		Columns:           columns,
	}
}

// cuCmdBtn 点击后触发命令（由回调路由 /cmd args 分发）
func cuCmdBtn(label, style, cmd, args string) cuElement {
	return cuBtn(label, style, map[string]interface{}{
		"cmd":  cmd,
		"args": args,
	})
}

// cuCmdBtnRefresh 触发命令并在完成后刷新原卡片
func cuCmdBtnRefresh(label, style, cmd, args, refreshKind string) cuElement {
	return cuBtn(label, style, map[string]interface{}{
		"cmd":     cmd,
		"args":    args,
		"refresh": refreshKind,
	})
}

// cuKeyBtn 发送单个按键并 Toast 反馈（不落地消息）
func cuKeyBtn(label, keyName, echo string) cuElement {
	return cuBtn(label, btnStyleDefault, map[string]interface{}{
		"cmd":    "key",
		"args":   keyName,
		"silent": true,
		"echo":   echo,
	})
}

// cuToastBtn 纯 Toast 按钮（不触发命令）
func cuToastBtn(label, style, toast string) cuElement {
	return cuBtn(label, style, map[string]interface{}{
		"echo":   toast,
		"silent": true,
	})
}

// cuMD 快捷构造 markdown 元素
func cuMD(content string) cuElement {
	return cuElement{Tag: "markdown", Content: content}
}

// cuHr 分割线
func cuHr() cuElement { return cuElement{Tag: "hr"} }

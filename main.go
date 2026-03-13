package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"

	"chatcc/commands"
)

// sessionManagerAdapter 适配器，将 SessionManager 转换为 commands.SessionManagerIface（用于 status 命令）
type sessionManagerAdapter struct {
	sm *SessionManager
}

func (a *sessionManagerAdapter) ListSessions() []commands.SessionInfo {
	sessions := a.sm.ListSessions()
	result := make([]commands.SessionInfo, 0, len(sessions))
	for _, s := range sessions {
		result = append(result, commands.SessionInfo{
			Name:      s.Name,
			CWD:       s.CWD,
			CreatedAt: s.CreatedAt,
			Active:    s.Active,
		})
	}
	return result
}

// sessionCommandAdapter 适配器，将 SessionManager 转换为 commands.SessionIface（用于 session 命令）
type sessionCommandAdapter struct {
	sm *SessionManager
}

func (a *sessionCommandAdapter) Start(key, cwd string) error {
	return a.sm.Start(key, cwd)
}

func (a *sessionCommandAdapter) Send(key, message string) (string, error) {
	return a.sm.Send(key, message)
}

func (a *sessionCommandAdapter) Stop(key string) error {
	return a.sm.Stop(key)
}

func (a *sessionCommandAdapter) GetSession(key string) (commands.SessionInfo, bool) {
	return a.sm.GetSessionByKey(key)
}

func (a *sessionCommandAdapter) ListAllSessions() []commands.SessionInfo {
	return a.sm.ListAllSessions()
}

func (a *sessionCommandAdapter) KillByName(name string) error {
	return a.sm.KillByName(name)
}

func (a *sessionCommandAdapter) SendKeys(key string, tmuxKeys ...string) error {
	return a.sm.SendKeys(key, tmuxKeys...)
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	subcmd := os.Args[1]
	if subcmd == "-h" || subcmd == "--help" || subcmd == "help" {
		printUsage()
		return
	}

	fs := flag.NewFlagSet(subcmd, flag.ExitOnError)
	configPath := fs.String("config", "config.yaml", "配置文件路径")
	logDirFlag := fs.String("log-dir", "", "日志目录")
	fs.Parse(os.Args[2:])

	switch subcmd {
	case "start":
		if err := daemonStart(*configPath); err != nil {
			fmt.Fprintf(os.Stderr, "错误: %v\n", err)
			os.Exit(1)
		}
	case "stop":
		if err := daemonStop(); err != nil {
			fmt.Fprintf(os.Stderr, "错误: %v\n", err)
			os.Exit(1)
		}
	case "restart":
		if err := daemonRestart(*configPath); err != nil {
			fmt.Fprintf(os.Stderr, "错误: %v\n", err)
			os.Exit(1)
		}
	case "reload":
		if err := daemonReload(); err != nil {
			fmt.Fprintf(os.Stderr, "错误: %v\n", err)
			os.Exit(1)
		}
	case "status":
		daemonStatus()
	case "console":
		runBot(*configPath, *logDirFlag)
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n\n", subcmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("用法: chatcc <命令> [选项]")
	fmt.Println()
	fmt.Println("命令:")
	fmt.Println("  start     后台启动（日志写入 logs/ 目录）")
	fmt.Println("  stop      停止后台进程")
	fmt.Println("  restart   重启后台进程")
	fmt.Println("  reload    热重载配置（无需重启）")
	fmt.Println("  status    查看运行状态")
	fmt.Println("  console   前台运行（日志输出到终端，调试用）")
	fmt.Println("  help      显示帮助信息")
	fmt.Println()
	fmt.Println("选项:")
	fmt.Println("  --config <path>   配置文件路径（默认: config.yaml）")
	fmt.Println()
	fmt.Println("示例:")
	fmt.Println("  chatcc start --config config.local.yaml")
	fmt.Println("  chatcc stop")
	fmt.Println("  chatcc console --config config.local.yaml")
}

func runBot(configPath, logDir string) {
	// 配置日志输出
	if logDir != "" {
		w, err := NewDailyRotateWriter(logDir, "chatcc")
		if err != nil {
			log.Fatalf("初始化日志失败: %v", err)
		}
		defer w.Close()
		log.SetOutput(w)
	}

	// 加载配置
	cfg, err := LoadConfig(configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// 验证必要配置
	if cfg.AppID == "" || cfg.AppSecret == "" {
		if id := os.Getenv("FEISHU_APP_ID"); id != "" {
			cfg.AppID = id
		}
		if secret := os.Getenv("FEISHU_APP_SECRET"); secret != "" {
			cfg.AppSecret = secret
		}
		if cfg.AppID == "" || cfg.AppSecret == "" {
			log.Fatal("请配置 app_id 和 app_secret（配置文件或环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）")
		}
	}

	// 创建飞书 API 客户端
	larkClient := lark.NewClient(cfg.AppID, cfg.AppSecret)

	// 创建各模块
	replier := NewReplier(larkClient)
	// askCmd 需要先创建，以便 SessionManager 可以查询运行时 danger 模式
	askCmd := commands.NewAskCommand(commands.AskConfig{
		ClaudeBin:      cfg.ClaudeBin,
		DefaultCWD:     cfg.DefaultCWD,
		AllowedTools:   cfg.ClaudeAllowedTools,
		DangerMode:     cfg.ClaudeDangerMode,
		TimeoutMinutes: cfg.ClaudeAskTimeout,
		ResolveCWD:     cfg.ResolveCWD,
	})
	sessionMgr := NewSessionManager(cfg, askCmd.IsDangerMode)
	router := NewRouter()
	hookServer := NewHookServer(cfg.HookPort, replier, cfg.NotifyChatID)

	// 创建会话管理器适配器
	sessionAdapter := &sessionManagerAdapter{sm: sessionMgr}

	// 注册命令
	helpCmd := commands.NewHelpCommand()
	shellCmd := commands.NewShellCommand(cfg.ShellWhitelist)

	// 创建会话命令适配器
	sessionCmdAdapter := &sessionCommandAdapter{sm: sessionMgr}

	router.Register(askCmd)
	router.Register(commands.NewSessionCommand(sessionCmdAdapter))
	router.Register(commands.NewSendCommand(sessionCmdAdapter))
	router.Register(commands.NewKeyCommand(sessionCmdAdapter))
	router.Register(shellCmd)
	statusCmd := commands.NewStatusCommand(cfg, sessionAdapter, askCmd)
	router.Register(statusCmd)
	router.Register(commands.NewProjectCommand(cfg))
	router.Register(commands.NewDangerCommand(askCmd))

	// 创建定时状态推送器
	statusPusher := NewStatusPusher(replier, func() (string, error) {
		return statusCmd.Execute(context.Background(), "", nil)
	})
	pushChatID := cfg.StatusPushChatID
	if pushChatID == "" {
		pushChatID = cfg.NotifyChatID
	}
	statusPusher.Configure(cfg.StatusPushInterval, pushChatID)

	// 热重载
	reloadFn := func() (string, error) {
		newCfg, err := LoadConfig(configPath)
		if err != nil {
			return "", fmt.Errorf("读取配置失败: %w", err)
		}
		// 更新各组件（app_id/app_secret/hook_port 需要重启）
		cfg.AllowedUsers = newCfg.AllowedUsers
		cfg.AllowedChats = newCfg.AllowedChats
		cfg.Projects = newCfg.Projects
		cfg.LogLevel = newCfg.LogLevel
		cfg.ClaudeAskTimeout = newCfg.ClaudeAskTimeout
		cfg.ClaudeSessionTimeout = newCfg.ClaudeSessionTimeout
		cfg.MaxChunkSize = newCfg.MaxChunkSize
		askCmd.UpdateConfig(newCfg.ClaudeBin, newCfg.DefaultCWD, newCfg.ClaudeAllowedTools, newCfg.ClaudeDangerMode, newCfg.ClaudeAskTimeout)
		shellCmd.SetWhitelist(newCfg.ShellWhitelist)
		hookServer.SetDefaultChatID(newCfg.NotifyChatID)
		// 热重载定时推送配置
		newPushChatID := newCfg.StatusPushChatID
		if newPushChatID == "" {
			newPushChatID = newCfg.NotifyChatID
		}
		statusPusher.Configure(newCfg.StatusPushInterval, newPushChatID)
		log.Println("配置已热重载")
		return "✅ 配置已重载\n\n已更新: 用户白名单、群聊白名单、项目别名、Claude 工具、超时设置、分块配置、Shell 白名单、通知目标、定时推送\n⚠️ app_id/app_secret/hook_port 变更需要 restart", nil
	}
	router.Register(commands.NewReloadCommand(reloadFn))
	router.Register(helpCmd)

	helpCmd.SetCommands(router.AllCommands())

	// 启动 Hook HTTP 服务
	hookServer.Start()

	// 创建飞书事件处理器
	eventHandler := NewEventHandler(cfg, router, replier)

	// WebSocket 客户端
	wsLogLevel := larkcore.LogLevelInfo
	if cfg.LogLevel == "debug" {
		wsLogLevel = larkcore.LogLevelDebug
	}

	wsClient := larkws.NewClient(cfg.AppID, cfg.AppSecret,
		larkws.WithEventHandler(eventHandler),
		larkws.WithLogLevel(wsLogLevel),
	)

	// 优雅关闭
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)

	go func() {
		for sig := range sigCh {
			if sig == syscall.SIGHUP {
				reloadFn()
				continue
			}
			log.Println("正在关闭...")
			statusPusher.Stop()
			cancel()
			time.Sleep(2 * time.Second)
			os.Exit(0)
		}
	}()

	// 启动
	log.Println("飞书机器人启动中...")
	log.Printf("  App ID: %s", cfg.AppID[:8]+"...")
	log.Printf("  Hook 端口: %d", cfg.HookPort)
	log.Printf("  默认工作目录: %s", cfg.DefaultCWD)
	log.Printf("  Claude 权限模式: %s", func() string {
		if cfg.ClaudeDangerMode {
			return "danger (全部放行)"
		}
		return fmt.Sprintf("白名单 (%d 个工具)", len(cfg.ClaudeAllowedTools))
	}())
	if cfg.StatusPushInterval > 0 && pushChatID != "" {
		log.Printf("  定时推送: 每 %d 分钟 → %s", cfg.StatusPushInterval, pushChatID)
	} else {
		log.Println("  定时推送: 已禁用")
	}

	if err := wsClient.Start(ctx); err != nil {
		log.Fatalf("WebSocket 连接失败: %v", err)
	}
}

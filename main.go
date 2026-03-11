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

	"feishu-bot/commands"
)

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
	fmt.Println("用法: feishu-bot <命令> [选项]")
	fmt.Println()
	fmt.Println("命令:")
	fmt.Println("  start     后台启动（日志写入 logs/ 目录）")
	fmt.Println("  stop      停止后台进程")
	fmt.Println("  restart   重启后台进程")
	fmt.Println("  status    查看运行状态")
	fmt.Println("  console   前台运行（日志输出到终端，调试用）")
	fmt.Println("  help      显示帮助信息")
	fmt.Println()
	fmt.Println("选项:")
	fmt.Println("  --config <path>   配置文件路径（默认: config.yaml）")
	fmt.Println()
	fmt.Println("示例:")
	fmt.Println("  feishu-bot start --config config.local.yaml")
	fmt.Println("  feishu-bot stop")
	fmt.Println("  feishu-bot console --config config.local.yaml")
}

func runBot(configPath, logDir string) {
	// 配置日志输出
	if logDir != "" {
		w, err := NewDailyRotateWriter(logDir, "feishu-bot")
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
	sessionMgr := NewSessionManager(cfg)
	router := NewRouter()
	hookServer := NewHookServer(cfg.HookPort, replier, cfg.NotifyChatID)

	// 注册命令
	helpCmd := commands.NewHelpCommand()
	askCmd := commands.NewAskCommand(commands.AskConfig{
		ClaudeBin:    cfg.ClaudeBin,
		DefaultCWD:   cfg.DefaultCWD,
		AllowedTools: cfg.ClaudeAllowedTools,
		DangerMode:   cfg.ClaudeDangerMode,
		ResolveCWD:   cfg.ResolveCWD,
	})
	shellCmd := commands.NewShellCommand(cfg.ShellWhitelist)

	router.Register(askCmd)
	router.Register(commands.NewSessionCommand(sessionMgr))
	router.Register(commands.NewSendCommand(sessionMgr))
	router.Register(shellCmd)
	router.Register(commands.NewStatusCommand())
	router.Register(commands.NewDangerCommand(askCmd))

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
		askCmd.UpdateConfig(newCfg.ClaudeBin, newCfg.DefaultCWD, newCfg.ClaudeAllowedTools, newCfg.ClaudeDangerMode)
		shellCmd.SetWhitelist(newCfg.ShellWhitelist)
		hookServer.SetDefaultChatID(newCfg.NotifyChatID)
		log.Println("配置已热重载")
		return "✅ 配置已重载\n\n已更新: 用户白名单、群聊白名单、项目别名、Claude 工具、Shell 白名单、通知目标\n⚠️ app_id/app_secret/hook_port 变更需要 restart", nil
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

	if err := wsClient.Start(ctx); err != nil {
		log.Fatalf("WebSocket 连接失败: %v", err)
	}
}

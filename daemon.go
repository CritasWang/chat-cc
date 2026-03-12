package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	real, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return filepath.Dir(exe)
	}
	return filepath.Dir(real)
}

func pidFilePath() string {
	return filepath.Join(exeDir(), "chatcc.pid")
}

func defaultLogDir() string {
	return filepath.Join(exeDir(), "logs")
}

func writePID(pid int) error {
	return os.WriteFile(pidFilePath(), []byte(strconv.Itoa(pid)), 0644)
}

func readPID() (int, error) {
	data, err := os.ReadFile(pidFilePath())
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

func isRunning(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func daemonStart(configPath string) error {
	if pid, err := readPID(); err == nil && isRunning(pid) {
		return fmt.Errorf("已在运行中 (PID: %d)", pid)
	}

	absConfig, err := filepath.Abs(configPath)
	if err != nil {
		return fmt.Errorf("解析配置路径失败: %w", err)
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("获取可执行文件路径失败: %w", err)
	}

	logd := defaultLogDir()
	cmd := exec.Command(exe, "console", "--config", absConfig, "--log-dir", logd)
	cmd.Dir = exeDir()
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动失败: %w", err)
	}

	if err := writePID(cmd.Process.Pid); err != nil {
		return fmt.Errorf("写入 PID 文件失败: %w", err)
	}

	fmt.Printf("飞书机器人已启动 (PID: %d)\n", cmd.Process.Pid)
	fmt.Printf("日志目录: %s/\n", logd)
	return nil
}

func daemonStop() error {
	pid, err := readPID()
	if err != nil {
		return fmt.Errorf("未找到 PID 文件，可能未运行")
	}

	if !isRunning(pid) {
		os.Remove(pidFilePath())
		return fmt.Errorf("进程 %d 已不存在，已清理 PID 文件", pid)
	}

	process, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("查找进程失败: %w", err)
	}

	// 发送 SIGTERM
	if err := process.Signal(syscall.SIGTERM); err != nil {
		return fmt.Errorf("发送停止信号失败: %w", err)
	}

	// 等待进程退出，最多 5 秒
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		if !isRunning(pid) {
			os.Remove(pidFilePath())
			fmt.Printf("飞书机器人已停止 (PID: %d)\n", pid)
			return nil
		}
	}

	// 超时，强制杀死
	if err := process.Signal(syscall.SIGKILL); err != nil {
		return fmt.Errorf("强制终止失败: %w", err)
	}

	os.Remove(pidFilePath())
	fmt.Printf("飞书机器人已强制停止 (PID: %d)\n", pid)
	return nil
}

func daemonStatus() {
	pid, err := readPID()
	if err != nil {
		fmt.Println("状态: 未运行")
		return
	}
	if isRunning(pid) {
		fmt.Printf("状态: 运行中 (PID: %d)\n", pid)
		fmt.Printf("日志目录: %s/\n", defaultLogDir())
		fmt.Printf("PID 文件: %s\n", pidFilePath())
	} else {
		fmt.Printf("状态: 已停止 (残留 PID: %d，已清理)\n", pid)
		os.Remove(pidFilePath())
	}
}

func daemonReload() error {
	pid, err := readPID()
	if err != nil {
		return fmt.Errorf("未找到 PID 文件，可能未运行")
	}
	if !isRunning(pid) {
		os.Remove(pidFilePath())
		return fmt.Errorf("进程 %d 已不存在", pid)
	}

	process, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("查找进程失败: %w", err)
	}

	if err := process.Signal(syscall.SIGHUP); err != nil {
		return fmt.Errorf("发送重载信号失败: %w", err)
	}

	fmt.Printf("配置重载信号已发送 (PID: %d)\n", pid)
	return nil
}

func daemonRestart(configPath string) error {
	if pid, err := readPID(); err == nil && isRunning(pid) {
		if err := daemonStop(); err != nil {
			return err
		}
		time.Sleep(500 * time.Millisecond)
	}
	return daemonStart(configPath)
}

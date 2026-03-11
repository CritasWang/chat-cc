package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DailyRotateWriter 按天自动切换日志文件
type DailyRotateWriter struct {
	dir     string
	prefix  string
	mu      sync.Mutex
	file    *os.File
	curDate string
}

func NewDailyRotateWriter(dir, prefix string) (*DailyRotateWriter, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("创建日志目录失败: %w", err)
	}
	w := &DailyRotateWriter{dir: dir, prefix: prefix}
	if err := w.openToday(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *DailyRotateWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	today := time.Now().Format("2006-01-02")
	if today != w.curDate {
		if err := w.openTodayLocked(); err != nil {
			return 0, err
		}
	}
	return w.file.Write(p)
}

func (w *DailyRotateWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file != nil {
		return w.file.Close()
	}
	return nil
}

func (w *DailyRotateWriter) openToday() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.openTodayLocked()
}

func (w *DailyRotateWriter) openTodayLocked() error {
	if w.file != nil {
		w.file.Close()
	}
	today := time.Now().Format("2006-01-02")
	path := filepath.Join(w.dir, fmt.Sprintf("%s-%s.log", w.prefix, today))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("打开日志文件失败: %w", err)
	}
	w.file = f
	w.curDate = today
	return nil
}

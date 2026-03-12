package main

import (
	"compress/gzip"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DailyRotateWriter 日志写入 chatcc.log，跨天自动归档为 chatcc-YYYY-MM-DD.log.gz
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
	w := &DailyRotateWriter{
		dir:    dir,
		prefix: prefix,
	}
	if err := w.openCurrent(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *DailyRotateWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	today := time.Now().Format("2006-01-02")
	if today != w.curDate {
		w.rotateLocked()
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

// openCurrent 打开当前日志文件（追加模式）
func (w *DailyRotateWriter) openCurrent() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	path := filepath.Join(w.dir, w.prefix+".log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("打开日志文件失败: %w", err)
	}
	w.file = f
	w.curDate = time.Now().Format("2006-01-02")
	return nil
}

// rotateLocked 归档昨天的日志并打开新文件（调用方需持有锁）
func (w *DailyRotateWriter) rotateLocked() {
	yesterday := w.curDate
	currentPath := filepath.Join(w.dir, w.prefix+".log")

	// 关闭当前文件
	if w.file != nil {
		w.file.Close()
		w.file = nil
	}

	// 归档: chatcc.log → chatcc-2026-03-11.log.gz
	archiveName := fmt.Sprintf("%s-%s.log", w.prefix, yesterday)
	archivePath := filepath.Join(w.dir, archiveName)
	gzPath := archivePath + ".gz"

	// 重命名为日期文件
	if err := os.Rename(currentPath, archivePath); err != nil {
		log.Printf("日志归档重命名失败: %v", err)
	} else {
		// 压缩
		if err := gzipFile(archivePath, gzPath); err != nil {
			log.Printf("日志压缩失败: %v", err)
		} else {
			os.Remove(archivePath)
		}
	}

	// 打开新的日志文件
	w.curDate = time.Now().Format("2006-01-02")
	f, err := os.OpenFile(currentPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("打开新日志文件失败: %v", err)
		return
	}
	w.file = f
}

// gzipFile 将 src 压缩为 dst (.gz)
func gzipFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	gz := gzip.NewWriter(out)
	gz.Name = filepath.Base(src)
	gz.ModTime = time.Now()

	if _, err := io.Copy(gz, in); err != nil {
		return err
	}
	return gz.Close()
}

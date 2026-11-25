// daemon 启动入口：
// 1) spawn rclone serve s3（存储层子进程，本地目录以原始文件落盘）
// 2) :9000 R2 API（workerd shim 使用）
// 3) :9001 管理平面（状态页 + REST）
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

var errDaemonToken = errors.New("DAEMON_TOKEN 必须配置（shim 访问 R2 API 的 Bearer token）")

// ---- rclone serve s3 生命周期 ----

var currentRclone atomic.Pointer[exec.Cmd]

func rcloneSupervisor(cfg *DaemonConfig) {
	backoff := time.Second
	for {
		args := []string{
			"serve", "s3",
			"--addr", cfg.S3Addr,
			"--dir-cache-time", "5s",
			"--log-level", "ERROR",
			cfg.DataDir, // 根目录 = dataDir；bucket 名 = 其下子目录（与云端 bucket 同名）
		}
		log.Printf("[daemon] spawn: %s %s", cfg.RcloneBin, strings.Join(args, " "))
		cmd := exec.Command(cfg.RcloneBin, args...)
		cmd.Env = append(os.Environ(), "RCLONE_CONFIG="+cfg.RcloneConf)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		currentRclone.Store(cmd)
		if err := cmd.Start(); err != nil {
			log.Printf("[daemon] rclone spawn 失败: %v，%v 后重试", err, backoff)
			time.Sleep(backoff)
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		_ = cmd.Wait()
		log.Printf("[daemon] rclone exited，%v 后重启", backoff)
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func waitForS3(s3 *S3Client, timeout time.Duration) error {
	start := time.Now()
	for {
		if _, err := s3.list(s3ListOpts{MaxKeys: 1}); err == nil {
			return nil
		}
		if time.Since(start) > timeout {
			return fmt.Errorf("rclone serve s3 启动超时")
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// ---- panic 兜底 ----

type statusRecorder struct {
	http.ResponseWriter
	wrote bool
}

func (s *statusRecorder) WriteHeader(code int) {
	s.wrote = true
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.wrote = true
	return s.ResponseWriter.Write(b)
}

func recoverHandler(name string, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w}
		defer func() {
			if p := recover(); p != nil {
				log.Printf("[daemon] %s handler panic: %v", name, p)
				if !rec.wrote {
					writeJSON(rec, 500, map[string]string{"error": fmt.Sprint(p)})
				}
			}
		}()
		next(rec, r)
	})
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("[daemon] fatal: %v", err)
		return
	}
	_ = os.MkdirAll(filepath.Join(cfg.DataDir, cfg.Bucket), 0o755)

	go rcloneSupervisor(cfg)

	s3 := NewS3Client("http://"+cfg.S3Addr, cfg.Bucket)
	if err := waitForS3(s3, 15*time.Second); err != nil {
		log.Fatalf("[daemon] fatal: %v", err)
		return
	}

	sync := NewSyncEngine(cfg)
	r2api := NewR2Api(s3, cfg.Token)
	mgmt := NewMgmtApi(cfg, sync)

	r2Srv := &http.Server{
		Addr: fmt.Sprintf("0.0.0.0:%d", cfg.R2Port),
		Handler: recoverHandler("r2api", func(w http.ResponseWriter, r *http.Request) {
			r2api.handle(w, r, r.URL.EscapedPath())
		}),
	}
	mgmtSrv := &http.Server{
		Addr: fmt.Sprintf("0.0.0.0:%d", cfg.MgmtPort),
		Handler: recoverHandler("mgmt", func(w http.ResponseWriter, r *http.Request) {
			mgmt.handle(w, r, r.URL.EscapedPath())
		}),
	}
	go func() {
		if err := r2Srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[daemon] R2 API 监听失败: %v", err)
		}
	}()
	go func() {
		if err := mgmtSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[daemon] 管理平面监听失败: %v", err)
		}
	}()
	sync.StartScheduler(cfg)

	log.Printf("[daemon] R2 API   : http://0.0.0.0:%d (bucket=%s, dataDir=%s)", cfg.R2Port, cfg.Bucket, cfg.DataDir)
	log.Printf("[daemon] 管理平面 : http://0.0.0.0:%d (账号=%s)", cfg.MgmtPort, cfg.MgmtUser)
	log.Printf("[daemon] 同步     : mode=%s interval=%dmin remote=%s:%s", cfg.SyncMode, cfg.SyncIntervalMin, cfg.Remote, cfg.RemoteBucket)
	if cfg.MgmtPass == "" || cfg.MgmtPass == "admin" {
		log.Printf("[daemon] 警告：管理密码为默认值，请在 .env 设置 DAEMON_MGMT_PASS")
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("[daemon] shutting down")
	if c := currentRclone.Load(); c != nil && c.Process != nil {
		_ = c.Process.Signal(syscall.SIGTERM)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = r2Srv.Shutdown(ctx)
	_ = mgmtSrv.Shutdown(ctx)
	os.Exit(0)
}

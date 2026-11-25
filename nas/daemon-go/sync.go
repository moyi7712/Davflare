// 同步引擎：调度 rclone（push/pull/bisync），本地目录 ↔ 云端 R2。
// rclone 作为子进程被包装，daemon 不重写同步逻辑；bisync 的状态文件由 rclone 自己管理。
package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type SyncRun struct {
	TS         string   `json:"ts"`
	Mode       SyncMode `json:"mode"`
	Exit       *int     `json:"exit"` // null = 仍在运行 / 触发时已在跑
	StdoutTail string   `json:"stdoutTail"`
	StderrTail string   `json:"stderrTail"`
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// tailBuf 保留最近 ~20KB 输出（行级截断，避免截断 UTF-8 字符）
type tailBuf struct {
	mu    sync.Mutex
	lines []string
	total int
}

func (t *tailBuf) add(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lines = append(t.lines, line)
	t.total += len(line) + 1
	for t.total > 20000 && len(t.lines) > 1 {
		t.total -= len(t.lines[0]) + 1
		t.lines = t.lines[1:]
	}
}

func (t *tailBuf) tail(max int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := strings.Join(t.lines, "\n")
	if len(s) > max {
		s = s[len(s)-max:]
	}
	return s
}

func exitPtr(code int) *int { return &code }

type syncStatus struct {
	Mode            SyncMode `json:"mode"`
	IntervalMin     int      `json:"intervalMin"`
	Cron            string   `json:"cron"`
	CronInvalid     bool     `json:"cronInvalid,omitempty"`
	NextRun         string   `json:"nextRun,omitempty"` // cron 模式下的下次运行时刻
	Running         bool     `json:"running"`
	Remote          string   `json:"remote"`
	RemoteBucket    string   `json:"remoteBucket"`
	Local           string   `json:"local"`
	RcloneAvailable bool     `json:"rcloneAvailable"`
	LastRun         *SyncRun `json:"lastRun"`
}

type SyncEngine struct {
	mu        sync.Mutex
	cfg       *DaemonConfig
	running   bool
	history   []SyncRun
	stopSched chan struct{}
	nextFire  time.Time // 调度器当前排定的下次触发时刻（间隔模式下 Status 兜底展示）
}

func NewSyncEngine(cfg *DaemonConfig) *SyncEngine {
	return &SyncEngine{cfg: cfg, history: []SyncRun{}}
}

func (e *SyncEngine) localPath() string {
	return filepath.Join(e.cfg.DataDir, e.cfg.Bucket)
}

func (e *SyncEngine) rcloneAvailable() bool {
	// 绝对路径探测可执行位；裸命令名交给 PATH 解析
	if strings.ContainsRune(e.cfg.RcloneBin, '/') {
		st, err := os.Stat(e.cfg.RcloneBin)
		return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
	}
	_, err := exec.LookPath(e.cfg.RcloneBin)
	return err == nil
}

func (e *SyncEngine) remotePath() string {
	return fmt.Sprintf("%s:%s", e.cfg.Remote, e.cfg.RemoteBucket)
}

func (e *SyncEngine) buildArgs(mode SyncMode) ([]string, error) {
	local := e.localPath()
	remote := e.remotePath()
	_ = os.MkdirAll(local, 0o755)
	// daemon 内部元数据不外发：_fdmeta/ 是 sidecar 目录，.rclone_temp_multipart_* 是
	// rclone serve s3 进行中 multipart 的临时文件——都不属于 bucket 内容，不应同步上云。
	excludes := []string{"--exclude", "_fdmeta/**", "--exclude", ".rclone_temp_multipart_*"}
	switch mode {
	case SyncPush:
		// 注意：不要用 --log-file "-"（rclone 会当成字面文件名，在 cwd 生成名为 "-" 的文件）；
		// 输出走 stderr，daemon 的 StderrPipe 会捕获进同步历史。
		return append([]string{"sync", local, remote, "--verbose"}, excludes...), nil
	case SyncPull:
		return append([]string{"sync", remote, local, "--verbose"}, excludes...), nil
	case SyncBisync:
		// rclone bisync 首次需要 --resync；这里交给调用方判断（history 里看错误提示）
		return append([]string{"bisync", local, remote, "--verbose"}, excludes...), nil
	default:
		return nil, fmt.Errorf("unknown sync mode: %s", mode)
	}
}

func (e *SyncEngine) pushHistory(entry SyncRun) {
	e.history = append([]SyncRun{entry}, e.history...)
	if len(e.history) > 50 {
		e.history = e.history[:50]
	}
}

func (e *SyncEngine) Run(mode SyncMode, resync bool) SyncRun {
	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		return SyncRun{TS: nowISO(), Mode: mode, StderrTail: "sync already running"}
	}
	if !e.rcloneAvailable() {
		entry := SyncRun{
			TS:         nowISO(),
			Mode:       mode,
			Exit:       exitPtr(-1),
			StderrTail: fmt.Sprintf("rclone 不可用（%s）。请安装 rclone 或配置 DAEMON_RCLONE_BIN。", e.cfg.RcloneBin),
		}
		e.pushHistory(entry)
		e.mu.Unlock()
		return entry
	}
	args, err := e.buildArgs(mode)
	if err != nil {
		e.mu.Unlock()
		return SyncRun{TS: nowISO(), Mode: mode, Exit: exitPtr(-1), StderrTail: err.Error()}
	}
	if resync {
		args = append(args, "--resync")
	}
	cmd := exec.Command(e.cfg.RcloneBin, args...)
	cmdEnv := os.Environ()
	rc := e.cfg.RcloneConf
	if rc == "" {
		rc = os.Getenv("RCLONE_CONFIG")
	}
	cmdEnv = append(cmdEnv, "RCLONE_CONFIG="+rc)
	cmd.Env = cmdEnv
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	e.running = true
	e.mu.Unlock()

	if err := cmd.Start(); err != nil {
		e.mu.Lock()
		e.running = false
		entry := SyncRun{TS: nowISO(), Mode: mode, Exit: exitPtr(-1), StderrTail: err.Error()}
		e.pushHistory(entry)
		e.mu.Unlock()
		return entry
	}

	var outBuf, errBuf tailBuf
	var wg sync.WaitGroup
	scan := func(rd io.Reader, buf *tailBuf) {
		defer wg.Done()
		sc := bufio.NewScanner(rd)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			buf.add(sc.Text())
		}
	}
	wg.Add(2)
	go scan(stdout, &outBuf)
	go scan(stderr, &errBuf)
	wg.Wait()
	waitErr := cmd.Wait()

	code := 0
	if waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	entry := SyncRun{
		TS:         nowISO(),
		Mode:       mode,
		Exit:       &code,
		StdoutTail: outBuf.tail(4000),
		StderrTail: errBuf.tail(4000),
	}
	e.mu.Lock()
	e.running = false
	e.pushHistory(entry)
	e.mu.Unlock()
	return entry
}

func (e *SyncEngine) StartScheduler(cfg *DaemonConfig) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg = cfg
	if e.stopSched != nil {
		close(e.stopSched)
		e.stopSched = nil
	}
	if cfg.SyncMode == SyncOff {
		return
	}
	// cron 优先；cron 为空/无效则退回间隔分钟（0 = 不自动）
	var cron *cronSpec
	if cfg.SyncCron != "" {
		if c, err := parseCron(cfg.SyncCron); err == nil {
			cron = c
		} else {
			log.Printf("[daemon] cron %q 无效，退回间隔模式：%v", cfg.SyncCron, err)
		}
	}
	if cron == nil && cfg.SyncIntervalMin <= 0 {
		return
	}
	stop := make(chan struct{})
	e.stopSched = stop
	interval := time.Duration(cfg.SyncIntervalMin) * time.Minute
	mode := cfg.SyncMode
	go func() {
		for {
			var delay time.Duration
			if cron != nil {
				next := cron.nextAfter(time.Now())
				if next.IsZero() {
					return // cron 一年内无匹配
				}
				delay = time.Until(next)
			} else {
				delay = interval
			}
			e.mu.Lock()
			e.nextFire = time.Now().Add(delay)
			e.mu.Unlock()
			timer := time.NewTimer(delay)
			select {
			case <-stop:
				timer.Stop()
				return
			case <-timer.C:
				e.mu.Lock()
				running := e.running
				e.mu.Unlock()
				if !running {
					go e.Run(mode, false)
				}
			}
		}
	}()
}

func (e *SyncEngine) Status() syncStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	st := syncStatus{
		Mode:            e.cfg.SyncMode,
		IntervalMin:     e.cfg.SyncIntervalMin,
		Cron:            e.cfg.SyncCron,
		Running:         e.running,
		Remote:          e.cfg.Remote,
		RemoteBucket:    e.cfg.RemoteBucket,
		Local:           e.localPath(),
		RcloneAvailable: e.rcloneAvailable(),
	}
	if st.Cron != "" {
		if c, err := parseCron(st.Cron); err == nil {
			if next := c.nextAfter(time.Now()); !next.IsZero() {
				st.NextRun = next.Format("2006-01-02 15:04")
			}
		} else {
			st.CronInvalid = true
		}
	}
	// cron 为空/无效但间隔模式在跑：展示调度器当前排定的触发时刻
	// （Status 已持有 e.mu——Mutex 不可重入，这里绝不能再 Lock，否则死锁）
	if st.Cron == "" && st.IntervalMin > 0 && !e.nextFire.IsZero() {
		st.NextRun = e.nextFire.Format("2006-01-02 15:04")
	}
	if len(e.history) > 0 {
		last := e.history[0]
		st.LastRun = &last
	}
	return st
}

func (e *SyncEngine) History() []SyncRun {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.history) == 0 {
		return []SyncRun{}
	}
	out := make([]SyncRun, len(e.history))
	copy(out, e.history)
	return out
}

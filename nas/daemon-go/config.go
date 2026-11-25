// daemon 配置：全部来自环境变量，sync 相关可被配置文件覆盖（管理平面可改）。
package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type SyncMode string

const (
	SyncOff    SyncMode = "off"
	SyncPush   SyncMode = "push"
	SyncPull   SyncMode = "pull"
	SyncBisync SyncMode = "bisync"
)

type DaemonConfig struct {
	// DataDir：rclone serve s3 的根目录；bucket 以子目录形式存在其中（与云端 R2 bucket 同名，便于同步）
	DataDir  string
	Bucket   string
	S3Addr   string // rclone serve s3 监听地址（仅容器内 localhost）
	R2Port   int    // 对 workerd shim 暴露的 R2 API 端口
	MgmtPort int    // 管理平面端口
	Token    string // R2 API Bearer token（shim 机器对机器）
	MgmtUser string // 管理平面登录账号（独立于 Davflare 的 WebDAV 账号）
	MgmtPass string // 管理平面登录密码
	// 同步目标与计划（remote/remoteBucket/mode/interval/cron）不进 env：
	// 全部由管理平面设置并持久化到 ConfigPath，这里只放默认值。
	Remote          string // rclone 远端名（云端 R2）
	RemoteBucket    string // 云端 bucket 名（默认与本地 bucket 相同）
	SyncMode        SyncMode
	SyncIntervalMin int    // 0 = 不自动（与 SyncCron 二选一，cron 优先）
	SyncCron        string // 标准 5 字段 cron（分 时 日 月 周）；空 = 用间隔分钟
	RcloneBin       string
	RcloneConf      string // 传给 rclone 子进程的 RCLONE_CONFIG
	ConfigPath      string // sync 配置持久化文件
}

// SyncConfigPatch 管理平面可持久化的那部分配置（远端/桶仅 env，不在其中）
type SyncConfigPatch struct {
	SyncMode        SyncMode `json:"syncMode,omitempty"`
	SyncIntervalMin *int     `json:"syncIntervalMin,omitempty"`
	SyncCron        *string  `json:"syncCron,omitempty"` // 指针：区分「未传」与「清空」
}

// persistedSyncConfig 落盘形态（永远包含全部字段）
type persistedSyncConfig struct {
	SyncMode        SyncMode `json:"syncMode"`
	SyncIntervalMin int      `json:"syncIntervalMin"`
	SyncCron        string   `json:"syncCron"`
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return fallback
	}
	return int(math.Floor(n))
}

func loadConfig() (*DaemonConfig, error) {
	cfg := &DaemonConfig{
		DataDir:    env("DAEMON_DATA_DIR", "/data/files"),
		Bucket:     env("DAEMON_BUCKET", "webdav"),
		S3Addr:     env("DAEMON_S3_ADDR", "127.0.0.1:9002"),
		R2Port:     envInt("DAEMON_R2_PORT", 9000),
		MgmtPort:   envInt("DAEMON_MGMT_PORT", 9001),
		Token:      env("DAEMON_TOKEN", ""),
		MgmtUser:   env("DAEMON_MGMT_USER", "admin"),
		MgmtPass:   env("DAEMON_MGMT_PASS", "admin"),
		Remote:     env("DAEMON_REMOTE", "r2"), // 远端/桶仅环境变量配置，页面不可改
		SyncMode:   SyncOff,
		RcloneBin:  env("DAEMON_RCLONE_BIN", "rclone"),
		RcloneConf: env("RCLONE_CONFIG", ""),
		ConfigPath: env("DAEMON_CONFIG_FILE", ""),
	}
	cfg.RemoteBucket = env("DAEMON_REMOTE_BUCKET", cfg.Bucket) // 默认同步到云端同名桶
	if cfg.Token == "" {
		return nil, errDaemonToken
	}
	// 配置文件覆盖 sync 相关字段（文件不存在或损坏：用 env 默认值）
	if cfg.ConfigPath != "" {
		if b, err := os.ReadFile(cfg.ConfigPath); err == nil {
			var patch SyncConfigPatch
			if json.Unmarshal(b, &patch) == nil {
				if patch.SyncMode != "" {
					cfg.SyncMode = patch.SyncMode
				}
				if patch.SyncIntervalMin != nil && *patch.SyncIntervalMin >= 0 {
					cfg.SyncIntervalMin = *patch.SyncIntervalMin
				}
				if patch.SyncCron != nil {
					cfg.SyncCron = *patch.SyncCron
				}
			}
		}
	}
	return cfg, nil
}

func persistSyncConfig(cfg *DaemonConfig, patch SyncConfigPatch) persistedSyncConfig {
	merged := persistedSyncConfig{
		SyncMode:        cfg.SyncMode,
		SyncIntervalMin: cfg.SyncIntervalMin,
		SyncCron:        cfg.SyncCron,
	}
	if patch.SyncMode != "" {
		merged.SyncMode = patch.SyncMode
	}
	if patch.SyncIntervalMin != nil && *patch.SyncIntervalMin >= 0 {
		merged.SyncIntervalMin = *patch.SyncIntervalMin
	}
	if patch.SyncCron != nil {
		merged.SyncCron = *patch.SyncCron
	}
	if cfg.ConfigPath != "" {
		_ = os.MkdirAll(filepath.Dir(cfg.ConfigPath), 0o755)
		if b, err := json.MarshalIndent(merged, "", "  "); err == nil {
			_ = os.WriteFile(cfg.ConfigPath, b, 0o644)
		}
	}
	return merged
}

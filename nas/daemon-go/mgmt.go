// 管理平面 :9001 —— 配置、状态、手动触发同步、历史日志、内嵌 Vite+React 管理界面。
// 前端源码在 web/（npm run build → web/dist），go:embed 打进二进制，单文件部署。
package main

import (
	"embed"
	"encoding/json"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

//go:embed all:web/dist
var webDist embed.FS

// serveSPA 内嵌前端静态服务；非 /api 的 GET 都走这里，未匹配的路径回退 index.html（SPA）。
// 返回 false 表示该请求不属于静态范围（/api/*），交回 API 路由处理。
func (m *MgmtApi) serveSPA(w http.ResponseWriter, pathname string) bool {
	if strings.HasPrefix(pathname, "/api/") || pathname == "/api" {
		return false
	}
	rel := strings.TrimPrefix(pathname, "/")
	if rel == "" {
		rel = "index.html"
	}
	data, err := fs.ReadFile(webDist, "web/dist/"+rel)
	if err != nil {
		if strings.Contains(path.Base(rel), ".") {
			return false // 带扩展名的资源缺失 → 404
		}
		data, err = fs.ReadFile(webDist, "web/dist/index.html")
		if err != nil {
			return false
		}
		rel = "index.html"
	}
	ct := mime.TypeByExtension(path.Ext(rel))
	if ct == "" {
		ct = "application/octet-stream"
	}
	h := w.Header()
	if strings.HasPrefix(rel, "assets/") {
		h.Set("Cache-Control", "public, max-age=31536000, immutable") // vite 指纹资源
	} else {
		h.Set("Cache-Control", "no-cache") // index.html 引用指纹资源，必须每次校验
	}
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
	return true
}

type statusBody struct {
	DataDir  string     `json:"dataDir"`
	Bucket   string     `json:"bucket"`
	R2Port   int        `json:"r2Port"`
	MgmtPort int        `json:"mgmtPort"`
	Sync     syncStatus `json:"sync"`
}

type MgmtApi struct {
	cfg  *DaemonConfig
	sync *SyncEngine
}

func NewMgmtApi(cfg *DaemonConfig, sync *SyncEngine) *MgmtApi {
	return &MgmtApi{cfg: cfg, sync: sync}
}

func (m *MgmtApi) handle(w http.ResponseWriter, r *http.Request, pathname string) {
	method := r.Method
	if method == "" {
		method = "GET"
	}
	// 内嵌管理前端（免认证可取页面本身；数据接口全部要求 Basic 账号密码）
	if (method == "GET" || method == "HEAD") && m.serveSPA(w, pathname) {
		return
	}
	if !mgmtBasicAuth(r, m.cfg.MgmtUser, m.cfg.MgmtPass) {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	if pathname == "/api/health" {
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	if pathname == "/api/status" && method == "GET" {
		writeJSON(w, 200, statusBody{
			DataDir:  m.cfg.DataDir,
			Bucket:   m.cfg.Bucket,
			R2Port:   m.cfg.R2Port,
			MgmtPort: m.cfg.MgmtPort,
			Sync:     m.sync.Status(),
		})
		return
	}
	if pathname == "/api/config" {
		if method == "GET" {
			writeJSON(w, 200, map[string]any{
				"syncMode":        m.cfg.SyncMode,
				"syncIntervalMin": m.cfg.SyncIntervalMin,
				"syncCron":        m.cfg.SyncCron,
			})
			return
		}
		if method == "PUT" {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
			r.Body.Close()
			var patch SyncConfigPatch
			if err := json.Unmarshal(body, &patch); err != nil {
				writeJSON(w, 500, map[string]string{"error": err.Error()})
				return
			}
			if patch.SyncCron != nil && *patch.SyncCron != "" {
				// Quartz 的 "?" 归一化为标准 crontab "*" 后再校验/落盘
				norm := strings.ReplaceAll(*patch.SyncCron, "?", "*")
				patch.SyncCron = &norm
				if _, err := parseCron(norm); err != nil {
					writeJSON(w, 400, map[string]string{"error": "无效 cron 表达式：" + err.Error()})
					return
				}
			}
			merged := persistSyncConfig(m.cfg, patch)
			m.cfg.SyncMode = merged.SyncMode
			m.cfg.SyncIntervalMin = merged.SyncIntervalMin
			m.cfg.SyncCron = merged.SyncCron
			m.sync.StartScheduler(m.cfg)
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
	}
	if pathname == "/api/sync/run" && method == "POST" {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		r.Body.Close()
		var req struct {
			Mode   SyncMode `json:"mode"`
			Resync bool     `json:"resync"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		mode := req.Mode
		if mode == "" {
			mode = m.cfg.SyncMode
		}
		if mode != SyncPush && mode != SyncPull && mode != SyncBisync {
			writeJSON(w, 400, map[string]string{"error": "invalid mode"})
			return
		}
		go m.sync.Run(mode, req.Resync) // 后台执行，前端轮询 history
		writeJSON(w, 202, map[string]any{"started": true, "mode": mode})
		return
	}
	if pathname == "/api/sync/history" && method == "GET" {
		writeJSON(w, 200, m.sync.History())
		return
	}
	writeJSON(w, 404, map[string]string{"error": "not found"})
}

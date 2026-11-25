// R2 API :9000 —— daemon 对外核心。把 R2Bucket 语义翻译成 S3 调用（rclone serve s3）。
// 元数据（httpMetadata/customMetadata）存 sidecar：_fdmeta/<key>.json，list 时合并、list 根下隐藏。
// wire 契约与 workerd 侧 r2-shim.ts 严格对应（x-fd-* 头族 / JSON 字段名），改动需两边同步。
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const META_PREFIX = "_fdmeta/"

type R2HttpMetadata struct {
	ContentType        string `json:"contentType,omitempty"`
	ContentLanguage    string `json:"contentLanguage,omitempty"`
	ContentDisposition string `json:"contentDisposition,omitempty"`
	ContentEncoding    string `json:"contentEncoding,omitempty"`
	CacheControl       string `json:"cacheControl,omitempty"`
	CacheExpiry        string `json:"cacheExpiry,omitempty"`
}

type Sidecar struct {
	HTTPMetadata   *R2HttpMetadata   `json:"httpMetadata,omitempty"`
	CustomMetadata map[string]string `json:"customMetadata,omitempty"`
	ETag           string            `json:"etag,omitempty"`
}

// ---- 元数据 JSON 头：base64 传输（文件名可能含中文，不能直接进 HTTP header） ----

func parseB64JSON(v string) (json.RawMessage, bool) {
	if v == "" {
		return nil, false
	}
	b, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, false
	}
	return json.RawMessage(b), true
}

func b64JSON(v any) string {
	b, _ := json.Marshal(v)
	return base64.StdEncoding.EncodeToString(b)
}

// ---- key 安全与保留前缀 ----

func safeKey(rawKey string) (string, bool) {
	// 路由层传入的是 wire 原始编码路径（EscapedPath），这里只做一次解码
	key, err := url.PathUnescape(rawKey)
	if err != nil {
		return "", false
	}
	if key == "" || strings.HasPrefix(key, "/") || strings.HasSuffix(key, "/") ||
		strings.Contains(key, "//") || strings.Contains(key, "\\") {
		return "", false
	}
	for _, p := range strings.Split(key, "/") {
		if p == "." || p == ".." || p == "" {
			return "", false
		}
	}
	if strings.HasPrefix(key, META_PREFIX) {
		return "", false // 保留前缀，不对外
	}
	return key, true
}

// ---- Content-Type 兜底猜测（sidecar 缺失时） ----

var extTypes = map[string]string{
	"html": "text/html", "htm": "text/html", "css": "text/css", "js": "text/javascript", "mjs": "text/javascript",
	"json": "application/json", "txt": "text/plain", "md": "text/plain", "xml": "application/xml", "csv": "text/csv",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
	"svg": "image/svg+xml", "ico": "image/x-icon", "avif": "image/avif", "bmp": "image/bmp",
	"pdf": "application/pdf", "zip": "application/zip", "gz": "application/gzip", "tar": "application/x-tar",
	"mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg", "wav": "audio/wav", "flac": "audio/flac",
	"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "mkv": "video/x-matroska",
	"epub": "application/epub+zip", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf",
}

func guessContentType(key string) string {
	dot := strings.LastIndex(key, ".")
	if dot <= 0 {
		return "application/octet-stream"
	}
	if ct, ok := extTypes[strings.ToLower(key[dot+1:])]; ok {
		return ct
	}
	return "application/octet-stream"
}

func isFolderMeta(meta *Sidecar) bool {
	if meta == nil {
		return false
	}
	if meta.CustomMetadata != nil && meta.CustomMetadata["resourcetype"] == "<collection />" {
		return true
	}
	return meta.HTTPMetadata != nil && meta.HTTPMetadata.ContentType == "application/x-directory"
}

// ---- 条件请求（R2 onlyIf 语义；本地自查实现） ----

type conditions struct {
	ifMatch           []string
	ifNoneMatch       []string
	ifModifiedSince   *time.Time
	ifUnmodifiedSince *time.Time
}

func etagList(value string) []string {
	out := []string{}
	for _, s := range strings.Split(value, ",") {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func etagMatches(etag string, list []string) bool {
	trimmed := strings.TrimSuffix(strings.TrimPrefix(etag, `"`), `"`)
	for _, v := range list {
		if v == "*" || v == etag || v == trimmed {
			return true
		}
	}
	return false
}

func headerPresent(r *http.Request, name string) (string, bool) {
	vs, ok := r.Header[http.CanonicalHeaderKey(name)]
	if !ok || len(vs) == 0 {
		return "", false
	}
	return vs[0], true
}

func parseConditions(r *http.Request, excludeNoneMatch bool) conditions {
	var cond conditions
	if v, ok := headerPresent(r, "If-Match"); ok {
		cond.ifMatch = etagList(v)
	}
	if v, ok := headerPresent(r, "If-None-Match"); ok && !excludeNoneMatch {
		cond.ifNoneMatch = etagList(v)
	}
	if v, ok := headerPresent(r, "If-Modified-Since"); ok {
		if t, err := http.ParseTime(v); err == nil {
			cond.ifModifiedSince = &t
		}
	}
	if v, ok := headerPresent(r, "If-Unmodified-Since"); ok {
		if t, err := http.ParseTime(v); err == nil {
			cond.ifUnmodifiedSince = &t
		}
	}
	return cond
}

func checkConditions(cond conditions, etag string, mtime time.Time) bool {
	// R2 语义：全部通过才放行
	if cond.ifMatch != nil && !etagMatches(etag, cond.ifMatch) {
		return false
	}
	if cond.ifNoneMatch != nil && etagMatches(etag, cond.ifNoneMatch) {
		return false
	}
	if cond.ifUnmodifiedSince != nil && mtime.UnixMilli() > cond.ifUnmodifiedSince.UnixMilli()+999 {
		return false
	}
	if cond.ifModifiedSince != nil && mtime.UnixMilli() <= cond.ifModifiedSince.UnixMilli()-1000 {
		return false
	}
	return true
}

func condHeadersPresent(r *http.Request) bool {
	for _, k := range []string{"If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"} {
		if _, ok := headerPresent(r, k); ok {
			return true
		}
	}
	return false
}

// ---- R2 API handler ----

type mpuEntry struct {
	key        string
	s3UploadID string
	meta       *Sidecar
	parts      map[int]string
}

type R2Api struct {
	s3     *S3Client
	token  string
	mu     sync.Mutex
	mpu    map[string]*mpuEntry
	mpuSeq atomic.Int64
}

func NewR2Api(s3 *S3Client, token string) *R2Api {
	return &R2Api{s3: s3, token: token, mpu: map[string]*mpuEntry{}}
}

var mpuRe = regexp.MustCompile(`^/r2/mpu/([^/]+)(?:/parts/(\d+))?(?:/complete)?$`)
var contentRangeRe = regexp.MustCompile(`bytes\s+(\d+)-(\d+)/(\d+)`)

func (a *R2Api) handle(w http.ResponseWriter, r *http.Request, pathname string) {
	if !bearerAuth(r, a.token) {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	method := strings.ToUpper(r.Method)
	if method == "" {
		method = "GET"
	}
	err := a.route(w, r, method, pathname)
	if err != nil {
		var s3e *S3Error
		if errors.As(err, &s3e) {
			body := s3e.Body
			if len(body) > 500 {
				body = body[:500]
			}
			writeJSON(w, 502, map[string]any{"error": "upstream", "status": s3e.Status, "body": body})
		} else {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
		}
	}
}

func (a *R2Api) route(w http.ResponseWriter, r *http.Request, method, pathname string) error {
	// --- 对象 ---
	if rest, ok := strings.CutPrefix(pathname, "/r2/obj/"); ok {
		key, ok := safeKey(rest)
		if !ok {
			writeJSON(w, 400, map[string]string{"error": "invalid key"})
			return nil
		}
		switch method {
		case "GET", "HEAD":
			return a.getObject(w, r, key, method == "HEAD")
		case "PUT":
			return a.putObject(w, r, key)
		case "DELETE":
			return a.deleteObject(w, key)
		default:
			writeJSON(w, 405, map[string]string{"error": "method not allowed"})
			return nil
		}
	}
	// --- 列目录 ---
	if pathname == "/r2/list" && method == "POST" {
		return a.listObjects(w, r)
	}
	// --- multipart ---
	if pathname == "/r2/mpu" && method == "POST" {
		return a.createMpu(w, r)
	}
	if m := mpuRe.FindStringSubmatch(pathname); m != nil {
		uploadID := m[1]
		if method == "PUT" && m[2] != "" {
			partNumber, _ := strconv.Atoi(m[2])
			if partNumber > 0 {
				return a.uploadPart(w, r, uploadID, partNumber)
			}
		} else if method == "POST" && strings.HasSuffix(pathname, "/complete") {
			return a.completeMpu(w, r, uploadID)
		} else if method == "DELETE" {
			return a.abortMpu(w, uploadID)
		}
	}
	writeJSON(w, 404, map[string]string{"error": "not found"})
	return nil
}

func (a *R2Api) loadMeta(key string) *Sidecar {
	mk := META_PREFIX + key + ".json"
	resp, err := a.s3.request("GET", &mk, nil, nil, nil)
	if err != nil {
		return nil
	}
	var sc Sidecar
	if json.Unmarshal([]byte(resp.text), &sc) != nil {
		return nil
	}
	return &sc
}

func (a *R2Api) saveMeta(key string, meta *Sidecar, etag string) error {
	sc := Sidecar{HTTPMetadata: meta.HTTPMetadata, CustomMetadata: meta.CustomMetadata, ETag: etag}
	b, _ := json.Marshal(sc)
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	mk := META_PREFIX + key + ".json"
	_, err := a.s3.request("PUT", &mk, nil, header, bytes.NewReader(b))
	return err
}

func (a *R2Api) deleteMeta(key string) {
	mk := META_PREFIX + key + ".json"
	_, _ = a.s3.request("DELETE", &mk, nil, nil, nil) // 忽略
}

func (a *R2Api) getObject(w http.ResponseWriter, r *http.Request, key string, headOnly bool) error {
	log.Printf("[r2] %s %s", r.Method, key)
	head, err := a.s3.head(key)
	if err != nil {
		return err
	}
	if head == nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return nil
	}
	meta := a.loadMeta(key)
	etag := head.Get("Etag")
	if etag == "" {
		cl := head.Get("Content-Length")
		if cl == "" {
			cl = "0"
		}
		etag = `"` + cl + `-` + head.Get("Last-Modified") + `"`
	}
	contentType := guessContentType(key)
	if meta != nil && meta.HTTPMetadata != nil && meta.HTTPMetadata.ContentType != "" {
		contentType = meta.HTTPMetadata.ContentType
	}
	totalSize := atoiOr(head.Get("Content-Length"), 0)
	lastModified := time.UnixMilli(0)
	if lm := head.Get("Last-Modified"); lm != "" {
		if t, err := http.ParseTime(lm); err == nil {
			lastModified = t
		}
	}

	// onlyIf 条件
	cond := parseConditions(r, r.Header.Get("x-fd-exclude-none-match") == "1")
	if !checkConditions(cond, etag, lastModified) {
		// R2 语义：条件失败返回无 body 的 R2Object（412 + 元数据头）
		h := w.Header()
		h.Set("x-fd-size", strconv.FormatInt(totalSize, 10))
		h.Set("x-fd-etag", etag)
		h.Set("x-fd-mtime", strconv.FormatInt(lastModified.UnixMilli(), 10))
		h.Set("x-fd-content-type", contentType)
		if meta != nil && meta.HTTPMetadata != nil {
			h.Set("x-fd-http-metadata-b64", b64JSON(*meta.HTTPMetadata))
		}
		if meta != nil && meta.CustomMetadata != nil {
			h.Set("x-fd-custom-metadata-b64", b64JSON(meta.CustomMetadata))
		}
		w.WriteHeader(412)
		return nil
	}

	// range（R2 语义 offset/length/suffix → HTTP Range）
	var rangeHeader string
	if v := r.Header.Get("x-fd-range-suffix"); v != "" {
		rangeHeader = "bytes=-" + v
	} else if v := r.Header.Get("x-fd-range-offset"); v != "" {
		off, _ := strconv.ParseInt(v, 10, 64)
		if v2 := r.Header.Get("x-fd-range-length"); v2 != "" {
			length, _ := strconv.ParseInt(v2, 10, 64)
			rangeHeader = fmt.Sprintf("bytes=%d-%d", off, off+length-1)
		} else {
			rangeHeader = fmt.Sprintf("bytes=%d-", off)
		}
	}

	header := http.Header{}
	if rangeHeader != "" {
		header.Set("Range", rangeHeader)
	}
	s3res, err := a.s3.requestStream("GET", &key, nil, header, nil)
	if err != nil {
		return err
	}
	defer s3res.Body.Close()

	// 计算实际返回区间
	rangeOffset, rangeEnd := int64(0), totalSize-1
	if rangeHeader != "" {
		if m := contentRangeRe.FindStringSubmatch(s3res.Header.Get("Content-Range")); m != nil {
			rangeOffset, _ = strconv.ParseInt(m[1], 10, 64)
			rangeEnd, _ = strconv.ParseInt(m[2], 10, 64)
		}
	}

	h := w.Header()
	h.Set("x-fd-size", strconv.FormatInt(totalSize, 10))
	h.Set("x-fd-etag", etag)
	h.Set("x-fd-mtime", strconv.FormatInt(lastModified.UnixMilli(), 10))
	h.Set("x-fd-content-type", contentType)
	h.Set("x-fd-range-offset", strconv.FormatInt(rangeOffset, 10))
	h.Set("x-fd-range-end", strconv.FormatInt(rangeEnd, 10))
	if meta != nil && meta.HTTPMetadata != nil {
		h.Set("x-fd-http-metadata-b64", b64JSON(*meta.HTTPMetadata))
	}
	if meta != nil && meta.CustomMetadata != nil {
		h.Set("x-fd-custom-metadata-b64", b64JSON(meta.CustomMetadata))
	}
	cl := s3res.Header.Get("Content-Length")
	if cl == "" {
		cl = "0"
	}
	h.Set("Content-Length", cl)
	w.WriteHeader(http.StatusOK)
	if headOnly {
		_, _ = io.Copy(io.Discard, s3res.Body)
		return nil
	}
	_, err = io.Copy(w, s3res.Body)
	return err
}

func (a *R2Api) putObject(w http.ResponseWriter, r *http.Request, key string) error {
	cl := r.Header.Get("Content-Length")
	if cl == "" {
		cl = "chunked"
	}
	log.Printf("[r2] PUT %s cl=%s", key, cl)
	httpMeta := &R2HttpMetadata{}
	if raw, ok := parseB64JSON(r.Header.Get("x-fd-http-metadata-b64")); ok {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			setStr := func(dst *string, field string) {
				if v, ok := m[field].(string); ok {
					*dst = v
				}
			}
			setStr(&httpMeta.ContentType, "contentType")
			setStr(&httpMeta.ContentLanguage, "contentLanguage")
			setStr(&httpMeta.ContentDisposition, "contentDisposition")
			setStr(&httpMeta.ContentEncoding, "contentEncoding")
			setStr(&httpMeta.CacheControl, "cacheControl")
			setStr(&httpMeta.CacheExpiry, "cacheExpiry")
		}
	}
	var customMeta map[string]string
	if raw, ok := parseB64JSON(r.Header.Get("x-fd-custom-metadata-b64")); ok {
		_ = json.Unmarshal(raw, &customMeta)
	}

	// 条件写自查（WebDAV If-Match / If-None-Match → onlyIf）
	if condHeadersPresent(r) {
		existing, err := a.s3.head(key)
		if err != nil {
			return err
		}
		etag := ""
		mtime := time.UnixMilli(0)
		if existing != nil {
			etag = existing.Get("Etag")
			if lm := existing.Get("Last-Modified"); lm != "" {
				if t, e := http.ParseTime(lm); e == nil {
					mtime = t
				}
			}
		}
		if !checkConditions(parseConditions(r, false), etag, mtime) {
			writeJSON(w, 412, map[string]string{"error": "precondition failed"})
			return nil
		}
	}

	contentType := httpMeta.ContentType
	if contentType == "" {
		contentType = guessContentType(key)
	}
	header := http.Header{}
	header.Set("Content-Type", contentType)
	s3res, err := a.s3.requestStream("PUT", &key, nil, header, r.Body)
	r.Body.Close()
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, s3res.Body)
	s3res.Body.Close()
	etag := s3res.Header.Get("Etag")

	sc := &Sidecar{HTTPMetadata: httpMeta, CustomMetadata: customMeta}
	if httpMeta.ContentType != "" || customMeta != nil || isFolderMeta(sc) {
		if err := a.saveMeta(key, sc, etag); err != nil {
			return err
		}
	}
	h := w.Header()
	h.Set("x-fd-etag", etag)
	h.Set("x-fd-mtime", strconv.FormatInt(time.Now().UnixMilli(), 10))
	h.Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))
	return nil
}

func (a *R2Api) deleteObject(w http.ResponseWriter, key string) error {
	_, err := a.s3.request("DELETE", &key, nil, nil, nil)
	var s3e *S3Error
	if err != nil && (!errors.As(err, &s3e) || s3e.Status != 404) {
		// R2 delete 不存在的 key 不报错；保持幂等
		return err
	}
	a.deleteMeta(key)
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

type listReqBody struct {
	Prefix     string `json:"prefix"`
	Cursor     string `json:"cursor"`
	StartAfter string `json:"startAfter"`
	Delimiter  string `json:"delimiter"`
	Limit      int    `json:"limit"`
}

type listRespObject struct {
	Key            string            `json:"key"`
	Size           int64             `json:"size"`
	Uploaded       string            `json:"uploaded"`
	ETag           string            `json:"etag"`
	HTTPMetadata   *R2HttpMetadata   `json:"httpMetadata"`
	CustomMetadata map[string]string `json:"customMetadata,omitempty"`
	IsFolder       bool              `json:"isFolder"`
}

type listResp struct {
	Objects           []listRespObject `json:"objects"`
	DelimitedPrefixes []string         `json:"delimitedPrefixes"`
	Truncated         bool             `json:"truncated"`
	Cursor            *string          `json:"cursor"`
}

func (a *R2Api) listObjects(w http.ResponseWriter, r *http.Request) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	r.Body.Close()
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid json"})
		return nil
	}
	var req listReqBody
	if len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, &req) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid json"})
		return nil
	}
	prefix := req.Prefix
	// 前缀式内部隔离：别人列 _fdmeta 直接给空
	if strings.HasPrefix(prefix, META_PREFIX) {
		writeJSON(w, 200, listResp{Objects: []listRespObject{}, DelimitedPrefixes: []string{}, Cursor: nil})
		return nil
	}
	limit := req.Limit
	if limit == 0 {
		limit = 1000
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 1000 {
		limit = 1000
	}
	result, err := a.s3.list(s3ListOpts{
		Prefix:            prefix,
		Delimiter:         req.Delimiter,
		MaxKeys:           limit,
		ContinuationToken: req.Cursor,
		StartAfter:        req.StartAfter,
	})
	if err != nil {
		return err
	}
	// 过滤内部 sidecar 前缀（S3 递归列出的对象里会带 _fdmeta/...）
	objs := make([]S3ObjectEntry, 0, len(result.Objects))
	for _, o := range result.Objects {
		if !strings.HasPrefix(o.Key, META_PREFIX) {
			objs = append(objs, o)
		}
	}
	// 合并 sidecar 元数据（并发）
	merged := make([]listRespObject, len(objs))
	var wg sync.WaitGroup
	for i, o := range objs {
		wg.Add(1)
		go func(i int, o S3ObjectEntry) {
			defer wg.Done()
			meta := a.loadMeta(o.Key)
			entry := listRespObject{
				Key:      o.Key,
				Size:     o.Size,
				Uploaded: o.LastModified,
				ETag:     o.ETag,
			}
			if meta != nil && meta.HTTPMetadata != nil {
				entry.HTTPMetadata = meta.HTTPMetadata
			} else {
				entry.HTTPMetadata = &R2HttpMetadata{ContentType: guessContentType(o.Key)}
			}
			if meta != nil {
				entry.CustomMetadata = meta.CustomMetadata
				entry.IsFolder = isFolderMeta(meta)
			}
			merged[i] = entry
		}(i, o)
	}
	wg.Wait()
	// 内部 sidecar 前缀双向隔离：对象与前缀分组都不对外暴露
	visiblePrefixes := make([]string, 0, len(result.CommonPrefixes))
	for _, p := range result.CommonPrefixes {
		if !strings.HasPrefix(p, META_PREFIX) && p != "_fdmeta" {
			visiblePrefixes = append(visiblePrefixes, p)
		}
	}
	resp := listResp{
		Objects:           merged,
		DelimitedPrefixes: visiblePrefixes,
		Truncated:         result.IsTruncated,
	}
	if result.NextContinuationToken != "" {
		resp.Cursor = &result.NextContinuationToken
	}
	writeJSON(w, 200, resp)
	return nil
}

type createMpuBody struct {
	Key            string            `json:"key"`
	HTTPMetadata   *R2HttpMetadata   `json:"httpMetadata"`
	CustomMetadata map[string]string `json:"customMetadata"`
}

func (a *R2Api) createMpu(w http.ResponseWriter, r *http.Request) error {
	body, err := readBodyBuffer(r, 1<<20)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid json"})
		return nil
	}
	var req createMpuBody
	if len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, &req) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid json"})
		return nil
	}
	key, ok := safeKey(req.Key)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "invalid key"})
		return nil
	}
	uploadID, err := a.s3.createMultipart(key)
	if err != nil {
		return err
	}
	id := fmt.Sprintf("fd-%d-%d", time.Now().UnixMilli(), a.mpuSeq.Add(1)-1)
	a.mu.Lock()
	a.mpu[id] = &mpuEntry{
		key:        key,
		s3UploadID: uploadID,
		meta:       &Sidecar{HTTPMetadata: req.HTTPMetadata, CustomMetadata: req.CustomMetadata},
		parts:      map[int]string{},
	}
	a.mu.Unlock()
	writeJSON(w, 200, map[string]any{"uploadId": id, "key": key})
	return nil
}

func (a *R2Api) getMpu(uploadID string) *mpuEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.mpu[uploadID]
}

func (a *R2Api) uploadPart(w http.ResponseWriter, r *http.Request, uploadID string, partNumber int) error {
	entry := a.getMpu(uploadID)
	if entry == nil {
		writeJSON(w, 404, map[string]string{"error": "no such upload"})
		return nil
	}
	// rclone serve s3 的 UploadPart 强制要求 Content-Length（chunked 会 411），
	// 而 workerd 流式请求没有长度 —— 缓冲整个分块后带长度转发（分块大小由客户端定，通常 ≤100MB）。
	buf, err := readBodyBuffer(r, 512<<20)
	if err != nil {
		return err
	}
	etag, err := a.s3.uploadPart(entry.key, entry.s3UploadID, partNumber, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	a.mu.Lock()
	entry.parts[partNumber] = etag
	a.mu.Unlock()
	writeJSON(w, 200, map[string]any{"partNumber": partNumber, "etag": etag})
	return nil
}

type completeMpuBody struct {
	Parts []struct {
		PartNumber any `json:"partNumber"`
		ETag       any `json:"etag"`
	} `json:"parts"`
}

type completeMpuResp struct {
	Key            string            `json:"key"`
	ETag           string            `json:"etag"`
	Mtime          int64             `json:"mtime"`
	HTTPMetadata   *R2HttpMetadata   `json:"httpMetadata"`
	CustomMetadata map[string]string `json:"customMetadata"`
}

func (a *R2Api) completeMpu(w http.ResponseWriter, r *http.Request, uploadID string) error {
	entry := a.getMpu(uploadID)
	if entry == nil {
		writeJSON(w, 404, map[string]string{"error": "no such upload"})
		return nil
	}
	body, err := readBodyBuffer(r, 1<<20)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid json"})
		return nil
	}
	var req completeMpuBody
	if len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, &req) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid json"})
		return nil
	}
	parts := make([]s3Part, 0, len(req.Parts))
	for _, p := range req.Parts {
		pn := 0
		if v, ok := p.PartNumber.(float64); ok {
			pn = int(v)
		}
		et := ""
		switch v := p.ETag.(type) {
		case string:
			et = v
		case nil:
		default:
			et = fmt.Sprint(v)
		}
		parts = append(parts, s3Part{PartNumber: pn, ETag: et})
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	for i := range parts {
		if parts[i].PartNumber < 1 || (i > 0 && parts[i].PartNumber <= parts[i-1].PartNumber) {
			writeJSON(w, 400, map[string]string{"error": "partNumber 必须升序且不重复"})
			return nil
		}
	}
	if err := a.s3.completeMultipart(entry.key, entry.s3UploadID, parts); err != nil {
		return err
	}
	// 落 sidecar
	head, err := a.s3.head(entry.key)
	if err != nil {
		return err
	}
	etag := ""
	if head != nil {
		etag = head.Get("Etag")
	}
	if entry.meta.HTTPMetadata != nil || entry.meta.CustomMetadata != nil {
		if err := a.saveMeta(entry.key, entry.meta, etag); err != nil {
			return err
		}
	}
	a.mu.Lock()
	delete(a.mpu, uploadID)
	a.mu.Unlock()
	writeJSON(w, 200, completeMpuResp{
		Key:            entry.key,
		ETag:           etag,
		Mtime:          time.Now().UnixMilli(),
		HTTPMetadata:   entry.meta.HTTPMetadata,
		CustomMetadata: entry.meta.CustomMetadata,
	})
	return nil
}

func (a *R2Api) abortMpu(w http.ResponseWriter, uploadID string) error {
	entry := a.getMpu(uploadID)
	if entry == nil {
		writeJSON(w, 404, map[string]string{"error": "no such upload"})
		return nil
	}
	if err := a.s3.abortMultipart(entry.key, entry.s3UploadID); err != nil {
		return err
	}
	a.mu.Lock()
	delete(a.mpu, uploadID)
	a.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// ---- 工具 ----

func writeJSON(w http.ResponseWriter, status int, body any) {
	payload, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func readBodyBuffer(r *http.Request, maxBytes int64) ([]byte, error) {
	buf, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	r.Body.Close()
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > maxBytes {
		return nil, fmt.Errorf("part too large (> %d bytes)", maxBytes)
	}
	return buf, nil
}

func atoiOr(s string, fallback int64) int64 {
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	return fallback
}

// 认证：R2 API 用 Bearer token（shim 机器对机器）；管理平面用独立账号密码（Basic）。
package main

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strings"
)

func bearerAuth(r *http.Request, token string) bool {
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return false
	}
	given := strings.TrimSpace(auth[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(given), []byte(token)) == 1
}

// mgmtBasicAuth 管理平面 Basic 认证（DAEMON_MGMT_USER / DAEMON_MGMT_PASS，timing-safe 比较）。
func mgmtBasicAuth(r *http.Request, user, pass string) bool {
	auth := r.Header.Get("Authorization")
	const prefix = "Basic "
	if !strings.HasPrefix(auth, prefix) {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(auth[len(prefix):]))
	if err != nil {
		return false
	}
	cred := string(raw)
	idx := strings.Index(cred, ":")
	if idx < 0 {
		return false
	}
	okUser := subtle.ConstantTimeCompare([]byte(cred[:idx]), []byte(user)) == 1
	okPass := subtle.ConstantTimeCompare([]byte(cred[idx+1:]), []byte(pass)) == 1
	return okUser && okPass
}

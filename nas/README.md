# Davflare NAS 自部署（workerd + daemon）

在自己的 NAS 上用 Docker 跑 Davflare：**文件以原始文件名落在本地目录**（文件管理器直接可浏览），同时提供到云端 Cloudflare R2 的同步。不依赖 Cloudflare Pages，不改 Davflare 业务代码。

## 架构

```
┌─ NAS Docker ─────────────────────────────────────────────┐
│                                                          │
│  davflare（官方 cloudflare/workerd 镜像）                  │
│    worker.js = functions/ 业务代码 + R2Shim + 内嵌静态资源   │
│    capnp 注入 bindings（无 r2Bucket —— shim 注入 env.BUCKET）│
│         │ HTTP :9000 (Bearer token)                      │
│         ▼                                                │
│  daemon（官方 rclone/rclone 镜像 + Go 静态二进制，无 Node）  │
│    ├─ R2 API :9000   R2Bucket 语义 → rclone serve s3      │
│    │                 元数据 sidecar（_fdmeta/，list 隐藏）   │
│    ├─ 同步引擎       rclone sync/bisync 子进程 → 云端 R2    │
│    └─ 管理平面 :9001 Vite+React+shadcn/ui 管理界面（go:embed）│
│         │            登录 / 三板块（自动同步·手动同步·历史）   │
│         ▼                                                │
│  ./data/webdav/  ← 原始文件，NAS 文件管理器直接浏览           │
│         │ rclone bisync（定时/手动）                       │
│         ▼                                                │
│  云端 Cloudflare R2 bucket                                │
└──────────────────────────────────────────────────────────┘
```

两个容器：**daemon**（存储+同步+管理，`daemon-go/`，纯 Go stdlib 单二进制 ~6.9MB——管理前端经 `go:embed` 打进二进制，基底 `rclone/rclone` 镜像共 ~134MB）与 **davflare**（workerd 运行时）。workerd 侧的 `R2Shim`（`workerd/src/r2-shim.ts`，约 300 行）实现 R2Bucket 全接口（get/put/head/delete/list + multipart 三段式 + onlyIf 条件 + range 断点），业务代码零改动。

## 部署步骤

### 1. 构建产物（宿主机，需 Node ≥ 20 + Go ≥ 1.22）

```bash
# 前端 + 类型检查（仓库根目录）
npm install && npm run build

# daemon（build.sh 自动完成：管理前端 Vite+React 构建 → web/dist → go:embed → 交叉编译）
cd nas/daemon-go && ./build.sh

# workerd bundle（functions/ + shim + build/ 静态资源内嵌）
cd ../workerd && npm install && npm run build
```

### 2. 配置

```bash
cd nas
cp .env.example .env         # 填 DAEMON_TOKEN / DAEMON_MGMT_PASS / WEBDAV_PASSWORD / R2 凭据
# 编辑 workerd/davflare.compose.capnp：
#   DAEMON_TOKEN 与 .env 一致；WEBDAV_PASSWORD 与 .env 一致
```

### 3. 云端同步（可选）

凭据二选一，**推荐方式 A（免配置文件）**：

**方式 A：.env 直接填 Cloudflare R2 凭据**（rclone env-var 远端配置）：

```bash
RCLONE_CONFIG_R2_TYPE=s3
RCLONE_CONFIG_R2_PROVIDER=Cloudflare
RCLONE_CONFIG_R2_ACCESS_KEY_ID=<R2 Access Key ID>
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<R2 Secret Access Key>
RCLONE_CONFIG_R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
```

**方式 B**：`config/rclone/rclone.conf` 写 `[r2]` 段（type/provider/access_key_id/secret_access_key/endpoint），并在 `.env` 设 `RCLONE_CONFIG=/config/rclone/rclone.conf`。

凭据获取：Cloudflare Dashboard → R2 → **Manage API Tokens** → Create API Token（Object Read & Write，页面同时给出 account_id / endpoint）。

同步方式与计划**不进 env，全部在管理平面 `http://NAS_IP:9001` 页面设置**（登录 = `.env` 的 `DAEMON_MGMT_USER` / `DAEMON_MGMT_PASS`，独立于 Davflare 的 WebDAV 账号）：push/pull/bisync、cron 或间隔分钟、远端名/桶名，保存即时生效并持久化到 `config/daemon-config.json`。
**bisync 首次必须手动 resync**：管理平面 → 「bisync --resync(首跑)」按钮；之后按计划/手动。
同步参数已自动排除 daemon 内部数据：`_fdmeta/**`（元数据 sidecar）与 `.rclone_temp_multipart_*`（上传临时文件）不会上云。

### 4. 启动

```bash
docker compose up -d --build
```

访问：
- **Davflare Web UI**: `http://NAS_IP:8788`（账号密码 = capnp 里的 `WEBDAV_USERNAME/PASSWORD`）
- **WebDAV**: `http://NAS_IP:8788/webdav/`（Windows/Mac 可挂载为网络磁盘）
- **管理平面**: `http://NAS_IP:9001`（内嵌管理界面：品牌导航栏 + 三板块——**自动同步**（方式 + cron 可视化构建器与中文预览）、**手动同步**（push/pull/bisync/resync）、**同步历史**（50 条，可展开输出）；navbar 含服务状态灯：正在同步=黄、正常=绿、不可用=红；主题色与 Davflare 品牌橙一致；登录 = `.env` 的 `DAEMON_MGMT_USER/DAEMON_MGMT_PASS`）
  - 分工：**同步方式与 cron 在页面配置**；**远端/云端桶仅环境变量**（`DAEMON_REMOTE` / `DAEMON_REMOTE_BUCKET`）
  - 前端技术栈：Vite + React + **shadcn/ui**（Tailwind v4）+ **@vpfaiz/cron-builder-ui**（可视化 cron 构建，内置 cronstrue 描述）；中文预览（描述/未来 5 次/24 小时时间轴）为自研组件
- **本地原始文件**: `nas/data/webdav/`（与云端 R2 内容一致）

## 本地开发/测试（不经 Docker）

```bash
# 终端 1：daemon（数据用临时目录）
cd nas/daemon-go && ./build.sh
DAEMON_DATA_DIR=/tmp/davflare-nas-test DAEMON_TOKEN=local-dev-token \
  DAEMON_R2_PORT=9030 ./bin/daemon-darwin-arm64

# 终端 2：workerd（npm 版二进制）
cd nas/workerd && npx workerd serve davflare.capnp config
# → http://127.0.0.1:8788
```

本机裸机开发 R2 API 用 **9030**（`davflare.capnp` 已指向 `127.0.0.1:9030`）：9000 常被本机其他 dev 服务占用（MinIO 等）。Docker 场景不受影响（9000 只在容器网络内部）。

`davflare.capnp`（127.0.0.1:9030）、`davflare.docker.capnp`（host.docker.internal:9000，单容器跑镜像时用）、`davflare.compose.capnp`（compose 网络，daemon 服务名）三者除 DAEMON_URL 外完全一致。


## 已验证（本机 + 官方 cloudflare/workerd / rclone/rclone 镜像，2026-11-25）

| 项 | 结果 |
|---|---|
| Go daemon 直连 R2 API 57 项全矩阵（认证 / list / sidecar / range / onlyIf 412 / multipart sha256 / 幂等删除 / safeKey 防护），连续两轮 | ✅ |
| workerd 全链路（UI 静态 + 安全头 / WebDAV 中文 PUT/MKCOL/PROPFIND/GET / API key→upload/download/rename / 回收站 soft→restore→purge） | ✅ |
| 本地目录 ↔ 界面双向 CRUD（手动建/改/删 → UI 刷新可见；UI 建目录/记事本/重命名/回收站彻底删除 → 磁盘同步正确） | ✅ |
| 官方 cloudflare/workerd 镜像 + capnp 挂载 | ✅ |
| 官方 rclone/rclone 镜像 + Go 静态二进制（容器内 spawn rclone、宿主卷原始落盘、全往返冒烟） | ✅ |
| **docker compose 两容器全量矩阵 57/57**（workerd:8788 + daemon，全新空库环境） | ✅ |
| 管理界面（Vite+React+shadcn/ui，go:embed 内嵌）：账号密码登录 / 三板块（自动同步·手动同步·历史）/ 品牌导航栏与服务状态灯，SPA 回退与 assets 长缓存 | ✅ |
| cron 组件：@vpfaiz/cron-builder-ui 可视化构建（Never/Hourly/Daily… 切换）+ 中文预览（描述/未来 5 次/24 小时时间轴/预设/非法表达式实时报错），浏览器实测闭环 | ✅ |
| 同步计划 cron 双模式（cron 优先/间隔兜底；非法 cron 400；nextRun 展示） | ✅ |

## 目录约定

| 路径 | 说明 |
|---|---|
| `nas/data/<bucket>/` | 原始文件（bucket 内容）；`_$flaredrive$/` 是 Davflare 内部元数据，`_fdmeta/` 是 daemon 元数据 sidecar，**勿手动改** |
| `nas/config/` | rclone.conf、daemon 运行时配置 |
| `nas/daemon-go/` | Go daemon 源码 + `./build.sh` 构建产物（`bin/daemon-linux-*` 进镜像）；`web/` 是 Vite+React+shadcn/ui 管理前端（构建后 `web/dist` 被 go:embed 内嵌） |
| `nas/workerd/worker.js` | 构建产物（`npm run build` 重新生成；改 UI 后需重建） |

## 已知限制

- multipart 分块在 daemon 侧缓冲后带长度转发（rclone serve s3 的 UploadPart 要求 Content-Length），单分块上限 512MB
- bisync 首次必须 `--resync`（rclone 语义）；daemon 重启会丢失进行中的 multipart 会话（未 complete 的分块作废）
- rclone serve s3 的 VFS 目录缓存 5s 窗口内，极偶发对同一新目录的 MKCOL 竞态（重试即成功，已观测一次）
- `SITES_HOST` 静态站点/图床公网域名功能在纯本地部署默认关闭（capnp 里留空即可）

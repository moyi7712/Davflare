#!/usr/bin/env bash
# 构建 daemon：管理前端（Vite+React）打进 Go 二进制（go:embed），无 Node 运行时。
#   1) 管理前端 → web/dist（需 Node ≥ 20）
#   2) Go 交叉编译 linux/amd64 + linux/arm64 → Docker（rclone/rclone 基底）
#      darwin/arm64 → 本机直接测试
set -euo pipefail
cd "$(dirname "$0")"

echo "== 构建管理前端 web/ → web/dist"
if [ ! -d web/node_modules ]; then
  (cd web && npm install --no-fund --no-audit)
fi
(cd web && npm run build)

mkdir -p bin
for target in linux/amd64 linux/arm64 darwin/arm64; do
  os=${target%/*}; arch=${target#*/}
  echo "== build bin/daemon-$os-$arch"
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags "-s -w" -o "bin/daemon-$os-$arch" .
done
ls -lh bin/

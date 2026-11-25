# daemon-go：官方 rclone 镜像 + 单个静态 Go 二进制（rclone 已在镜像内，无 Node）
# 使用前先跑 ./build.sh 生成本目录 bin/ 下的交叉编译产物
FROM rclone/rclone:latest

ARG TARGETARCH=amd64
COPY bin/daemon-linux-${TARGETARCH} /usr/local/bin/davflare-daemon

# 镜像自带 /usr/local/bin/rclone（serve s3 / bisync 全功能），daemon 直接 exec 其子进程
ENTRYPOINT ["/usr/local/bin/davflare-daemon"]

# Davflare workerd 配置：workerd serve davflare.capnp config 直接启动。
# worker.js 由 nas/workerd/build.mjs 打包生成（functions/ 业务代码 + R2 shim + 内嵌静态资源）。
# BUCKET 不是 capnp r2Bucket —— 开源 workerd 未含 R2 实现，由 worker 入口注入 R2Shim，
# 走 daemon（rclone serve s3 二次封装）暴露的 R2 API。
using Workerd = import "node_modules/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    # 允许 worker 访问本机 loopback（daemon 的 R2 API）；默认 internet 服务只放行公网
    (name = "daemon-net", network = (allow = ["local", "private"])),
    (name = "davflare",
      worker = (
        modules = [
          (name = "worker", esModule = embed "worker.js")
        ],
        compatibilityDate = "2024-06-20",
        bindings = [
          (name = "DAEMON_URL", text = "http://daemon:9000"),
          (name = "DAEMON_TOKEN", text = "local-dev-token"),
          (name = "WEBDAV_USERNAME", text = "admin"),
          (name = "WEBDAV_PASSWORD", text = "fd-e2e-pass"),
          (name = "WEBDAV_PUBLIC_READ", text = "0"),
          (name = "TRASH_RETENTION_DAYS", text = "30"),
          (name = "SITES_HOST", text = "")
        ],
        globalOutbound = "daemon-net"
      )
    )
  ],
  sockets = [
    (name = "http", address = "*:8788", service = "davflare", http = ())
  ]
);

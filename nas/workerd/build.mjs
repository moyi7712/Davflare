// 打包 workerd bundle：
// 1) 递归读取仓库根 build/（vite 产物）→ src/assets.json（base64 + contentType + etag）
// 2) esbuild 把 src/worker-entry.ts + functions/ 打成 worker.js（ESM, neutral platform）
// 3) 与 davflare.capnp 同目录，供官方 cloudflare/workerd 镜像直接 serve
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoBuildDir = resolve(here, "../../build"); // nas/workerd → nas → repo root/build

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
  ".map": "application/json", ".webmanifest": "application/manifest+json", ".xml": "application/xml",
};

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else out.push({ path: relative(base, p).split("\\").join("/"), size: st.size });
  }
  return out;
}

const files = walk(repoBuildDir).filter((f) => !f.path.startsWith("_")); // _headers 等元数据不嵌入
const assets = {};
for (const f of files) {
  const buf = readFileSync(join(repoBuildDir, f.path));
  const etag = `"${createHash("md5").update(buf).digest("hex").slice(0, 16)}"`;
  assets[f.path] = {
    b64: buf.toString("base64"),
    type: MIME[extname(f.path).toLowerCase()] || "application/octet-stream",
    etag,
  };
}
writeFileSync(join(here, "src/assets.json"), JSON.stringify(assets));
console.log(`assets.json: ${Object.keys(assets).length} 个文件, ${Object.values(assets).reduce((s, a) => s + a.b64.length, 0)} B(base64)`);

await esbuild.build({
  entryPoints: [join(here, "src/worker-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: join(here, "worker.js"),
  legalComments: "none",
  mainFields: ["module", "main"], // neutral 平台需显式配置（@xmldom/xmldom 只有 main）
  // functions/ 是纯 Workers 代码，无 Node 依赖
});
console.log("worker bundle -> worker.js");

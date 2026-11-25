// workerd 入口：把 Cloudflare Pages 的文件路由收敛为标准 Worker。
// 语义对齐 Pages：_middleware 先于路由/静态资源执行；路由命中优先于静态资源；
// 未命中方法返回 405（带 Allow）；静态资源应用 build/_headers 全局头。
import { R2Shim } from "./r2-shim";
import ASSETS from "./assets.json";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (context: any) => Promise<Response>;

import * as middleware from "../../../functions/_middleware";
import * as apiArchive from "../../../functions/api/archive";
import * as apiBackup from "../../../functions/api/backup";
import * as apiCollects from "../../../functions/api/collects";
import * as apiConfig from "../../../functions/api/config";
import * as apiCopy from "../../../functions/api/copy";
import * as apiCounts from "../../../functions/api/counts";
import * as apiDelete from "../../../functions/api/delete";
import * as apiDownload from "../../../functions/api/download";
import * as apiImages from "../../../functions/api/images";
import * as apiKeys from "../../../functions/api/keys";
import * as apiList from "../../../functions/api/list";
import * as apiMkdir from "../../../functions/api/mkdir";
import * as apiRename from "../../../functions/api/rename";
import * as apiSearch from "../../../functions/api/search";
import * as apiSetup from "../../../functions/api/setup";
import * as apiShares from "../../../functions/api/shares";
import * as apiSites from "../../../functions/api/sites";
import * as apiStat from "../../../functions/api/stat";
import * as apiTrash from "../../../functions/api/trash";
import * as apiUpload from "../../../functions/api/upload";
import * as mcpMod from "../../../functions/mcp";
import * as collectMod from "../../../functions/collect/[[token]]";
import * as shareMod from "../../../functions/share/[[token]]";
import * as webdavMod from "../../../functions/webdav/[[path]]";

interface RouteDef {
  re: RegExp;
  mod: Record<string, AnyFn>;
  /** [[param]] 可选 catch-all：命中时取剩余路径（可为多段） */
  param?: string;
}

const METHOD_SUFFIX: Record<string, string> = {
  GET: "Get", POST: "Post", PUT: "Put", DELETE: "Delete", HEAD: "Head", OPTIONS: "Options", PATCH: "Patch",
};

const ROUTES: RouteDef[] = [
  ...[
    ["archive", apiArchive], ["backup", apiBackup], ["collects", apiCollects], ["config", apiConfig],
    ["copy", apiCopy], ["counts", apiCounts], ["delete", apiDelete], ["download", apiDownload],
    ["images", apiImages], ["keys", apiKeys], ["list", apiList], ["mkdir", apiMkdir],
    ["rename", apiRename], ["search", apiSearch], ["setup", apiSetup], ["shares", apiShares],
    ["sites", apiSites], ["stat", apiStat], ["trash", apiTrash], ["upload", apiUpload],
  ].map(([name, mod]) => ({ re: new RegExp(`^/api/${name as string}$`), mod: mod as Record<string, AnyFn> })),
  { re: /^\/mcp$/, mod: mcpMod as unknown as Record<string, AnyFn> },
  { re: /^\/collect(?:\/(.*))?$/, mod: collectMod as unknown as Record<string, AnyFn>, param: "token" },
  { re: /^\/share(?:\/(.*))?$/, mod: shareMod as unknown as Record<string, AnyFn>, param: "token" },
  { re: /^\/webdav(?:\/(.*))?$/, mod: webdavMod as unknown as Record<string, AnyFn>, param: "path" },
];

// build/_headers 的全局规则（/* 段），对所有静态资源生效
const GLOBAL_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

interface AssetEntry { b64: string; type: string; etag: string }

function assetResponse(status: number, pathname: string, entry: AssetEntry | null, request: Request): Response {
  if (!entry) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const headers = new Headers(GLOBAL_HEADERS);
  headers.set("content-type", entry.type);
  headers.set("etag", entry.etag);
  const isHashed = pathname.startsWith("/assets/");
  headers.set("cache-control", isHashed ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
  const inm = request.headers.get("if-none-match");
  if (inm && inm === entry.etag) {
    return new Response(null, { status: 304, headers });
  }
  const bin = atob(entry.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { status, headers });
}

function serveStatic(pathname: string, request: Request): Response {
  if (pathname === "/" || pathname === "") {
    return assetResponse(200, "/index.html", ASSETS["index.html"] as AssetEntry, request);
  }
  const clean = pathname.replace(/\\/g, "/");
  if (clean.includes("..")) return new Response("Not Found", { status: 404 });
  const exact = ASSETS[clean.replace(/^\//, "")] as AssetEntry | undefined;
  if (exact) return assetResponse(200, clean, exact, request);
  // 目录式：/foo → /foo/index.html
  const dirIndex = ASSETS[`${clean.replace(/^\//, "")}/index.html`] as AssetEntry | undefined;
  if (dirIndex) return assetResponse(200, `${clean}/index.html`, dirIndex, request);
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function dispatchRoute(
  route: RouteDef,
  params: Record<string, string | string[]>,
  request: Request,
  env: Record<string, unknown>,
  ctx: { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void },
  data: Record<string, unknown>
): Response | Promise<Response> {
  const method = request.method.toUpperCase();
  const mod = route.mod;
  let handler: AnyFn | undefined;
  if (method === "HEAD") handler = mod.onRequestHead ?? mod.onRequestGet ?? mod.onRequest;
  else handler = mod[`onRequest${METHOD_SUFFIX[method] ?? ""}`] ?? mod.onRequest;
  if (!handler) {
    const allow = Object.keys(mod)
      .filter((k) => k.startsWith("onRequest"))
      .map((k) => (k === "onRequest" ? "*" : k.slice("onRequest".length).toUpperCase()))
      .join(", ");
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow || "*" } });
  }
  const context = { request, env, params, ctx, data, next: async () => serveStatic(new URL(request.url).pathname, request) };
  return handler(context);
}

interface Env {
  DAEMON_URL: string;
  DAEMON_TOKEN: string;
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
    // 注入自定义 R2 binding（capnp 里没有 r2Bucket 可用 —— 开源 workerd 未含 R2 实现）
    (env as Record<string, unknown>).BUCKET = new R2Shim(env.DAEMON_URL, env.DAEMON_TOKEN);

    const pathname = new URL(request.url).pathname;
    let matched: RouteDef | null = null;
    let params: Record<string, string | string[]> = {};
    for (const route of ROUTES) {
      const m = route.re.exec(pathname);
      if (m) {
        matched = route;
        if (route.param) params[route.param] = m[1];
        break;
      }
    }

    const data: Record<string, unknown> = {};
    const fullCtx = {
      waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
      passThroughOnException: () => {},
    };
    const next = async (): Promise<Response> => {
      if (matched) return dispatchRoute(matched, params, request, env as unknown as Record<string, unknown>, fullCtx, data);
      return serveStatic(pathname, request);
    };

    // Pages 语义：根 _middleware 对每个请求先执行（含静态资源请求）
    const middlewareCtx = { request, env, params: {}, data, ctx: fullCtx, next };
    return (middleware as unknown as { onRequest: AnyFn }).onRequest(middlewareCtx);
  },
};

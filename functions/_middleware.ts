import { gateDriveProductRoute, loadFeatureFlags } from "./_flags";
import {
  imageObjectKey,
  imageResponseHeaders,
  resolveSitesHostRoute,
} from "./_images";
import {
  indexFallbackKey,
  isSiteFolderMarker,
  isSitesHost,
  loadSiteConfig,
  loadSlugForHostname,
  parseSitesRootPath,
  refSourceKey,
  siteConfigPolicyAt,
  siteNotFoundKey,
  sitePasswordAuthorized,
  siteSpaKey,
  sitesNotFound,
  sitesNotFoundPage,
  sitesResponse,
  sitesSlashRedirect,
  sitesUnauthorized,
  SITES_PREFIX,
} from "./_sites";
import {
  SITE_MANIFEST_NAMES,
  SiteServePolicy,
  isActiveSiteFile,
  loadSiteServePolicy,
  siteFileForcesDownload,
} from "./siteManifest";
import { isCollectionObject } from "./api/_apikey";
import { etagMatches, mimeForKey, notModifiedSince, siteVariantEtag } from "./_sites";

interface MiddlewareEnv {
  BUCKET: R2Bucket;
  SITES_HOST?: string;
}

async function serveImage(
  bucket: R2Bucket,
  id: string,
  head: boolean
): Promise<Response> {
  const object = await bucket.get(imageObjectKey(id));
  if (object === null) return sitesNotFound();
  const contentType =
    object.customMetadata?.contentType ||
    object.httpMetadata?.contentType ||
    "application/octet-stream";
  const filename = object.customMetadata?.name;
  const headers = imageResponseHeaders({
    contentType,
    filename,
    etag: object.httpEtag,
  });
  return new Response(head ? null : object.body, { status: 200, headers });
}

/**
 * 解析单段 Range 头（bytes=start-end / start- / -suffix）。
 * null = 无 Range；"invalid" = 语法错误（回 416）；多段 Range 一律按无 Range 处理（回全量 200）。
 * offset-only（start-）转成超大 length：官方 R2 与 shim 都会把越界 length 截到对象末尾。
 */
function parseRangeHeader(raw: string | null): R2Range | "invalid" | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("bytes=")) return "invalid";
  const spec = trimmed.slice(6);
  if (spec.includes(",")) return null; // 多段：不支持，回全量
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return "invalid";
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return "invalid";
  if (startStr === "") {
    const suffix = Number(endStr);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : "invalid";
  }
  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0) return "invalid";
  if (endStr === "") {
    return { offset: start, length: Number.MAX_SAFE_INTEGER };
  }
  const end = Number(endStr);
  if (!Number.isSafeInteger(end) || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

function rangeNotSatisfiable(detail: string): Response {
  return new Response(detail, {
    status: 416,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * refMode 引用回源：把站点路径 miss 的请求映射到网盘源文件，流式返回（不写副本）。
 * - 支持 Range（媒体拖动）：单段 Range 转 R2 range 读，命中回 206 + Content-Range；
 * - 协商缓存：ETag / Last-Modified 透传源对象，命中回 304；
 * - 安全：引用进来的 active 类型（html/svg/js…）一律强制下载 + CSP sandbox，
 *   与生成型站点同规则——共享站点域名上不执行任何网盘侧内容。
 * 返回 null = 源文件也不存在，调用方继续走 SPA / 404 兜底。
 */
async function serveRefObject(
  context: EventContext<MiddlewareEnv, any, any>,
  sourceKey: string,
  rel: string,
  method: string,
  opts: { privateCache: boolean; configPolicyAt: Date | null }
): Promise<Response | null> {
  const range = parseRangeHeader(context.request.headers.get("Range"));
  if (range === "invalid") return rangeNotSatisfiable("Bad Range");

  const object = range
    ? await context.env.BUCKET.get(sourceKey, { range })
    : await context.env.BUCKET.get(sourceKey);
  if (!object || isCollectionObject(object) || isSiteFolderMarker(sourceKey, object)) return null;

  // 引用进来的 active 类型（html/svg/js…）一律按附件下载：variant 进 ETag（#170）
  const download = isActiveSiteFile(rel.toLowerCase());
  const etag = siteVariantEtag(object.httpEtag, { download, privateCache: opts.privateCache });
  const lastModified = object.uploaded instanceof Date ? object.uploaded : null;

  // Range 命中：206 + Content-Range（此时忽略 If-None-Match 等条件头）
  if (range) {
    const total = object.size;
    const start = "suffix" in range ? Math.max(0, total - range.suffix) : Math.max(0, range.offset ?? 0);
    if (start >= total) return rangeNotSatisfiable("Range start beyond end of object");
    const requested = "suffix" in range ? total : (range.length ?? total - start);
    const end = Math.min(start + requested, total) - 1;
    const length = end - start + 1;
    if (length <= 0) return rangeNotSatisfiable("Empty range");
    const headers = new Headers({
      "Content-Type": mimeForKey(sourceKey),
      "Content-Length": String(length),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": opts.privateCache ? "private, no-cache" : "public, no-cache",
    });
    if (opts.privateCache) headers.set("Vary", "Authorization");
    if (etag) headers.set("ETag", etag);
    if (lastModified) headers.set("Last-Modified", lastModified.toUTCString());
    if (download) {
      headers.set("Content-Disposition", `attachment; filename="${rel.split("/").pop() || "file"}"`);
      headers.set("Content-Security-Policy", "sandbox");
    }
    return new Response(method === "HEAD" ? null : object.body, { status: 206, headers });
  }

  // 无 Range：条件请求先判 304（只对全量响应有意义）
  const notModified = context.request.headers.get("If-None-Match")
    ? etagMatches(context.request.headers.get("If-None-Match"), etag)
    : notModifiedSince(context.request.headers.get("If-Modified-Since"), lastModified);
  if (notModified) {
    try {
      void object.body?.cancel().catch(() => undefined);
    } catch {
      // ignore
    }
    const headers = new Headers({ "Cache-Control": opts.privateCache ? "private, no-cache" : "public, no-cache" });
    if (opts.privateCache) headers.set("Vary", "Authorization");
    if (etag) headers.set("ETag", etag);
    if (lastModified) headers.set("Last-Modified", lastModified.toUTCString());
    return new Response(null, { status: 304, headers });
  }

  return sitesResponse(
    { body: object.body, httpEtag: object.httpEtag, uploaded: object.uploaded },
    sourceKey,
    method === "HEAD",
    {
      privateCache: opts.privateCache,
      download,
      ifNoneMatch: null, // 上面已判过 304
      ifModifiedSince: null,
      configPolicyAt: opts.configPolicyAt,
      acceptRanges: true,
    }
  );
}

async function serveSlugSite(
  context: EventContext<MiddlewareEnv, any, any>,
  parsed: { slug: string; key: string; tryIndex: boolean; redirectToSlash?: boolean }
): Promise<Response> {
  const method = context.request.method.toUpperCase();
  // 站点根不带斜杠：无条件跳转，不读 R2，也不泄露站点是否存在 / 是否加密（#145）
  if (parsed.redirectToSlash) return sitesSlashRedirect(context.request.url);
  // Password gate runs before any content (and before a future _redirects hook).
  // Load config once up front so SPA/404 reuse it without a second R2 get.
  const config = await loadSiteConfig(context.env.BUCKET, parsed.slug);
  const passwordHash = config?.passwordHash;
  const configPolicyAt = siteConfigPolicyAt(config);
  const privateCache = Boolean(passwordHash);
  if (passwordHash) {
    if (!(await sitePasswordAuthorized(context.request, passwordHash))) {
      return sitesUnauthorized();
    }
  }

  // 生成型站点（公开目录 / 相册 / 文档站）里的 active 文件强制下载（#146）。
  // 清单只在请求 active 类型时才读，且与正文读取并行；同一请求内最多读一次。
  const sitePrefix = `${SITES_PREFIX}${parsed.slug}/`;
  // 站点根的清单文件是内部记录（列着所有生成文件），不对外提供（#147）
  if ((SITE_MANIFEST_NAMES as readonly string[]).includes(parsed.key.slice(sitePrefix.length))) {
    return sitesNotFound();
  }
  let policyPromise: Promise<SiteServePolicy> | null = null;
  const loadPolicy = () => (policyPromise ??= loadSiteServePolicy(context.env.BUCKET, sitePrefix));
  const forcesDownload = async (objectKey: string): Promise<boolean> => {
    const rel = objectKey.slice(sitePrefix.length);
    if (!siteFileForcesDownload("dir", rel)) return false; // 不是 active 类型 / 是首页：无需读清单
    const policy = await loadPolicy();
    return siteFileForcesDownload(policy.kind, rel, policy.docsPages);
  };
  if (siteFileForcesDownload("dir", parsed.key.slice(sitePrefix.length))) {
    policyPromise = loadSiteServePolicy(context.env.BUCKET, sitePrefix);
  }

  const key = parsed.key;
  let object: R2ObjectBody | null = await context.env.BUCKET.get(key);
  // 文件夹标记对象（MKCOL / 新建文件夹 / 上传 API 建的目录）按目录处理，绝不当空文件 200 返回（#157）
  const folderMarker = isSiteFolderMarker(key, object);
  if (folderMarker) object = null; // 标记对象是 0 字节，不读正文
  if (!object && (parsed.tryIndex || folderMarker) && !key.endsWith("/")) {
    // `/{slug}/sub` 不是文件但 `sub/index.html` 存在：跳到 `/{slug}/sub/`，
    // 否则页面里的相对链接会按上一级目录解析（#145）。只需 head，不读正文。
    const indexHead = await context.env.BUCKET.head(indexFallbackKey(parsed.key));
    if (indexHead) return sitesSlashRedirect(context.request.url, { privateCache });
  }
  if (!object) {
    // refMode 引用模式：站点路径 miss 时按配置映射回网盘源文件流式返回（不写副本）。
    // 源也没有时返回 null，继续走下面的 SPA / 404 兜底；映射函数自带穿越校验。
    if (config?.refMode) {
      const rel = parsed.key.slice(sitePrefix.length);
      const sourceKey = refSourceKey(config, rel);
      if (sourceKey) {
        const served = await serveRefObject(context, sourceKey, rel, method, {
          privateCache,
          configPolicyAt,
        });
        if (served) return served;
      }
    }
    if (config?.spa) {
      const spaObject = await context.env.BUCKET.get(siteSpaKey(parsed.slug));
      if (spaObject) {
        return sitesResponse(
          { body: spaObject.body, httpEtag: spaObject.httpEtag, uploaded: spaObject.uploaded },
          siteSpaKey(parsed.slug),
          method === "HEAD",
          {
            privateCache,
            ifNoneMatch: context.request.headers.get("If-None-Match"),
            ifModifiedSince: context.request.headers.get("If-Modified-Since"),
            configPolicyAt,
          }
        );
      }
      return sitesNotFound();
    }
    const notFoundObject = await context.env.BUCKET.get(
      siteNotFoundKey(parsed.slug)
    );
    // 自定义 404 页只属于普通静态站。生成型站点（公开目录 / 相册 / 文档站）里的 404.html
    // 要么是复制进来的用户文件（#146），要么是名叫 404.md 的笔记生成的普通页面（#147），都不当 404 页。
    if (notFoundObject && !(await loadPolicy()).kind) {
      return sitesNotFoundPage({ body: notFoundObject.body }, method === "HEAD");
    }
    return sitesNotFound();
  }

  const download = await forcesDownload(key);
  return sitesResponse(
    { body: object.body, httpEtag: object.httpEtag, uploaded: object.uploaded },
    key,
    method === "HEAD",
    {
      privateCache,
      download,
      ifNoneMatch: context.request.headers.get("If-None-Match"),
      ifModifiedSince: context.request.headers.get("If-Modified-Since"),
      // active 类型读过清单：服务规则的修改时间并入 Last-Modified（#170）
      policyUpdatedAt: policyPromise ? (await policyPromise).updatedAt : null,
      // 改回普通站时记下的时间（#173）：清单已删，靠它让 Last-Modified 不倒退
      configPolicyAt,
    }
  );
}

export const onRequest: PagesFunction<MiddlewareEnv> = async (context) => {
  const host =
    context.request.headers.get("Host") ||
    new URL(context.request.url).host;
  const url = new URL(context.request.url);
  const method = context.request.method.toUpperCase();

  if (isSitesHost(host, context.env.SITES_HOST)) {
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    const flags = await loadFeatureFlags(context.env.BUCKET);
    const route = resolveSitesHostRoute(url.pathname, flags);
    if (route.kind === "notFound") return sitesNotFound();
    if (route.kind === "image") {
      return serveImage(context.env.BUCKET, route.id, method === "HEAD");
    }
    return serveSlugSite(context, route);
  }

  // Per-slug custom hostname: serve sites/{slug}/ at the domain root.
  // Order: hostname resolve → password gate (inside serveSlugSite) → content.
  // Skip non-GET/HEAD and drive product prefixes so the drive origin stays cheap.
  // (Custom hostnames should not shadow /api|/webdav|/mcp|/share|/collect.)
  // /collect 是文件收集链接的上传页（#154 N2）：和 /share 一样不查自定义域名，
  // 免得站点里恰好有 collect/ 目录时把收集链接盖掉，也省一次 R2 读。
  const path = url.pathname;
  const skipCustomHostLookup =
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/webdav" ||
    path.startsWith("/webdav/") ||
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path === "/share" ||
    path.startsWith("/share/") ||
    path === "/collect" ||
    path.startsWith("/collect/");
  if ((method === "GET" || method === "HEAD") && !skipCustomHostLookup) {
    const customSlug = await loadSlugForHostname(context.env.BUCKET, host);
    if (customSlug) {
      const flags = await loadFeatureFlags(context.env.BUCKET);
      if (!flags.sites) return sitesNotFound();
      const parsed = parseSitesRootPath(path, customSlug);
      if (!parsed.ok) return sitesNotFound();
      return serveSlugSite(context, parsed);
    }
  }

  // Only hit R2 for product routes; static assets and /api/* skip the extra read.
  if (
    url.pathname === "/webdav" ||
    url.pathname.startsWith("/webdav/") ||
    url.pathname === "/mcp" ||
    url.pathname.startsWith("/mcp/")
  ) {
    const flags = await loadFeatureFlags(context.env.BUCKET);
    const blocked = gateDriveProductRoute(url.pathname, flags, context.request);
    if (blocked) return blocked;
  }

  return context.next();
};

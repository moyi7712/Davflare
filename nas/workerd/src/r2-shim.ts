// R2Bucket 接口的 daemon HTTP 客户端实现（在 workerd 内运行）。
// 覆盖 Davflare 用到的全部面：get/put/head/delete/list + multipart 全套 + onlyIf + range。
// 元数据头走 base64（文件名可能含中文）。

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

const CONDITION_HEADERS = ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "if-range"] as const;

/** R2 range：Headers 或 {offset,length?,suffix?} */
function parseRange(r: unknown): { offset?: number; length?: number; suffix?: number } | null {
  if (r === undefined || r === null) return null;
  if (r instanceof Headers) {
    const v = r.get("range");
    if (!v) return null;
    const m = v.match(/^bytes=(\d*)-(\d*)\s*$/);
    if (!m || (m[1] === "" && m[2] === "")) throw new Error("Invalid range header");
    if (m[1] === "") return { suffix: Number(m[2]) };
    if (m[2] === "") return { offset: Number(m[1]) };
    const off = Number(m[1]);
    const end = Number(m[2]);
    if (end < off) throw new Error("Invalid range header");
    return { offset: off, length: end - off + 1 };
  }
  return r as { offset?: number; length?: number; suffix?: number };
}

interface ShimObject {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  httpEtag: string;
  httpMetadata: Record<string, string> | undefined;
  customMetadata: Record<string, string> | undefined;
  range?: { offset?: number; length?: number; suffix?: number };
}

interface ShimObjectBody extends ShimObject {
  body: ReadableStream<Uint8Array>;
}

export interface ShimListResult {
  objects: ShimObject[];
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

export class R2Shim {
  constructor(private base: string, private token: string) {}

  private h(extra?: Record<string, string>): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${this.token}`);
    return headers;
  }

  private objUrl(key: string): string {
    return `${this.base}/r2/obj/${encodeKeyPath(key)}`;
  }

  private objectFromHeaders(key: string, headers: Headers, range: ReturnType<typeof parseRange>): ShimObject {
    const httpEtag = headers.get("x-fd-etag") || "";
    const obj: ShimObject = {
      key,
      size: Number(headers.get("x-fd-size")) || 0,
      uploaded: new Date(Number(headers.get("x-fd-mtime")) || Date.now()),
      etag: stripQuotes(httpEtag),
      httpEtag,
      httpMetadata: undefined,
      customMetadata: undefined,
    };
    const httpMetaB64 = headers.get("x-fd-http-metadata-b64");
    if (httpMetaB64) obj.httpMetadata = JSON.parse(b64decode(httpMetaB64));
    else {
      const ct = headers.get("x-fd-content-type");
      if (ct) obj.httpMetadata = { contentType: ct };
    }
    const customB64 = headers.get("x-fd-custom-metadata-b64");
    if (customB64) obj.customMetadata = JSON.parse(b64decode(customB64));
    if (range) obj.range = range;
    return obj;
  }

  private applyOnlyIf(headers: Headers, onlyIf: unknown): void {
    if (onlyIf instanceof Headers) {
      for (const name of CONDITION_HEADERS) {
        const v = onlyIf.get(name);
        if (v !== null) headers.set(name, v);
      }
    }
  }

  private applyRange(headers: Headers, range: ReturnType<typeof parseRange>): void {
    if (!range) return;
    if (range.suffix !== undefined) headers.set("x-fd-range-suffix", String(range.suffix));
    else {
      headers.set("x-fd-range-offset", String(range.offset ?? 0));
      if (range.length !== undefined) headers.set("x-fd-range-length", String(range.length));
    }
  }

  async head(key: string): Promise<ShimObject | null> {
    const res = await fetch(this.objUrl(key), { method: "HEAD", headers: this.h() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`daemon head ${res.status}`);
    return this.objectFromHeaders(key, res.headers, null);
  }

  async get(
    key: string,
    opts?: { onlyIf?: Headers; range?: unknown }
  ): Promise<ShimObjectBody | ShimObject | null> {
    const range = parseRange(opts?.range);
    const headers = this.h();
    this.applyRange(headers, range);
    if (opts?.onlyIf) this.applyOnlyIf(headers, opts.onlyIf);
    const res = await fetch(this.objUrl(key), { method: "GET", headers });
    if (res.status === 404) return null;
    if (res.status === 412) return this.objectFromHeaders(key, res.headers, null); // 无 body → 调用方据 "body" in object 判 412
    if (!res.ok) throw new Error(`daemon get ${res.status}`);
    const obj = this.objectFromHeaders(key, res.headers, range ?? undefined) as ShimObjectBody;
    obj.body = res.body!;
    // R2ObjectBody 便捷方法（调用方会 .json()/.text()/.arrayBuffer()，如 API key 校验）
    (obj as unknown as Record<string, unknown>).bodyUsed = false;
    (obj as unknown as Record<string, unknown>).arrayBuffer = () => res.arrayBuffer();
    (obj as unknown as Record<string, unknown>).text = () => res.text();
    (obj as unknown as Record<string, unknown>).json = () => res.json();
    (obj as unknown as Record<string, unknown>).blob = () => res.blob();
    return obj;
  }

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string | Blob | null,
    opts?: { httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string>; onlyIf?: Headers }
  ): Promise<ShimObject | null> {
    const headers = this.h();
    if (opts?.httpMetadata && Object.keys(opts.httpMetadata).length) {
      headers.set("x-fd-http-metadata-b64", b64encode(JSON.stringify(opts.httpMetadata)));
    }
    if (opts?.customMetadata && Object.keys(opts.customMetadata).length) {
      headers.set("x-fd-custom-metadata-b64", b64encode(JSON.stringify(opts.customMetadata)));
    }
    if (opts?.onlyIf) this.applyOnlyIf(headers, opts.onlyIf);
    const init: RequestInit = { method: "PUT", headers, body: value as BodyInit | null };
    if (value instanceof ReadableStream) (init as Record<string, unknown>).duplex = "half";
    const res = await fetch(this.objUrl(key), init);
    if (res.status === 412) return null; // onlyIf 失败 → R2 返回 null
    if (!res.ok) throw new Error(`daemon put ${res.status}`);
    return this.objectFromHeaders(key, res.headers, null);
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.objUrl(key), { method: "DELETE", headers: this.h() });
    if (!res.ok && res.status !== 404) throw new Error(`daemon delete ${res.status}`);
  }

  async list(opts?: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    delimiter?: string;
    limit?: number;
  }): Promise<ShimListResult> {
    const res = await fetch(`${this.base}/r2/list`, {
      method: "POST",
      headers: this.h({ "content-type": "application/json" }),
      body: JSON.stringify({
        prefix: opts?.prefix ?? "",
        cursor: opts?.cursor,
        startAfter: opts?.startAfter,
        delimiter: opts?.delimiter,
        limit: opts?.limit,
      }),
    });
    if (!res.ok) throw new Error(`daemon list ${res.status}`);
    const data = (await res.json()) as {
      objects: Array<{
        key: string;
        size: number;
        uploaded: string;
        etag: string;
        httpMetadata?: Record<string, string>;
        customMetadata?: Record<string, string>;
        isFolder?: boolean;
      }>;
      delimitedPrefixes: string[];
      truncated: boolean;
      cursor: string | null;
    };
    const objects: ShimObject[] = data.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: new Date(o.uploaded),
      etag: stripQuotes(o.etag),
      httpEtag: o.etag,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
    }));
    const out: ShimListResult = {
      objects,
      delimitedPrefixes: data.delimitedPrefixes,
      truncated: data.truncated,
    };
    if (data.cursor) out.cursor = data.cursor;
    return out;
  }

  createMultipartUpload(
    key: string,
    opts?: { httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string> }
  ): PromiseLike<{
    key: string;
    uploadId: string;
    uploadPart: (partNumber: number, value: BodyInit) => PromiseLike<{ partNumber: number; etag: string }>;
    complete: (parts: Array<{ partNumber: number; etag: string }>) => PromiseLike<ShimObject>;
    abort: () => PromiseLike<void>;
  }> {
    const self = this;
    return (async () => {
      const res = await fetch(`${this.base}/r2/mpu`, {
        method: "POST",
        headers: this.h({ "content-type": "application/json" }),
        body: JSON.stringify({
          key,
          httpMetadata: opts?.httpMetadata,
          customMetadata: opts?.customMetadata,
        }),
      });
      if (!res.ok) throw new Error(`daemon createMultipartUpload ${res.status}`);
      const { uploadId } = (await res.json()) as { uploadId: string };
      return self.mpuHandle(key, uploadId);
    })();
  }

  /** R2 resume 语义：不校验服务端状态，仅按 uploadId 构建操作句柄 */
  resumeMultipartUpload(
    key: string,
    uploadId: string
  ): {
    key: string;
    uploadId: string;
    uploadPart: (partNumber: number, value: BodyInit) => PromiseLike<{ partNumber: number; etag: string }>;
    complete: (parts: Array<{ partNumber: number; etag: string }>) => PromiseLike<ShimObject>;
    abort: () => PromiseLike<void>;
  } {
    return this.mpuHandle(key, uploadId);
  }

  private mpuHandle(key: string, uploadId: string): {
    key: string;
    uploadId: string;
    uploadPart: (partNumber: number, value: BodyInit) => PromiseLike<{ partNumber: number; etag: string }>;
    complete: (parts: Array<{ partNumber: number; etag: string }>) => PromiseLike<ShimObject>;
    abort: () => PromiseLike<void>;
  } {
    const self = this;
    const partUrl = (n: number, suffix = "") =>
      `${self.base}/r2/mpu/${encodeURIComponent(uploadId)}/parts/${n}${suffix}`;
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: BodyInit) {
        const init: RequestInit = { method: "PUT", headers: self.h(), body: value };
        if (value instanceof ReadableStream) (init as Record<string, unknown>).duplex = "half";
        const pres = await fetch(partUrl(partNumber), init);
        if (!pres.ok) throw new Error(`daemon uploadPart ${pres.status}`);
        return (await pres.json()) as { partNumber: number; etag: string };
      },
      async complete(parts: Array<{ partNumber: number; etag: string }>) {
        const cres = await fetch(`${self.base}/r2/mpu/${encodeURIComponent(uploadId)}/complete`, {
          method: "POST",
          headers: self.h({ "content-type": "application/json" }),
          body: JSON.stringify({ parts }),
        });
        if (!cres.ok) throw new Error(`daemon completeMultipartUpload ${cres.status}`);
        const data = (await cres.json()) as {
          key: string;
          etag: string;
          mtime: number;
          httpMetadata: Record<string, string> | null;
          customMetadata: Record<string, string> | null;
        };
        return {
          key: data.key,
          size: 0,
          uploaded: new Date(data.mtime),
          etag: stripQuotes(data.etag),
          httpEtag: data.etag,
          httpMetadata: data.httpMetadata ?? undefined,
          customMetadata: data.customMetadata ?? undefined,
        };
      },
      async abort() {
        await fetch(`${self.base}/r2/mpu/${encodeURIComponent(uploadId)}`, {
          method: "DELETE",
          headers: self.h(),
        });
      },
    };
  }
}

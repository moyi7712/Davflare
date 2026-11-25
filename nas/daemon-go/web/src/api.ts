// 管理平面 API 客户端：Basic 认证（账号密码存 localStorage），401 自动清除并要求重登。
let AUTH = localStorage.getItem("fd-mgmt-auth") || "";

export function setAuth(user: string, pass: string): void {
  AUTH = btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
  localStorage.setItem("fd-mgmt-auth", AUTH);
}

export function clearAuth(): void {
  AUTH = "";
  localStorage.removeItem("fd-mgmt-auth");
}

export function hasAuth(): boolean {
  return AUTH !== "";
}

export class Unauthorized extends Error {}

async function req(path: string, opts: RequestInit = {}): Promise<Response> {
  const r = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Basic ${AUTH}` },
  });
  if (r.status === 401) {
    clearAuth();
    throw new Unauthorized("unauthorized");
  }
  return r;
}

export interface SyncRun {
  ts: string;
  mode: string;
  exit: number | null;
  stdoutTail: string;
  stderrTail: string;
}

export interface SyncStatus {
  mode: string;
  intervalMin: number;
  cron: string;
  cronInvalid?: boolean;
  nextRun?: string;
  running: boolean;
  remote: string;
  remoteBucket: string;
  local: string;
  rcloneAvailable: boolean;
  lastRun: SyncRun | null;
}

export interface StatusResp {
  dataDir: string;
  bucket: string;
  r2Port: number;
  mgmtPort: number;
  sync: SyncStatus;
}

export interface SyncConfig {
  syncMode: string;
  syncCron: string;
}

export const getStatus = async (): Promise<StatusResp> => req("/api/status").then((r) => r.json());

export async function putConfig(body: SyncConfig): Promise<void> {
  const r = await req("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error || `HTTP ${r.status}`);
  }
}

export const runSync = async (mode: string, resync = false): Promise<void> => {
  await req("/api/sync/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, resync }),
  });
};

export const getHistory = async (): Promise<SyncRun[]> => req("/api/sync/history").then((r) => r.json());

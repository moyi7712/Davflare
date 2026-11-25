import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeftRight, ArrowUp, RefreshCcw } from "lucide-react";
import {
  clearAuth,
  getStatus,
  getHistory,
  hasAuth,
  putConfig,
  runSync,
  type StatusResp,
  type SyncRun,
  Unauthorized,
} from "@/api";
import { describeCron, fmtDateTime, fmtTime, nextRuns } from "@/cron";
import { CronPreview } from "@/components/CronPreview";
import { SchedulePicker } from "@/components/SchedulePicker";
import { Login } from "@/components/Login";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

const REFRESH_MS = 15000;

interface FormState {
  syncMode: string;
  cron: string;
}

// 手动同步动作磁贴：图标 + 标题 + 方向说明，网格排布（优于多按钮一字排开）
function ActionTile({
  icon,
  title,
  desc,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="hover:border-primary/60 hover:bg-accent/40 flex items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="bg-primary/10 text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">{desc}</span>
      </span>
    </button>
  );
}

function shortNext(raw: string): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} `;
  if (raw.startsWith(today)) return raw.slice(today.length);
  if (raw.startsWith(`${now.getFullYear()}-`)) return raw.slice(5);
  return raw;
}

function navSchedule(sync?: StatusResp["sync"]): { rule: string; next: string } {
  if (!sync) return { rule: "—", next: "—" };
  let rule = "未设置";
  if (sync.cronInvalid) rule = "规则无效";
  else if (sync.cron) rule = describeCron(sync.cron) ?? sync.cron;
  else if (sync.intervalMin > 0) rule = `每 ${sync.intervalMin} 分钟`;

  if (sync.mode === "off") return { rule, next: "不自动" };
  if (sync.nextRun) return { rule, next: shortNext(sync.nextRun) };
  if (sync.cron && !sync.cronInvalid) {
    const runs = nextRuns(sync.cron, 1);
    if (typeof runs !== "string" && runs[0]) {
      const d = runs[0];
      return { rule, next: d.toDateString() === new Date().toDateString() ? fmtTime(d) : fmtDateTime(d) };
    }
  }
  if (!sync.cron && sync.intervalMin > 0) return { rule, next: "按间隔" };
  return { rule, next: "无" };
}

// 服务状态灯：正在同步=黄，正常=绿，服务不可用=红
function ServiceStatus({ sync, offline }: { sync?: StatusResp["sync"]; offline: boolean }) {
  let color = "bg-red-500";
  let label = "服务不可用";
  if (!offline && sync) {
    if (sync.running) {
      color = "bg-amber-400 animate-pulse";
      label = "正在同步";
    } else if (sync.rcloneAvailable) {
      color = "bg-emerald-500";
      label = "正常";
    }
  }
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-sm" title={label}>
      <span className={`inline-block size-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(hasAuth());
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [history, setHistory] = useState<SyncRun[]>([]);
  const [offline, setOffline] = useState(false);
  const [form, setForm] = useState<FormState>({ syncMode: "off", cron: "" });
  const [dirty, setDirty] = useState(false);
  // dirty 用 ref 读取：refreshData 保持稳定引用，effect 不因 dirty 翻转而重跑
  // （否则首次编辑 → effect 重跑 → refreshData(false) 会用服务端旧值冲掉用户编辑）
  const dirtyRef = useRef(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshData = useCallback(
    async (respectDirty = true) => {
      try {
        const s = await getStatus();
        setStatus(s);
        setOffline(false);
        setHistory(await getHistory());
        if (!respectDirty || !dirtyRef.current) {
          setForm({ syncMode: s.sync.mode, cron: s.sync.cron });
        }
      } catch (err) {
        if (err instanceof Unauthorized) {
          setAuthed(false);
          setStatus(null);
        } else {
          setOffline(true); // 网络不可达 → 状态灯转红
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!authed) return;
    refreshData(false);
    const t = setInterval(() => refreshData(), REFRESH_MS);
    return () => clearInterval(t);
  }, [authed, refreshData]);

  const set = (patch: Partial<FormState>) => {
    setForm({ ...form, ...patch });
    dirtyRef.current = true;
    setDirty(true);
  };

  const save = async () => {
    try {
      await putConfig({ syncMode: form.syncMode, syncCron: form.cron.trim() });
      setDirty(false);
      dirtyRef.current = false;
      setSaveMsg({ ok: true, text: "已保存并生效" });
      setTimeout(() => setSaveMsg(null), 4000);
      await refreshData(false);
    } catch (err) {
      setSaveMsg({ ok: false, text: `保存失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const trigger = async (mode: string, resync = false) => {
    setSyncing(true);
    try {
      await runSync(mode, resync);
      setTimeout(() => {
        setSyncing(false);
        refreshData();
      }, 1200);
    } catch {
      setSyncing(false);
    }
  };

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const sync = status?.sync;
  const last = sync?.lastRun;
  const schedule = navSchedule(sync);
  return (
    <div className="min-h-svh">
      <header className="bg-background sticky top-0 z-10 border-b">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2.5 px-4">
          <img src="/logo.png" alt="Davflare" className="size-6" />
          <span className="shrink-0 font-semibold">Davflare Daemon</span>
          <span
            className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-sm"
            title={sync?.cron ? `${sync.cron}，下次同步 ${schedule.next}` : `下次同步 ${schedule.next}`}
          >
            <span className="truncate">{schedule.rule}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">下次 {schedule.next}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3">
            <ServiceStatus sync={sync} offline={offline} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearAuth();
                dirtyRef.current = false;
                setAuthed(false);
                setStatus(null);
              }}
            >
              退出登录
            </Button>
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-3xl gap-6 px-4 py-6">
        {/* ① 自动同步设置 */}
        <Card>
          <CardContent className="grid gap-5">
            <div className="flex items-center justify-between gap-4">
              <Label>同步方式</Label>
              <Select
                value={form.syncMode}
                onValueChange={(v) => set({ syncMode: v })}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">off 不自动</SelectItem>
                  <SelectItem value="push">push 本地→云</SelectItem>
                  <SelectItem value="pull">pull 云→本地</SelectItem>
                  <SelectItem value="bisync">bisync 双向</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <SchedulePicker value={form.cron} onChange={(cron) => set({ cron })} />
            <CronPreview spec={form.cron} />

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={save}>保存</Button>
              {dirty && <span className="text-muted-foreground text-sm">有未保存的修改</span>}
              {saveMsg && (
                <span className={`text-sm ${saveMsg.ok ? "text-emerald-600" : "text-destructive"}`}>
                  {saveMsg.text}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ② 手动同步 */}
        <Card>
          <CardHeader>
            <CardTitle>手动同步</CardTitle>
            <CardDescription>
              {last
                ? `最近一次：${last.ts.replace("T", " ").slice(0, 19)} [${last.mode}] exit=${last.exit}`
                : "最近一次：无"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <ActionTile
                icon={<ArrowUp />}
                title="push 本地 → 云"
                desc="以本地为准，覆盖云端"
                onClick={() => trigger("push")}
                disabled={syncing}
              />
              <ActionTile
                icon={<ArrowDown />}
                title="pull 云 → 本地"
                desc="以云端为准，覆盖本地"
                onClick={() => trigger("pull")}
                disabled={syncing}
              />
              <ActionTile
                icon={<ArrowLeftRight />}
                title="bisync 双向"
                desc="双向增量同步"
                onClick={() => trigger("bisync")}
                disabled={syncing}
              />
              <ActionTile
                icon={<RefreshCcw />}
                title="bisync --resync（首跑）"
                desc="建立双向基线，首次必跑一次"
                onClick={() => trigger("bisync", true)}
                disabled={syncing}
              />
            </div>
            {syncing && <p className="text-muted-foreground text-sm">已触发，等待完成…</p>}
            {sync && !sync.rcloneAvailable && (
              <p className="text-destructive text-sm">rclone 不可用，请检查镜像与 PATH</p>
            )}
          </CardContent>
        </Card>

        {/* ③ 同步历史 */}
        <Card>
          <CardHeader>
            <CardTitle>同步历史</CardTitle>
            <CardDescription>最多保留 50 条 · 点击展开输出</CardDescription>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-muted-foreground text-sm">暂无同步记录</p>
            ) : (
              <div className="grid max-h-96 gap-2 overflow-y-auto pr-1">
                {history.map((r, i) => (
                  <details key={i} className="bg-muted/40 rounded-lg border">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
                      <span className="text-muted-foreground font-mono text-xs">
                        {r.ts.replace("T", " ").slice(0, 19)}
                      </span>
                      <Badge variant="secondary">{r.mode}</Badge>
                      {r.exit === null ? (
                        <Badge className="bg-amber-500 text-white">运行中</Badge>
                      ) : r.exit === 0 ? (
                        <Badge className="bg-emerald-600 text-white">成功</Badge>
                      ) : (
                        <Badge variant="destructive">exit={r.exit}</Badge>
                      )}
                    </summary>
                    <pre className="overflow-auto border-t p-3 font-mono text-xs max-h-56 whitespace-pre-wrap">
                      {r.stderrTail || r.stdoutTail || "（无输出）"}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

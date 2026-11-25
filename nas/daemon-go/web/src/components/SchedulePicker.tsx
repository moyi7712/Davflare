import { useEffect, useRef, useState, type ReactNode } from "react";
import { cronToView, viewToCron, type ScheduleKind, type ScheduleView } from "@/cron";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const KINDS: Array<{ value: ScheduleKind; label: string }> = [
  { value: "everyMin", label: "每隔" },
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "custom", label: "自定义" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function TimeSelect({ value, onChange, label }: { value: string; onChange: (time: string) => void; label: string }) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = match?.[1] ?? "04";
  const minute = match?.[2] ?? "00";
  return (
    <div className="flex items-center gap-1" aria-label={label}>
      <Select value={hour} onValueChange={(h) => onChange(`${h}:${minute}`)}>
        <SelectTrigger className="w-[4.5rem]" aria-label={`${label} 时`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HOURS.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground text-sm">:</span>
      <Select value={minute} onValueChange={(m) => onChange(`${hour}:${m}`)}>
        <SelectTrigger className="w-[4.5rem]" aria-label={`${label} 分`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MINUTES.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const DAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
];

function draftInvalid(v: ScheduleView): boolean {
  if (v.kind === "custom" || viewToCron(v) !== "") return false;
  if (v.kind === "everyMin") return v.everyMin !== "";
  if (v.kind === "hourly") return v.minute !== "";
  if (v.kind === "monthly") return v.monthday !== "";
  return v.time !== "";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function SchedulePicker({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const [view, setView] = useState(() => cronToView(value));
  const emitted = useRef(value);

  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setView(cronToView(value));
    }
  }, [value]);

  const update = (next: ScheduleView) => {
    setView(next);
    const cron = viewToCron(next);
    if (next.kind !== "custom" && cron === "" && draftInvalid(next)) return;
    emitted.current = cron;
    if (cron !== value) onChange(cron);
  };

  const setKind = (kind: ScheduleKind) => {
    const next: ScheduleView = { ...view, kind };
    if (kind === "everyMin" && !/^\d+$/.test(next.everyMin)) next.everyMin = "20";
    if (kind === "hourly" && !/^\d+$/.test(next.minute)) next.minute = "0";
    if (kind === "monthly" && !/^\d+$/.test(next.monthday)) next.monthday = "1";
    if (kind === "weekly" && next.weekdays.length === 0) next.weekdays = [1];
    if (kind === "custom") next.custom = value;
    update(next);
  };

  return (
    <div className="grid gap-3">
      <Row label="重复">
        <Select value={view.kind} onValueChange={(v) => setKind(v as ScheduleKind)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      {view.kind === "everyMin" && (
        <Row label="间隔">
          <Input
            className="w-20"
            inputMode="numeric"
            value={view.everyMin}
            aria-label="间隔分钟"
            onChange={(e) => update({ ...view, everyMin: e.target.value.replace(/\D/g, "") })}
          />
          <span className="text-sm">分钟</span>
        </Row>
      )}

      {view.kind === "hourly" && (
        <Row label="时刻">
          <span className="text-sm">第</span>
          <Input
            className="w-20"
            inputMode="numeric"
            value={view.minute}
            aria-label="分钟"
            onChange={(e) => update({ ...view, minute: e.target.value.replace(/\D/g, "") })}
          />
          <span className="text-sm">分</span>
        </Row>
      )}

      {view.kind === "daily" && (
        <Row label="时刻">
          <TimeSelect label="每天时刻" value={view.time} onChange={(time) => update({ ...view, time })} />
        </Row>
      )}

      {view.kind === "weekly" && (
        <Row label="时刻">
          {DAYS.map((d) => {
            const on = view.weekdays.includes(d.value);
            return (
              <Button
                key={d.value}
                type="button"
                size="sm"
                variant={on ? "default" : "outline"}
                className="size-8 px-0"
                aria-pressed={on}
                onClick={() => {
                  const weekdays = on ? view.weekdays.filter((x) => x !== d.value) : [...view.weekdays, d.value];
                  if (weekdays.length === 0) return;
                  update({ ...view, weekdays });
                }}
              >
                {d.label}
              </Button>
            );
          })}
          <TimeSelect label="每周时刻" value={view.time} onChange={(time) => update({ ...view, time })} />
        </Row>
      )}

      {view.kind === "monthly" && (
        <Row label="时刻">
          <Input
            className="w-16"
            inputMode="numeric"
            value={view.monthday}
            aria-label="每月几号"
            onChange={(e) => update({ ...view, monthday: e.target.value.replace(/\D/g, "") })}
          />
          <span className="text-sm">日</span>
          <TimeSelect label="每月时刻" value={view.time} onChange={(time) => update({ ...view, time })} />
        </Row>
      )}

      {view.kind === "custom" && (
        <Row label="表达式">
          <Input
            className="w-56 font-mono"
            value={view.custom}
            placeholder="分 时 日 月 周"
            aria-label="cron 表达式"
            onChange={(e) => update({ ...view, custom: e.target.value })}
          />
        </Row>
      )}

      {draftInvalid(view) && (
        <p className="text-destructive text-right text-sm">
          {view.kind === "everyMin" ? "填 1 到 59" : view.kind === "hourly" ? "填 0 到 59" : view.kind === "monthly" ? "日期填 1 到 31" : "时间无效"}
        </p>
      )}
    </div>
  );
}

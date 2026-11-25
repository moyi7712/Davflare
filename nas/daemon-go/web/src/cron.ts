// 轻量 5 字段 cron 解析（与 daemon-go/cron.go 同语义）：分 时 日 月 周，支持 * , - /
// 日/周同时受限时按 vixie-cron 语义取 OR。
const RANGES: Array<[number, number]> = [
  [0, 59], // 分钟
  [0, 23], // 小时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周（0 和 7 都是周日）
];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

interface ParsedCron {
  sets: Array<Set<number>>;
  domStar: boolean;
  dowStar: boolean;
}

function parseField(f: string, lo: number, hi: number): { set: Set<number>; star: boolean } | string {
  const star = f === "*";
  const set = new Set<number>();
  for (const part of f.split(",")) {
    let step = 1;
    let rng = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      const s = Number(part.slice(slash + 1));
      if (!Number.isInteger(s) || s <= 0) return `步长 "${part.slice(slash + 1)}" 无效`;
      step = s;
      rng = part.slice(0, slash);
    }
    let a: number, b: number;
    if (rng === "*") {
      a = lo;
      b = hi;
    } else if (rng.includes("-")) {
      const ab = rng.split("-", 2);
      a = Number(ab[0]);
      b = Number(ab[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return `范围 "${rng}" 无效`;
    } else {
      a = Number(rng);
      b = a;
      if (!Number.isInteger(a)) return `"${rng}" 不是数字`;
    }
    if (a < lo || b > hi || a > b) return `范围 ${a}-${b} 超出 ${lo}-${hi}`;
    for (let v = a; v <= b; v += step) set.add(v === 7 && hi === 7 ? 0 : v);
  }
  return { set, star };
}

export function parseCron(spec: string): ParsedCron | string {
  // Quartz 风格的 "?"（日/周无指定值）归一化为 crontab 的 "*"
  spec = spec.replace(/\?/g, "*");
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `cron 需要 5 个字段（分 时 日 月 周），得到 ${fields.length} 个`;
  }
  const sets: Array<Set<number>> = [];
  let domStar = false;
  let dowStar = false;
  for (let i = 0; i < 5; i++) {
    const r = parseField(fields[i], RANGES[i][0], RANGES[i][1]);
    if (typeof r === "string") return `第 ${i + 1} 个字段 "${fields[i]}" 无效：${r}`;
    sets.push(r.set);
    if (i === 2) domStar = r.star;
    if (i === 4) dowStar = r.star;
  }
  return { sets, domStar, dowStar };
}

function matches(p: ParsedCron, t: Date): boolean {
  if (!p.sets[0].has(t.getMinutes()) || !p.sets[1].has(t.getHours()) || !p.sets[3].has(t.getMonth() + 1)) {
    return false;
  }
  const domOK = p.sets[2].has(t.getDate());
  const dowOK = p.sets[4].has(t.getDay());
  if (p.domStar && p.dowStar) return true;
  if (p.domStar) return dowOK;
  if (p.dowStar) return domOK;
  return domOK || dowOK;
}

/** 未来 N 次运行时刻；解析失败返回错误字符串 */
export function nextRuns(spec: string, count: number, from = new Date()): Date[] | string {
  const p = parseCron(spec);
  if (typeof p === "string") return p;
  const out: Date[] = [];
  let t = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  const limit = new Date(from.getTime() + 366 * 24 * 3600 * 1000);
  while (t < limit && out.length < count) {
    if (matches(p, t)) out.push(new Date(t));
    t = new Date(t.getTime() + 60000);
  }
  return out;
}

/** 未来 24 小时内的全部命中时刻（时间轴用） */
export function runsInNext24h(spec: string, from = new Date()): Date[] {
  const p = parseCron(spec);
  if (typeof p === "string") return [];
  const out: Date[] = [];
  let t = new Date(Math.floor(from.getTime() / 60000) * 60000);
  for (let i = 0; i < 1440; i++) {
    if (matches(p, t)) out.push(new Date(t));
    t = new Date(t.getTime() + 60000);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fmtDateTime = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(d)}`;

/** 常见模式的中文描述；不认识的模式返回 null（前端退回展示原始字段） */
export function describeCron(spec: string): string | null {
  const f = spec.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = f;
  if (mi === "*" && ho === "*" && dom === "*" && mon === "*" && dow === "*") return "每分钟";
  if (/^\*\/(\d+)$/.test(mi) && ho === "*") return `每 ${mi.slice(2)} 分钟`;
  if (/^\*\/(\d+)$/.test(ho) && /^\d+$/.test(mi)) return `每 ${ho.slice(2)} 小时的第 ${mi} 分`;
  if (/^\d+$/.test(mi) && ho === "*") return `每小时的第 ${mi} 分`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === "*" && mon === "*") {
    const time = `${pad(Number(ho))}:${pad(Number(mi))}`;
    if (dow === "*") return `每天 ${time}`;
    const days = parseDowList(dow);
    if (days?.length === 7) return `每天 ${time}`;
    if (days) return `每${days.map((d) => WEEKDAYS[d]).join("、")} ${time}`;
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && /^\d+$/.test(dom) && mon === "*" && dow === "*") {
    return `每月 ${dom} 日 ${pad(Number(ho))}:${pad(Number(mi))}`;
  }
  return null;
}

function parseDowList(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    let a: number;
    let b: number;
    if (/^\d+$/.test(part)) a = b = Number(part);
    else {
      const m = /^(\d+)-(\d+)$/.exec(part);
      if (!m) return null;
      a = Number(m[1]);
      b = Number(m[2]);
    }
    if (a > b || a < 0 || b > 7) return null;
    for (let d = a; d <= b; d++) days.add(d === 7 ? 0 : d);
  }
  return days.size ? [...days].sort((x, y) => x - y) : null;
}

// ponytail: 只覆盖人话能说出来的计划（每隔/每小时/每天/每周/每月）。
// 列表、范围、步长这类表达式走自定义原文，不在这里展开。
export type ScheduleKind = "everyMin" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

export interface ScheduleView {
  kind: ScheduleKind;
  everyMin: string;
  minute: string;
  time: string;
  weekdays: number[];
  monthday: string;
  custom: string;
}

const EMPTY_SCHEDULE: ScheduleView = {
  kind: "everyMin",
  everyMin: "",
  minute: "0",
  time: "04:00",
  weekdays: [1],
  monthday: "1",
  custom: "",
};

function splitTime(time: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [min, h];
}

export function cronToView(spec: string): ScheduleView {
  const norm = spec.replace(/\?/g, "*").trim();
  const base: ScheduleView = { ...EMPTY_SCHEDULE, custom: spec };
  if (!norm) return base;
  const f = norm.split(/\s+/);
  if (f.length !== 5) return { ...base, kind: "custom" };
  const [mi, ho, dom, mon, dow] = f;
  if (ho === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (mi === "*") return { ...base, everyMin: "1" };
    const step = /^\*\/(\d+)$/.exec(mi);
    if (step && Number(step[1]) >= 1 && Number(step[1]) <= 59) return { ...base, everyMin: step[1] };
    if (/^\d+$/.test(mi) && Number(mi) <= 59) return { ...base, kind: "hourly", minute: String(Number(mi)) };
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && mon === "*") {
    const time = `${pad(Number(ho))}:${pad(Number(mi))}`;
    if (dom === "*" && dow === "*") return { ...base, kind: "daily", time };
    if (dom === "*") {
      const days = parseDowList(dow);
      if (days?.length === 7) return { ...base, kind: "daily", time };
      if (days) return { ...base, kind: "weekly", time, weekdays: days };
    }
    if (dow === "*" && /^\d+$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
      return { ...base, kind: "monthly", time, monthday: String(Number(dom)) };
    }
  }
  return { ...base, kind: "custom" };
}

export function viewToCron(v: ScheduleView): string {
  if (v.kind === "custom") return v.custom.trim();
  if (v.kind === "everyMin") {
    if (!/^\d+$/.test(v.everyMin)) return "";
    const n = Number(v.everyMin);
    if (n < 1 || n > 59) return "";
    return n === 1 ? "* * * * *" : `*/${n} * * * *`;
  }
  if (v.kind === "hourly") {
    if (!/^\d+$/.test(v.minute)) return "";
    const n = Number(v.minute);
    if (n < 0 || n > 59) return "";
    return `${n} * * * *`;
  }
  const hm = splitTime(v.time);
  if (!hm) return "";
  const [mi, ho] = hm;
  if (v.kind === "daily") return `${mi} ${ho} * * *`;
  if (v.kind === "weekly") {
    const days = [...new Set(v.weekdays.map((d) => (d === 7 ? 0 : d)).filter((d) => d >= 0 && d <= 6))].sort(
      (a, b) => a - b,
    );
    if (days.length === 0) return "";
    if (days.length === 7) return `${mi} ${ho} * * *`;
    return `${mi} ${ho} * * ${days.join(",")}`;
  }
  if (!/^\d+$/.test(v.monthday)) return "";
  const d = Number(v.monthday);
  if (d < 1 || d > 31) return "";
  return `${mi} ${ho} ${d} * *`;
}

function selfCheckSchedule() {
  const cases: Array<[string, ScheduleKind, string]> = [
    ["*/20 * * * *", "everyMin", "*/20 * * * *"],
    ["* * * * *", "everyMin", "* * * * *"],
    ["15 * * * *", "hourly", "15 * * * *"],
    ["0 4 * * *", "daily", "0 4 * * *"],
    ["0 9 * * 1", "weekly", "0 9 * * 1"],
    ["0 9 * * 1-5", "weekly", "0 9 * * 1,2,3,4,5"],
    ["30 8 15 * *", "monthly", "30 8 15 * *"],
    ["1 2 3 4 5", "custom", "1 2 3 4 5"],
  ];
  for (const [spec, kind, back] of cases) {
    const view = cronToView(spec);
    if (view.kind !== kind || viewToCron(view) !== back) {
      throw new Error(`schedule ${spec} => ${view.kind} ${viewToCron(view)}`);
    }
  }
  if (describeCron("0 9 * * 1,3,5") !== "每周一、周三、周五 09:00") {
    throw new Error("describeCron weekday list");
  }
}
selfCheckSchedule();

import { describeCron, fmtDateTime, fmtTime, nextRuns } from "@/cron";
import { Badge } from "@/components/ui/badge";

export function CronPreview({ spec }: { spec: string }) {
  const now = new Date();
  const trimmed = spec.trim();
  if (!trimmed) {
    return <p className="text-muted-foreground text-sm">还没设定时刻。留空会沿用已保存的间隔分钟。</p>;
  }
  const runs = nextRuns(trimmed, 5, now);
  if (typeof runs === "string") {
    return <p className="text-destructive text-sm">{runs}</p>;
  }
  const desc = describeCron(trimmed);
  return (
    <div className="grid gap-2 text-sm">
      <div>
        <Badge variant="secondary">{desc ?? trimmed}</Badge>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-2">
        接下来：
        {runs.length === 0 ? (
          <span className="text-destructive">一年内无匹配时刻</span>
        ) : (
          runs.map((d, i) => (
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs" key={i}>
              {i === 0 && d.getDate() === now.getDate() ? fmtTime(d) : fmtDateTime(d)}
            </code>
          ))
        )}
      </div>
    </div>
  );
}

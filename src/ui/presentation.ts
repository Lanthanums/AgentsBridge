const relative = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

export function relativeTime(value: string | undefined, now: number) {
  const seconds = Math.floor(Math.max(0, now - Date.parse(value || "")) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "刚刚";
  if (seconds < 3600)
    return relative.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400)
    return relative.format(-Math.floor(seconds / 3600), "hour");
  return relative.format(-Math.floor(seconds / 86400), "day");
}

export function elapsed(p: any, now: number) {
  const started = Date.parse(p.silent_since || p.updated_at || "");
  return Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1000))
    : 0;
}

export function clockLabel(seconds: number) {
  return [Math.floor(seconds / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function fileKind(path = "") {
  const ext = path.split(".").at(-1)?.toLowerCase() || "";
  if (/^(png|jpe?g|webp|gif|svg|mp4|mov)$/.test(ext)) return "media";
  if (/^(jsonl?|ya?ml|toml|[jt]sx?|py|css|html|log)$/.test(ext)) return "code";
  if (/^(xlsx?|csv|tsv)$/.test(ext)) return "table";
  if (/^(zip|7z|tar|gz|rar)$/.test(ext)) return "archive";
  return "document";
}

type Point = { x: number; y: number };

export function edgeGeometry(a: Point, b: Point, paired: boolean) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dx = (b.x - a.x) / length;
  const dy = (b.y - a.y) / length;
  const inset = Math.min(39, length / 3);
  const lane = paired ? 9 : 0;
  const bow = Math.min(32, length * 0.16);
  const start = {
    x: a.x + dx * inset - dy * lane,
    y: a.y + dy * inset + dx * lane,
  };
  const end = {
    x: b.x - dx * inset - dy * lane,
    y: b.y - dy * inset + dx * lane,
  };
  const control = {
    x: (start.x + end.x) / 2 - dy * bow,
    y: (start.y + end.y) / 2 + dx * bow,
  };
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    labelX: (start.x + 2 * control.x + end.x) / 4,
    labelY: (start.y + 2 * control.y + end.y) / 4,
  };
}

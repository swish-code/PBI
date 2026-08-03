// Shared date-selection helpers. A selection is { preset } or { preset:"custom", start, end }.
export const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 Days" },
  { key: "thisWeek", label: "This Week" },
  { key: "lastWeek", label: "Last Week" },
  { key: "thisMonth", label: "This Month" },
  { key: "lastMonth", label: "Last Month" },
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmt = (isoStr) => { if (!isoStr) return ""; const [, m, d] = isoStr.split("-"); return `${+d} ${MON[+m - 1]}`; };

export const presetLabel = (sel) => {
  if (sel.preset === "custom") return sel.start === sel.end ? fmt(sel.start) : `${fmt(sel.start)} – ${fmt(sel.end)}`;
  return (PRESETS.find((p) => p.key === sel.preset) || {}).label || "Today";
};

// turn a selection into request params (query string / POST body)
export const selQuery = (sel) => (sel.preset === "custom" ? `start=${sel.start}&end=${sel.end}` : `preset=${sel.preset || "today"}`);
export const selBody = (sel) => (sel.preset === "custom" ? { start: sel.start, end: sel.end } : { preset: sel.preset || "today" });

export const isoOf = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// ---- weekday-aligned, range-adaptive comparison selection -------------------
// Mirrors the server's period windows (server/server.js periodVars). Returns the
// set of comparisons to SHOW for a resolved range, each with a human label.
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const rangeDays = (range) => (range && range.start && range.end
  ? Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1 : 1);
// false | 'month' | 'month+' — whole calendar month, or month + first-of-next
export function calType(range) {
  if (!range || !range.start || !range.end) return false;
  const [sy, sm, sd] = range.start.split("-").map(Number);
  const [ey, em, ed] = range.end.split("-").map(Number);
  if (sd !== 1) return false;
  if (ey === sy && em === sm && ed === lastDayOfMonth(sy, sm)) return "month";
  let ny = sy, nm = sm + 1; if (nm > 12) { nm = 1; ny++; }
  if (ey === ny && em === nm && ed === 1) return "month+";
  return false;
}
const CMP = {
  w: { key: "w", short: "WoW", label: "vs last week" },
  m: { key: "m", short: "MoM", label: "vs last month" },
  y: { key: "y", short: "YoY", label: "vs same period last year" },
};
const isoAdd = (iso, days) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const isoAddMonths = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); let ny = y, nm = m + n; while (nm < 1) { nm += 12; ny--; } while (nm > 12) { nm -= 12; ny++; } const ld = lastDayOfMonth(ny, nm); return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, ld)).padStart(2, "0")}`; };
// the actual compared window for a comparison key — mirrors server periodVars
export function cmpWindow(range, key) {
  if (!range || !range.start || !range.end) return null;
  const cal = calType(range), n = rangeDays(range), s = range.start, e = range.end;
  if (key === "w") return { start: isoAdd(s, -7), end: isoAdd(e, -7) };
  if (key === "m") return cal ? { start: isoAddMonths(s, -1), end: isoAddMonths(e, -1) } : { start: isoAdd(s, -28), end: isoAdd(e, -28) };
  return (cal || n >= 30) ? { start: isoAddMonths(s, -12), end: isoAddMonths(e, -12) } : { start: isoAdd(s, -364), end: isoAdd(e, -364) };
}
// ≤7d → WoW+MoM+YoY · 8–29d → MoM+YoY · whole month → MoM+YoY · 30+d (non-month) → YoY only
// each item includes the compared window (start/end/rangeText) for hover tooltips
export function activeComparisons(range) {
  const n = rangeDays(range), cal = calType(range);
  const keys = cal ? ["m", "y"] : n <= 7 ? ["w", "m", "y"] : n <= 29 ? ["m", "y"] : ["y"];
  return keys.map((k) => {
    const w = cmpWindow(range, k);
    const rangeText = w ? (w.start === w.end ? fmt(w.start) : `${fmt(w.start)} – ${fmt(w.end)}`) : "";
    return { ...CMP[k], ...(w || {}), rangeText };
  });
}

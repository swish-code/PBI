import React, { useMemo } from "react";

/* =============================================================================
   Global comparison-logic hook + helpers — shared by every page.

   Range rules (weekday-aligned, whole-day offsets):
     ≤ 7 days   → WoW + MoM + YoY
     8–29 days  → MoM + YoY
     ≥ 30 days  → Previous Period (same length, shifted back) + YoY
   Offsets: WoW −7 · MoM −28 · Previous Period −daysSelected · YoY −364
============================================================================= */

const DAY = 86400000;
const asDate = (s) => new Date(String(s).slice(0, 10) + "T00:00:00Z");
const toISO = (d) => d.toISOString().slice(0, 10);
export const shiftDate = (dateStr, days) => toISO(new Date(asDate(dateStr).getTime() + days * DAY));
export const daysBetween = (start, end) => Math.round((asDate(end) - asDate(start)) / DAY) + 1;
// calendar month/year arithmetic (clamps the day to the target month's length)
const addMonths = (iso, n) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  let ny = y, nm = m + n;
  while (nm < 1) { nm += 12; ny--; }
  while (nm > 12) { nm -= 12; ny++; }
  const ld = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, ld)).padStart(2, "0")}`;
};
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// false | 'month' (June 1–30) | 'month+' (June 1 – Jul 1) — a whole calendar month
export function calType(startDate, endDate) {
  if (!startDate || !endDate) return false;
  const [sy, sm, sd] = String(startDate).slice(0, 10).split("-").map(Number);
  const [ey, em, ed] = String(endDate).slice(0, 10).split("-").map(Number);
  if (sd !== 1) return false;
  if (ey === sy && em === sm && ed === lastDayOfMonth(sy, sm)) return "month";
  let ny = sy, nm = sm + 1; if (nm > 12) { nm = 1; ny++; }
  if (ey === ny && em === nm && ed === 1) return "month+";
  return false;
}

const META = {
  wow: { key: "wow", short: "WoW", label: "vs last week", offset: -7 },
  mom: { key: "mom", short: "MoM", label: "vs last month", offset: -28 },
  prev: { key: "prev", short: "Prev", label: "vs previous period" }, // offset = −daysSelected
  yoy: { key: "yoy", short: "YoY", label: "vs same period last year", offset: -364 },
};

// pure (non-hook) core so it can be reused in DAX builders / server-agnostic code
export function comparisonPlan(startDate, endDate) {
  if (!startDate || !endDate) return { daysSelected: 0, comparisons: [], dates: {}, showWoW: false, showMoM: false, showYoY: false, showPreviousPeriod: false };
  const daysSelected = daysBetween(startDate, endDate);
  const cal = calType(startDate, endDate);

  let comparisons;
  if (cal) {
    // whole calendar month → calendar-aligned MoM (previous month) + YoY (previous year)
    comparisons = [
      { ...META.mom, offset: null, start: addMonths(startDate, -1), end: addMonths(endDate, -1) },
      { ...META.yoy, offset: null, start: addMonths(startDate, -12), end: addMonths(endDate, -12) },
    ];
  } else {
    // day-count rules with whole-day (weekday-aligned) offsets
    let keys;
    if (daysSelected <= 7) keys = ["wow", "mom", "yoy"];
    else if (daysSelected <= 29) keys = ["mom", "yoy"];
    else keys = ["prev", "yoy"];
    comparisons = keys.map((k) => {
      const m = META[k];
      const offset = k === "prev" ? -daysSelected : m.offset;
      return { ...m, offset, start: shiftDate(startDate, offset), end: shiftDate(endDate, offset) };
    });
  }

  const dates = { current: { start: startDate, end: endDate } };
  comparisons.forEach((c) => { dates[c.key] = { start: c.start, end: c.end }; });
  const have = (k) => comparisons.some((c) => c.key === k);
  return { daysSelected, comparisons, dates, showWoW: have("wow"), showMoM: have("mom"), showYoY: have("yoy"), showPreviousPeriod: have("prev") };
}

export function useComparisonLogic(startDate, endDate) {
  return useMemo(() => comparisonPlan(startDate, endDate), [startDate, endDate]);
}

/* ---- change / formatting ---- */
export function calculateChange(current, previous) {
  const c = Number(current), p = Number(previous);
  if (!isFinite(c) || !isFinite(p) || p === 0) return null;
  return (c - p) / p;
}
const pctText = (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");

/* ---- TrendArrow: ▲/▼ + %, green if good, red if bad (respects lowerBetter) ---- */
export function TrendArrow({ value, lowerBetter = false, showValue = true, className = "" }) {
  if (value == null || !isFinite(value)) return <span className={"cmp-arrow muted " + className}>—</span>;
  const good = lowerBetter ? value <= 0 : value >= 0;
  const color = value === 0 ? "#98A2B3" : good ? "#12B76A" : "#F04438";
  return (
    <span className={"cmp-arrow " + className} style={{ color }}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "•"}{showValue && " " + (Math.abs(value) * 100).toFixed(1) + "%"}
    </span>
  );
}

/* ---- ComparisonMetricCard: value + only the visible comparison rows ---- */
export function ComparisonMetricCard({ label, value, format = (v) => v, comparisons = [], comparisonValues = {}, lowerBetter = false, live = false, className = "" }) {
  return (
    <div className={"cmp-card " + className}>
      <div className="cmp-card-lbl">{label}{live && <span className="cmp-live" />}</div>
      <div className="cmp-card-val">{format(value)}</div>
      <div className="cmp-card-rows">
        {comparisons.map((c) => {
          const change = calculateChange(value, comparisonValues[c.key]);
          return (
            <div key={c.key} className="cmp-row">
              <TrendArrow value={change} lowerBetter={lowerBetter} />
              <span className="cmp-row-lbl">{c.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- table columns: auto add/remove WoW/MoM/YoY/Prev columns ---- */
export function getComparisonTableColumns(comparisons = []) {
  return comparisons.map((c) => ({ key: c.key, label: c.short, fullLabel: c.label, align: "right", type: "delta" }));
}

/* ---- summary text: "Net sales KD 634,953 — +5.5% vs last week, +10.2% vs last month, +86.5% vs last year" ---- */
export function generateComparisonSummary(metric, current, comparisonValues = {}, comparisons = [], format = (v) => v) {
  const parts = comparisons.map((c) => {
    const ch = calculateChange(current, comparisonValues[c.key]);
    return ch == null ? null : `${pctText(ch)} ${c.label}`;
  }).filter(Boolean);
  return `${metric} ${format(current)}${parts.length ? " — " + parts.join(", ") : ""}`;
}

/* ---- Power BI DAX builder: one ROW with current + each visible comparison per measure ----
   measures: [{ name, expr }] e.g. [{ name:"NetSales", expr:"SUM('SALES DATA'[NET])" }]
   dateFilter: { start, end }  ·  brand: "all" | "<Brand Full Name>"                        */
export function buildComparisonDAXQuery(measures = [], dateFilter = {}, brand = "all") {
  const { start, end } = dateFilter;
  const plan = comparisonPlan(start, end);
  const win = (name, s, e) => {
    const sp = s.split("-").map(Number), ep = shiftDate(e, 1).split("-").map(Number);
    return `  VAR ${name} = FILTER(ALL('DATETABLE'[DATE]), 'DATETABLE'[DATE] >= DATE(${sp[0]}, ${sp[1]}, ${sp[2]}) && 'DATETABLE'[DATE] < DATE(${ep[0]}, ${ep[1]}, ${ep[2]}))`;
  };
  const vars = [win("__cur", start, end), ...plan.comparisons.map((c) => win("__" + c.key, c.start, c.end))];
  const brandVar = brand && brand !== "all"
    ? `  VAR __brand = FILTER(ALL('Brand Table'[Brand Full Name]), 'Brand Table'[Brand Full Name] = "${String(brand).replace(/"/g, '""')}")`
    : `  VAR __brand = ALL('Brand Table'[Brand Full Name])`;
  const cols = measures.flatMap((m) => [
    `"${m.name}", CALCULATE(${m.expr}, __cur, __brand)`,
    ...plan.comparisons.map((c) => `"${m.name}_${c.short}", CALCULATE(${m.expr}, __${c.key}, __brand)`),
  ]).join(",\n  ");
  return `DEFINE\n${vars.join("\n")}\n${brandVar}\nEVALUATE ROW(\n  ${cols}\n)`;
}

/* ---- Power BI executeQueries fetch ---- */
export async function fetchComparisonDataFromPowerBI(daxQuery, workspaceId, datasetId, accessToken) {
  const base = "https://api.powerbi.com/v1.0/myorg/" + (workspaceId ? `groups/${workspaceId}/` : "") + `datasets/${datasetId}/executeQueries`;
  const res = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ queries: [{ query: daxQuery }], serializerSettings: { includeNulls: true } }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error((j.error && (j.error.code || j.error.message)) || `HTTP ${res.status}`);
  return j.results[0].tables[0].rows;
}

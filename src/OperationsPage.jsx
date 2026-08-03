import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { GripVertical, Eye, EyeOff, Plus, Settings2, RotateCcw, ChevronDown, X, ArrowLeft, Maximize2, Minus, Filter } from "lucide-react";
import { EChart, multiLineOption, barOption, donutOption, gaugeOption, heatOption, DeltaPill, CountUp, Skeleton, Matrix } from "./ui.jsx";
import AgTable from "./AgTableLazy.jsx";
import { kd, num, T } from "./theme.js";
import { selQuery, presetLabel, activeComparisons } from "./dates.js";
import { cls, UpdatingBar } from "./Updating.jsx";
import { swr, agoLabel } from "./clientCache.js";

/* ---------- helpers ---------- */
const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const has = (v) => v != null && isFinite(Number(v));
const delta = (c, p) => (has(c) && has(p) && +p !== 0 ? (+c - +p) / +p : null);
const minF = (v) => (has(v) ? (+v).toFixed(1) + " min" : "—");
const pctF = (v) => (has(v) ? (+v * 100).toFixed(2) + "%" : "—");
const pct1 = (v) => (has(v) ? (+v * 100).toFixed(1) + "%" : "—");
const rateF = (v) => (has(v) ? (+v).toFixed(2) : "—");
const hourLabel = (h) => String(h).padStart(2, "0") + ":00";
const prettyDay = (s) => String(s || "").slice(5, 10);
const B = { green: "#12B76A", yellow: "#F79009", red: "#F04438" };
const prepBand = (v) => (v < 10 ? B.green : v <= 15 ? B.yellow : B.red);
const delBand = (v) => (v < 30 ? B.green : v <= 40 ? B.yellow : B.red);
const rateBand = (v) => (v >= 4.5 ? B.green : v >= 4 ? B.yellow : B.red);
const compBand = (v) => (v < 0.01 ? B.green : v <= 0.02 ? B.yellow : B.red);
const offBand = (v) => (v < 0.02 ? B.green : v <= 0.05 ? B.yellow : B.red);

async function fetchViz(name, q) {
  const res = await fetch(`/api/viz/${name}?${q}`, { credentials: "include" });
  if (!res.ok) throw new Error(name);
  const j = await res.json();
  return j.row != null ? j.row : j.rows || [];
}
const SINGLES = new Set(["ops_kpis", "ops_extra_kpis"]);   // single-row visuals
// one HTTP request for many visuals — server fans out, dodging the browser's
// ~6-connections-per-origin limit that made 26 parallel widget fetches queue.
async function fetchBatch(names, q) {
  const res = await fetch(`/api/viz-batch?names=${names.join(",")}&${q}`, { credentials: "include" });
  const j = res.ok ? await res.json() : { results: {} };
  const out = {};
  for (const n of names) {
    const r = j.results ? j.results[n] : null;
    out[n] = r && r.row !== undefined ? r.row : r && r.rows !== undefined ? r.rows : (SINGLES.has(n) ? {} : []);
  }
  return out;
}
// Power BI serializes queries (~0.7s each), so fetching all 26 up front blocks
// the page for ~20s. Split into a critical tier (KPIs + the primary chart of
// each card — enough to make the page usable) fetched first, and the rest
// (drill tables, heatmaps, pivots, secondary panels) streamed in behind it.
const NAMES_CRIT = ["ops_kpis", "ops_extra_kpis", "ops_trend_hourly", "ops_trend_daily", "ops_by_location"];
// tier 2a — the remaining queries the VISIBLE period tiles need (Complaints,
// Busy/Offline, Hidden, buckets). These complete the dashboard the user sees.
const NAMES_TILE = ["ops_channel_complaints", "ops_complaint_cat", "ops_prep_buckets", "ops_delivery_buckets",
  "ops_delivery_daily", "ops_busy_reason", "ops_hidden_items", "ops_hidden_loc", "ops_hidden_brand", "ops_complaints_hourly"];
// tier 2b — heavy detail queries used ONLY inside the See-More drill-down modal
// (offline/hidden logs, heatmaps, pivots). Loaded last so they never delay the
// visible tiles.
const NAMES_MODAL = ["ops_complaints_hourly", "ops_complaints_detail", "ops_busy_log", "ops_hidden_detail",
  "ops_prep_heatmap", "ops_delivery_heatmap", "ops_complaint_pivot", "ops_complaints_branch", "ops_reviews",
  "ops_journey_brand", "ops_hidden_trend", "ops_busy_trend", "ops_offline_log"];
const NAMES_REST = [...NAMES_TILE, ...NAMES_MODAL];
const NAMES = [...NAMES_CRIT, ...NAMES_REST];
// prep/delivery time-bucket distributions (order-count %, colored by speed)
const PREP_BUCKETS = ["0-5", "6-10", "11-15", "16-20", "20+"];
const DEL_BUCKETS = ["15-20", "20-25", "25-30", "30-35", "35-40", "40+"];
const prepBucketC = (b) => (b === "0-5" || b === "6-10" ? B.green : b === "11-15" ? B.yellow : b === "16-20" ? "#F79009" : B.red);
const delBucketC = (b) => (b === "15-20" || b === "20-25" || b === "25-30" ? B.green : b === "30-35" || b === "35-40" ? B.yellow : B.red);
function bucketBars(rows, order, colorFn, onPick, active) {
  const map = new Map((rows || []).map((r) => [String(r.bucket), nn(r.count)]));
  const total = order.reduce((s, b) => s + (map.get(b) || 0), 0) || 1;
  const data = order.map((b) => ({ label: b + " min", value: +((map.get(b) || 0) / total * 100).toFixed(1) }));
  const colors = order.map((b) => (active && active !== b ? "#D0D5DD" : colorFn(b)));   // grey out non-active buckets
  return <EChart height={Math.max(150, order.length * 28 + 30)}
    option={barOption({ data, horizontal: true, inverse: true, fmt: (v) => v.toFixed(1) + "%", colors })}
    onEvents={onPick ? { click: (p) => onPick(String(p.name).replace(" min", "")) } : undefined} />;
}
// build a Location x Hour heatmap from {loc,hour,v} rows
const heatBuild = (rows, fmt, onPick) => {
  const data = (rows || []).map((r) => ({ row: r.loc, col: String(r.hour).padStart(2, "0"), value: nn(r.v) }));
  const nLoc = new Set(data.map((x) => x.row)).size;
  return <EChart height={Math.max(220, Math.min(520, nLoc * 20 + 60))} option={heatOption({ data, fmt })}
    onEvents={onPick ? { click: (p) => onPick(Array.isArray(p.data) ? p.data[1] : p.name) } : undefined} />;
};
const hmTime = (t) => { const s = String(t || ""); const m = s.match(/T(\d{2}:\d{2})/); return m ? m[1] : (s.length >= 5 ? s.slice(0, 5) : s); };

/* period-adaptive comparison label + key */
function cmpMeta(mode) {
  if (mode === "day") return { key: "w", label: "vs Same Weekday Last Week" };
  if (mode === "long") return { key: "q", label: "vs Previous Quarter" };
  return { key: "m", label: "vs Previous Month, Same Weekday" };
}

function Kpi({ label, value, fmt, color, delta, lowerBetter }) {
  return (
    <div className="opsk">
      <span className="uplabel">{label}</span>
      <span className="opsk-val num" style={color ? { color } : undefined}><CountUp value={value || 0} format={fmt} /></span>
      {delta !== undefined && <span className="opsk-d"><DeltaPill value={delta} lowerBetter={lowerBetter} /></span>}
    </div>
  );
}
const bandBars = (rows, valFn, band, fmt) => {
  const d = rows.map((r) => ({ label: r.label, value: valFn(r) })).sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)); // desc + inverse → largest on top
  return barOption({ data: d, horizontal: true, inverse: true, fmt, colors: d.map((r) => band(r.value)) });
};
// colored-arc gauge with the metric value in the centre (count-up via ECharts)
function gaugeOpt(value, max, color, fmt, reduce) {
  return { series: [{ type: "gauge", startAngle: 210, endAngle: -30, min: 0, max: max || 1, radius: "96%", center: ["50%", "58%"],
    progress: { show: true, width: 11, roundCap: true, itemStyle: { color } },
    axisLine: { lineStyle: { width: 11, color: [[1, "#EDEFF2"]] } },
    pointer: { show: false }, anchor: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, title: { show: false },
    detail: { valueAnimation: !reduce, offsetCenter: [0, "2%"], formatter: (v) => fmt(v), fontSize: 22, fontWeight: 800, color: "#0B1220", fontFamily: T.font },
    data: [{ value }] }] };
}
const TILE_META = { complaints: "Complaints", prep: "Preparation Time", delivery: "Delivery Time", journey: "Order Journey & Waiting", ratings: "Ratings & Reviews", hidden: "Hidden Items", busy: "Busy Time / Offline" };
// small snapshot chart shown on the tile (full detail is in the modal)
function tilePreview(id, d, mode, gbrand) {
  const all = !gbrand || gbrand === "all";   // at All-Brands the tiles break down BY BRAND
  const daily = d.ops_trend_daily || [], hourly = d.ops_trend_hourly || [];
  const src = mode === "day" ? hourly : daily;
  const x = src.map((r) => (mode === "day" ? hourLabel(r.x) : prettyDay(r.x)));
  const locs = d.ops_by_location || [];        // grouped by BRAND at all-brands, by LOCATION when scoped
  const mini = (name, data, color) => <EChart height={120} option={multiLineOption({ x, fmt: (v) => v, series: [{ name, data, color, area: true }] })} />;
  const miniBar = (data, color) => <EChart height={120} option={barOption({ data, horizontal: true, fmt: num, color })} />;
  const barPct = (data, colors, digits = 1) => <EChart height={120} option={barOption({ data, horizontal: true, fmt: (v) => v.toFixed(digits) + "%", colors })} />;
  const topBy = (key) => [...locs].filter((r) => has(r[key])).sort((a, b) => (+b[key]) - (+a[key])).slice(0, 6);
  const rateBandC = (v) => (v < 2 ? B.green : v <= 5 ? B.yellow : B.red);

  if (id === "complaints") {
    if (all) { const rows = topBy("complaint"); return barPct(rows.map((r) => ({ label: r.label, value: +r.complaint * 100 })), rows.map((r) => rateBandC(+r.complaint * 100)), 2); }
    const cs = mode === "day" ? (d.ops_complaints_hourly || []).filter((r) => r.x != null && String(r.x) !== "") : daily; const cx = cs.map((r) => (mode === "day" ? hourLabel(r.x) : prettyDay(r.x)));
    return <EChart height={120} option={multiLineOption({ x: cx, fmt: num, series: [{ name: "Complaints", data: cs.map((r) => nn(r.complaints)), color: B.red, area: true }] })} />;
  }
  if (id === "prep") return mini("Prep", src.map((r) => (has(r.prep) ? +r.prep : null)), T.green);
  if (id === "delivery") return mini("Delivery", src.map((r) => (has(r.delivery) ? +r.delivery : null)), T.blue);
  if (id === "journey") return <EChart height={120} option={multiLineOption({ x, series: [{ name: "Prep", data: src.map((r) => nn(r.prep)), color: T.green, stack: "j" }, { name: "Delivery", data: src.map((r) => nn(r.delivery)), color: T.blue, stack: "j" }] })} />;
  if (id === "ratings") { const rows = topBy("rating"); return <EChart height={120} option={barOption({ data: rows.map((r) => ({ label: r.label, value: +r.rating })), horizontal: true, fmt: (v) => v.toFixed(2), colors: rows.map((r) => rateBand(+r.rating)) })} />; }
  if (id === "hidden") {
    if (all) return miniBar((d.ops_hidden_brand || []).slice(0, 6).map((r) => ({ label: r.label, value: nn(r.times) })), "#7A5AF8");
    return miniBar((d.ops_hidden_items || []).slice(0, 5).map((r) => ({ label: r.label, value: Math.round(nn(r.minutes)) })), "#7A5AF8");
  }
  if (id === "busy") {
    if (all) { const rows = topBy("offline"); return barPct(rows.map((r) => ({ label: r.label, value: +r.offline * 100 })), rows.map((r) => rateBandC(+r.offline * 100))); }
    return miniBar((d.ops_busy_reason || []).filter((r) => r.label).slice(0, 5).map((r) => ({ label: r.label, value: nn(r.value) })), B.red);
  }
  return <div className="dt-empty">No preview</div>;
}

/* ---------- the 8 report cards ---------- */
function makeCards(d, mode, cmp) {
  const k = d.ops_kpis || {}, e = d.ops_extra_kpis || {};
  const trend = mode === "day" ? (d.ops_trend_hourly || []) : (d.ops_trend_daily || []);
  const trendX = trend.map((r) => (mode === "day" ? hourLabel(r.x) : prettyDay(r.x)));
  const locs = d.ops_by_location || [];
  const dv = (key) => delta(k[key], k[`${key}_${cmp.key}`]);

  return [
    { id: "scorecard", name: "Operational Health Scorecard", render: () => {
      const items = [
        { label: "Complaint Rate", v: nn(k.complaint), fmt: pctF, band: compBand(nn(k.complaint)), gv: Math.min(100, nn(k.complaint) * 3000) },
        { label: "Avg Prep", v: nn(k.prep), fmt: minF, band: prepBand(nn(k.prep)), gv: Math.min(100, (nn(k.prep) / 20) * 100) },
        { label: "Avg Delivery", v: nn(k.delivery), fmt: minF, band: delBand(nn(k.delivery)), gv: Math.min(100, (nn(k.delivery) / 50) * 100) },
        { label: "Avg Rating", v: nn(k.rating), fmt: rateF, band: rateBand(nn(k.rating)), gv: (nn(k.rating) / 5) * 100 },
        { label: "Offline Rate", v: nn(k.offline), fmt: pct1, band: offBand(nn(k.offline)), gv: Math.min(100, nn(k.offline) * 1000) },
      ];
      return <div className="ops-score">{items.map((it) => (
        <div key={it.label} className="ops-score-item">
          <span className="uplabel">{it.label}</span>
          <span className="opsk-val num" style={{ color: it.band }}>{it.fmt(it.v)}</span>
          <div className="ops-score-bar"><div style={{ width: it.gv + "%", background: it.band }} /></div>
        </div>))}</div>;
    } },
    { id: "complaints", name: "Complaints", render: () => (<>
      <div className="ops-krow">
        <Kpi label="Total Complaints" value={nn(e.complaints)} fmt={num} delta={dv("complaint")} lowerBetter />
        <Kpi label="Complaint Rate" value={nn(k.complaint)} fmt={pctF} color={compBand(nn(k.complaint))} />
        <Kpi label="Channels affected" value={(d.ops_channel_complaints || []).length} fmt={num} />
      </div>
      <div className="ops-2">
        <EChart height={170} option={multiLineOption({ x: trendX, fmt: num, series: [{ name: "Complaints", data: trend.map((r) => nn(r.complaints)), color: B.red, area: true }] })} />
        <EChart height={170} option={donutOption({ data: (d.ops_channel_complaints || []).filter((c) => c.label).slice(0, 6).map((c) => ({ label: c.label, value: nn(c.complaints) })), fmt: num })} />
      </div>
      <div className="ops-lbl">Top complaint categories</div>
      <EChart height={150} option={barOption({ data: (d.ops_complaint_cat || []).filter((c) => c.label).slice(0, 6).map((c) => ({ label: c.label, value: nn(c.value) })).sort((a, b) => b.value - a.value), horizontal: true, inverse: true, fmt: num, color: B.red })} />
    </>), table: { title: "Complaint reasons", rows: (d.ops_complaints_detail || []), cols: [
      { headerName: "Reason", field: "reason", flex: 1.4, minWidth: 150 }, { headerName: "Branch", field: "branch", minWidth: 130 },
      { headerName: "Channel", field: "channel", minWidth: 110 }, { headerName: "Count", field: "count", type: "rightAligned", valueFormatter: (p) => num(p.value) }] } },
    { id: "prep", name: "Preparation Time", modes: ["day", "period", "long"], render: () => (<>
      <div className="ops-krow">
        <Kpi label="Avg Prep Time" value={nn(k.prep)} fmt={minF} color={prepBand(nn(k.prep))} delta={dv("prep")} lowerBetter />
        <Kpi label="P90 Prep Time" value={nn(e.p90prep)} fmt={minF} color={prepBand(nn(e.p90prep))} />
      </div>
      <EChart height={175} option={multiLineOption({ x: trendX, fmt: (v) => v.toFixed(1) + "m", series: [{ name: "Prep (min)", data: trend.map((r) => (has(r.prep) ? +r.prep : null)), color: T.green, area: true }] })} />
      <div className="ops-lbl">By branch — worst first (green &lt;10 · yellow 10-15 · red &gt;15)</div>
      <EChart height={Math.max(120, Math.min(220, locs.length * 22))} option={bandBars([...locs].filter((r) => has(r.prep)).sort((a, b) => b.prep - a.prep).slice(0, 10), (r) => +r.prep, prepBand, (v) => v.toFixed(1) + "m")} />
    </>) },
    { id: "delivery", name: "Delivery Time", render: () => (<>
      <div className="ops-krow">
        <Kpi label="Avg Delivery Time" value={nn(k.delivery)} fmt={minF} color={delBand(nn(k.delivery))} delta={dv("delivery")} lowerBetter />
        <Kpi label="Rider Waiting" value={nn(e.riderWait)} fmt={minF} />
        <Kpi label="Pickup→Delivery" value={nn(e.pickup)} fmt={minF} />
      </div>
      <EChart height={175} option={multiLineOption({ x: trendX, fmt: (v) => v.toFixed(1) + "m", series: [{ name: "Delivery (min)", data: trend.map((r) => (has(r.delivery) ? +r.delivery : null)), color: T.blue, area: true }] })} />
      <div className="ops-lbl">By branch — worst first (green &lt;30 · yellow 30-40 · red &gt;40)</div>
      <EChart height={Math.max(120, Math.min(220, locs.length * 22))} option={bandBars([...locs].filter((r) => has(r.delivery)).sort((a, b) => b.delivery - a.delivery).slice(0, 10), (r) => +r.delivery, delBand, (v) => v.toFixed(1) + "m")} />
    </>) },
    { id: "journey", name: "Order Journey & Waiting", render: () => (<>
      <div className="ops-krow">
        <Kpi label="Prep (min)" value={nn(k.prep)} fmt={minF} />
        <Kpi label="Rider Waiting" value={nn(e.riderWait)} fmt={minF} />
        <Kpi label="Pickup→Delivery" value={nn(e.pickup)} fmt={minF} />
      </div>
      <div className="ops-lbl">Journey components over time</div>
      <EChart height={200} option={multiLineOption({ x: trendX, fmt: (v) => v.toFixed(1) + "m", series: [
        { name: "Prep", data: trend.map((r) => (has(r.prep) ? +r.prep : null)), color: T.green, stack: "j" },
        { name: "Delivery", data: trend.map((r) => (has(r.delivery) ? +r.delivery : null)), color: T.blue, stack: "j" }] })} />
    </>) },
    { id: "ratings", name: "Ratings & Reviews", render: () => (<>
      <div className="ops-krow">
        <Kpi label="Avg Rating" value={nn(k.rating)} fmt={rateF} color={rateBand(nn(k.rating))} delta={dv("rating")} />
        <Kpi label="Branches rated" value={locs.filter((r) => has(r.rating)).length} fmt={num} />
      </div>
      <div className="ops-lbl">By branch — best first (green ≥4.5 · yellow 4-4.5 · red &lt;4)</div>
      <EChart height={Math.max(120, Math.min(240, locs.length * 22))} option={bandBars([...locs].filter((r) => has(r.rating)).sort((a, b) => b.rating - a.rating).slice(0, 12), (r) => +r.rating, rateBand, (v) => v.toFixed(2))} />
    </>) },
    { id: "hidden", name: "Hidden Items / Availability", render: () => (<>
      <div className="ops-krow">
        <Kpi label="Hidden Items" value={nn(e.hiddenItems)} fmt={num} />
        <Kpi label="Total Hide Time" value={Math.round(nn(e.hiddenMinutes))} fmt={(v) => num(v) + " min"} />
      </div>
      <div className="ops-2">
        <div><div className="ops-lbl">Top hidden items (times hidden)</div>
          <EChart height={180} option={barOption({ data: (d.ops_hidden_items || []).slice(0, 8).map((r) => ({ label: r.label, value: nn(r.times) })).sort((a, b) => b.value - a.value), horizontal: true, inverse: true, fmt: num, color: "#7A5AF8" })} /></div>
        <div><div className="ops-lbl">By branch (times hidden)</div>
          <EChart height={180} option={barOption({ data: (d.ops_hidden_loc || []).slice(0, 8).map((r) => ({ label: r.label, value: nn(r.times) })).sort((a, b) => b.value - a.value), horizontal: true, inverse: true, fmt: num, color: "#EAAA08" })} /></div>
      </div>
    </>) },
    { id: "busy", name: "Busy Time / Offline", render: () => (<>
      <div className="ops-krow">
        <Kpi label="Offline Rate" value={nn(k.offline)} fmt={pct1} color={offBand(nn(k.offline))} />
        <Kpi label="Offline (hours)" value={Math.round(nn(e.offlineDur) / 3600)} fmt={(v) => num(v) + " h"} />
      </div>
      <div className="ops-lbl">Busy time by reason</div>
      <EChart height={180} option={barOption({ data: (d.ops_busy_reason || []).filter((r) => r.label).map((r) => ({ label: r.label, value: nn(r.value) })).sort((a, b) => b.value - a.value), horizontal: true, inverse: true, fmt: num, color: B.red })} />
      <div className="ops-lbl">Offline rate by branch</div>
      <EChart height={Math.max(120, Math.min(200, locs.length * 20))} option={bandBars([...locs].filter((r) => has(r.offline)).sort((a, b) => b.offline - a.offline).slice(0, 8), (r) => +r.offline * 100, (v) => (v < 2 ? B.green : v <= 5 ? B.yellow : B.red), (v) => v.toFixed(1) + "%")} />
    </>) },
  ];
}

const Sec = ({ title, children, ...rest }) => <div className="opsm-sec" {...rest}><div className="ops-lbl">{title}</div>{children}</div>;
const hhmm = (secs) => { const m = Math.round(nn(secs) / 60); return Math.floor(m / 60) + "h " + (m % 60) + "m"; };
const sevOf = (n) => (n >= 20 ? "High" : n >= 8 ? "Medium" : "Low");
const line = (x, name, data, color, fmt) => <EChart height={220} option={multiLineOption({ x, fmt: fmt || ((v) => (typeof v === "number" ? v.toFixed(1) : v)), series: [{ name, data, color, area: true }] })} />;

/* full detail body for the See-More modal (charts + full log table) */
function detailBody(id, d, ctx = {}) {
  const k = d.ops_kpis || {}, e = d.ops_extra_kpis || {};
  const hourly = d.ops_trend_hourly || [], daily = d.ops_trend_daily || [];
  const hx = hourly.map((r) => hourLabel(r.x)), dx = daily.map((r) => prettyDay(r.x));
  const locs = d.ops_by_location || [];
  const krow = (items, rest) => <div className="ops-krow" {...rest}>{items}</div>;
  // cross-filter pickers (undefined when the modal isn't interactive)
  const onPick = ctx.onPick;
  const pl = onPick ? (v) => v && onPick("fl", v) : undefined;       // pick a branch/location
  const all = ctx.all;                                               // All-Brands → break down BY BRAND
  const dimWord = all ? "Brand" : "Location";
  const pcat = onPick ? (v) => v && onPick("fcat", v) : undefined;   // pick a complaint category
  const cmMode = ctx.cmMode || "count";
  const active = ctx.active;
  // spread onto AgTable to make its rows clickable + highlight the active row
  const rowFilter = (key) => (onPick ? { onRowClick: (r) => onPick("fl", r[key]), activeKey: active && active.param === "fl" ? active.value : undefined, rowKey: key } : {});

  if (id === "complaints") return (<>
    {krow([<Kpi key="1" label="Total Complaints" value={nn(e.complaints)} fmt={num} />, <Kpi key="2" label="Complaint Rate" value={nn(k.complaint)} fmt={pctF} color={compBand(nn(k.complaint))} />, <Kpi key="3" label="Valid" value={nn(e.validCount)} fmt={num} color={B.green} />, <Kpi key="4" label="Invalid" value={nn(e.invalidCount)} fmt={num} color={B.red} />, <Kpi key="5" label="Refund Orders" value={nn(e.refundOrders)} fmt={num} />], { "data-viz": "ops_extra_kpis", "data-viz-label": "Complaints KPIs" })}
    <div className="opsm-2"><Sec title="Hourly complaints (by complaint hour)">{(() => { const c = (d.ops_complaints_hourly || []).filter((r) => r.x != null && String(r.x) !== ""); return c.length ? line(c.map((r) => hourLabel(r.x)), "Complaints", c.map((r) => nn(r.complaints)), B.red, num) : <div className="ops-empty-note">No complaint-hour recorded for this selection — the source logs a complaint hour only for delivery channels, so in-store complaints don't appear here.</div>; })()}</Sec>
      <Sec title="Daily complaints — count + rate %">{<EChart height={220} option={{
        grid: { left: 8, right: 20, top: 26, bottom: 8, containLabel: true },
        tooltip: { trigger: "axis" },
        legend: { top: 0, right: 4, icon: "roundRect", itemWidth: 11, itemHeight: 4, itemGap: 14, textStyle: { color: T.muted, fontFamily: T.font, fontSize: 11 } },
        xAxis: { type: "category", data: dx, boundaryGap: false, axisLabel: { color: T.muted, fontFamily: T.font } },
        yAxis: [{ type: "value", name: "Count", axisLabel: { color: T.muted, fontFamily: T.font } }, { type: "value", name: "Rate %", position: "right", axisLabel: { color: T.muted, fontFamily: T.font, formatter: (v) => v + "%" }, splitLine: { show: false } }],
        series: [
          { name: "Complaints", type: "line", yAxisIndex: 0, data: daily.map((r) => nn(r.complaints)), smooth: true, showSymbol: false, lineStyle: { color: B.red, width: 2.2 }, itemStyle: { color: B.red }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: B.red + "2e" }, { offset: 1, color: B.red + "00" }] } } },
          { name: "Rate %", type: "line", yAxisIndex: 1, data: daily.map((r) => +(nn(r.complaint) * 100).toFixed(2)), smooth: true, showSymbol: false, lineStyle: { color: "#F79009", width: 2.2 }, itemStyle: { color: "#F79009" } },
        ],
      }} />}</Sec></div>
    <div className="opsm-2">
      <Sec title={<span className="ops-sec-toggle">Complaints by location<span className="ops-toggle"><button className={cmMode === "count" ? "on" : ""} onClick={() => ctx.setCmMode && ctx.setCmMode("count")}>Count</button><button className={cmMode === "rate" ? "on" : ""} onClick={() => ctx.setCmMode && ctx.setCmMode("rate")}>Rate %</button></span></span>}>{(() => {
        const rateMap = new Map((d.ops_by_location || []).map((r) => [r.label, nn(r.complaint) * 100]));
        const data = (d.ops_complaints_branch || []).map((r) => ({ label: r.label, count: nn(r.value), rate: rateMap.get(r.label) || 0 }));
        return branchDualBar(data, cmMode, pl);
      })()}</Sec>
      <Sec title="Top categories" data-viz="ops_complaint_cat" data-viz-label="Top Complaint Categories">{barBig((d.ops_complaint_cat || []).filter((c) => c.label).slice(0, 10).map((c) => ({ label: c.label, value: nn(c.value) })), B.red, num, undefined, pcat)}</Sec></div>
    <Sec title="Complaint categories — Category › Complaint Type › Complaint Reason"><Matrix filename="Complaint-Categories"
      rows={(d.ops_complaint_pivot || []).map((r) => ({ ...r, category: r.category || "—", type: r.type || "—", reason: r.reason || "—" }))}
      groupKey="category" groupLabel="Category" subKey="type" subLabel="Complaint Type" childKey="reason" childLabel="Complaint Reason"
      measures={[{ key: "count", label: "Count", type: "num", total: true }, { key: "valid", label: "Valid", type: "num", total: true }, { key: "invalid", label: "Invalid", type: "num", total: true }, { key: "refund", label: "Refund", type: "kd", total: true }]} /></Sec>
  </>);

  if (id === "prep") return (<>
    {krow([<Kpi key="1" label="Avg Prep" value={nn(k.prep)} fmt={minF} color={prepBand(nn(k.prep))} />, <Kpi key="2" label="P90 Prep" value={nn(e.p90prep)} fmt={minF} color={prepBand(nn(e.p90prep))} />])}
    <div className="opsm-2"><Sec title="Hourly prep">{line(hx, "Prep", hourly.map((r) => (has(r.prep) ? +r.prep : null)), T.green, (v) => v.toFixed(1) + "m")}</Sec><Sec title="Daily trend">{line(dx, "Prep", daily.map((r) => (has(r.prep) ? +r.prep : null)), T.green, (v) => v.toFixed(1) + "m")}</Sec></div>
    <Sec title="By branch — worst first">{barBig(locs.filter((r) => has(r.prep)).sort((a, b) => b.prep - a.prep).map((r) => ({ label: r.label, value: +r.prep })), null, (v) => v.toFixed(1) + "m", prepBand, pl)}</Sec>
    <Sec title="Prep time distribution (% of orders per bucket — click to filter)" data-viz="ops_prep_buckets" data-viz-label="Prep Time Distribution">{bucketBars(d.ops_prep_buckets, PREP_BUCKETS, prepBucketC, onPick ? (b) => onPick("fpb", b) : undefined, active && active.param === "fpb" ? active.value : null)}</Sec>
    <Sec title={`Heatmap — ${dimWord} × Hour (avg prep min)`}>{heatBuild(d.ops_prep_heatmap, (v) => v.toFixed(1) + "m", pl)}</Sec>
    <Sec title="Prep time by branch (log)"><AgTable title="Prep by branch" filename="Prep-Log" height={320} rows={locs} {...rowFilter("label")} columns={[
      { headerName: "Branch", field: "label", flex: 1.3, minWidth: 150 }, { headerName: "Avg Prep", field: "prep", type: "rightAligned", valueFormatter: (p) => minF(p.value) },
      { headerName: "Avg Delivery", field: "delivery", type: "rightAligned", valueFormatter: (p) => minF(p.value) }, { headerName: "Orders", field: "orders", type: "rightAligned", valueFormatter: (p) => num(p.value) }]} /></Sec>
  </>);

  if (id === "delivery") return (<>
    {krow([<Kpi key="1" label="Avg Delivery" value={nn(k.delivery)} fmt={minF} color={delBand(nn(k.delivery))} />, <Kpi key="2" label="Rider Waiting" value={nn(e.riderWait)} fmt={minF} />, <Kpi key="3" label="Pickup→Del" value={nn(e.pickup)} fmt={minF} />])}
    <div className="opsm-2"><Sec title="Hourly delivery">{line(hx, "Delivery", hourly.map((r) => (has(r.delivery) ? +r.delivery : null)), T.blue, (v) => v.toFixed(1) + "m")}</Sec>
      <Sec title="Daily trend (delivery + rider waiting)" data-viz="ops_delivery_daily" data-viz-label="Delivery Daily Trend">{(() => { const dd = d.ops_delivery_daily || []; return <EChart height={220} option={multiLineOption({ x: dd.map((r) => prettyDay(r.x)), fmt: (v) => v.toFixed(1) + "m", series: [{ name: "Delivery", data: dd.map((r) => (has(r.delivery) ? +r.delivery : null)), color: T.blue, area: true }, { name: "Rider Waiting", data: dd.map((r) => (has(r.riderWait) ? +r.riderWait : null)), color: "#F79009" }] })} />; })()}</Sec></div>
    <Sec title="By branch — worst first">{barBig(locs.filter((r) => has(r.delivery)).sort((a, b) => b.delivery - a.delivery).map((r) => ({ label: r.label, value: +r.delivery })), null, (v) => v.toFixed(1) + "m", delBand, pl)}</Sec>
    <Sec title="Delivery time distribution (% of orders per bucket — click to filter)" data-viz="ops_delivery_buckets" data-viz-label="Delivery Time Distribution">{bucketBars(d.ops_delivery_buckets, DEL_BUCKETS, delBucketC, onPick ? (b) => onPick("fdb", b) : undefined, active && active.param === "fdb" ? active.value : null)}</Sec>
    <Sec title={`Heatmap — ${dimWord} × Hour (avg delivery min)`}>{heatBuild(d.ops_delivery_heatmap, (v) => v.toFixed(1) + "m", pl)}</Sec>
    <Sec title="Breakdown — prep vs rider waiting vs pickup">{<EChart height={110} option={barOption({ data: [{ label: "Prep", value: nn(k.prep) }, { label: "Rider Waiting", value: nn(e.riderWait) }, { label: "Pickup→Del", value: nn(e.pickup) }], horizontal: true, fmt: (v) => v.toFixed(1) + "m", colors: [T.green, "#F79009", T.blue] })} />}</Sec>
    <Sec title="Delivery by branch (log)"><AgTable title="Delivery by branch" filename="Delivery-Log" height={320} rows={locs} {...rowFilter("label")} columns={[
      { headerName: "Branch", field: "label", flex: 1.3, minWidth: 150 }, { headerName: "Avg Delivery", field: "delivery", type: "rightAligned", valueFormatter: (p) => minF(p.value) },
      { headerName: "Avg Prep", field: "prep", type: "rightAligned", valueFormatter: (p) => minF(p.value) }, { headerName: "Orders", field: "orders", type: "rightAligned", valueFormatter: (p) => num(p.value) }]} /></Sec>
  </>);

  if (id === "journey") return (<>
    {krow([<Kpi key="1" label="Prep" value={nn(k.prep)} fmt={minF} />, <Kpi key="2" label="Rider Waiting" value={nn(e.riderWait)} fmt={minF} />, <Kpi key="3" label="Pickup→Del" value={nn(e.pickup)} fmt={minF} />])}
    <Sec title="Journey components over time">{<EChart height={260} option={multiLineOption({ x: dx.length ? dx : hx, fmt: (v) => v.toFixed(1) + "m", series: [{ name: "Prep", data: (daily.length ? daily : hourly).map((r) => (has(r.prep) ? +r.prep : null)), color: T.green, stack: "j" }, { name: "Delivery", data: (daily.length ? daily : hourly).map((r) => (has(r.delivery) ? +r.delivery : null)), color: T.blue, stack: "j" }] })} />}</Sec>
    <Sec title="Order journey by branch"><AgTable title="Journey by branch" filename="Journey-Log" height={320} rows={locs} {...rowFilter("label")} columns={[
      { headerName: "Branch", field: "label", flex: 1.3, minWidth: 150 }, { headerName: "Prep", field: "prep", type: "rightAligned", valueFormatter: (p) => minF(p.value) },
      { headerName: "Delivery", field: "delivery", type: "rightAligned", valueFormatter: (p) => minF(p.value) }, { headerName: "Orders", field: "orders", type: "rightAligned", valueFormatter: (p) => num(p.value) }]} /></Sec>
  </>);

  if (id === "ratings") return (<>
    {krow([<Kpi key="1" label="Avg Rating" value={nn(k.rating)} fmt={rateF} color={rateBand(nn(k.rating))} />, <Kpi key="2" label="Branches rated" value={locs.filter((r) => has(r.rating)).length} fmt={num} />])}
    <div className="opsm-2"><Sec title="Ratings trend">{line(dx, "Rating", daily.map((r) => (has(r.rating) ? +r.rating : null)), B.yellow, (v) => v.toFixed(2))}</Sec>
      <Sec title="By branch — best first">{barBig(locs.filter((r) => has(r.rating)).sort((a, b) => b.rating - a.rating).slice(0, 12).map((r) => ({ label: r.label, value: +r.rating })), null, (v) => v.toFixed(2), rateBand, pl)}</Sec></div>
    <Sec title="Reviews — comments">{(d.ops_reviews || []).length === 0
      ? <div className="ops-empty-note">No written reviews in this period — ratings here are star-only (no text comment was left). The rating scores above are still live. Try a wider date range to surface older comments.</div>
      : <AgTable title="Reviews" filename="Reviews" height={340} rows={d.ops_reviews || []} columns={[
        { headerName: "Comment", field: "text", flex: 2, minWidth: 280 }, { headerName: "Rating", field: "rating", type: "rightAligned", valueFormatter: (p) => rateF(p.value) },
        { headerName: "Sentiment", valueGetter: (p) => (p.data.rating >= 4 ? "Positive" : p.data.rating >= 3 ? "Neutral" : "Negative"), cellClassRules: { "sev-low": (p) => p.value === "Positive", "sev-med": (p) => p.value === "Neutral", "sev-high": (p) => p.value === "Negative" }, minWidth: 100 }]} />}</Sec>
  </>);

  if (id === "hidden") return (<>
    {krow([<Kpi key="1" label="Hidden Items" value={nn(e.hiddenItems)} fmt={num} />, <Kpi key="2" label="Times Hidden" value={(d.ops_hidden_detail || []).reduce((s, r) => s + nn(r.times), 0)} fmt={num} />, <Kpi key="3" label="Total Hide Time" value={Math.round(nn(e.hiddenMinutes))} fmt={(v) => num(v) + " min"} />])}
    <Sec title="Hidden trend">{(() => { const ht = d.ops_hidden_trend || []; return <EChart height={200} option={multiLineOption({ x: ht.map((r) => String(r.x).slice(5, 10)), fmt: num, series: [{ name: "Hidden", data: ht.map((r) => nn(r.value)), color: "#7A5AF8", area: true }] })} />; })()}</Sec>
    <div className="opsm-2"><Sec title="Top hidden items — times hidden">{barBig((d.ops_hidden_items || []).slice(0, 10).map((r) => ({ label: r.label, value: nn(r.times) })), "#7A5AF8", num)}</Sec><Sec title="By location — times hidden" data-viz="ops_hidden_loc" data-viz-label="Hidden Items by Location">{barBig((d.ops_hidden_loc || []).slice(0, 10).map((r) => ({ label: r.label, value: nn(r.times) })), "#EAAA08", num, undefined, pl)}</Sec></div>
    <Sec title="Full hidden-items log"><AgTable title="Hidden items" filename="Hidden-Log" height={340} rows={d.ops_hidden_detail || []} {...rowFilter("branch")} columns={[
      { headerName: "Item", field: "item", flex: 1.5, minWidth: 180 }, { headerName: "Branch", field: "branch", minWidth: 140 },
      { headerName: "Times Hidden", field: "times", type: "rightAligned", valueFormatter: (p) => num(p.value) }, { headerName: "Hide minutes", field: "minutes", type: "rightAligned", valueFormatter: (p) => num(Math.round(p.value)) }]} /></Sec>
  </>);

  if (id === "busy") { const off = ctx.offline || {}; const bb = off.byBranch || []; return (<>
    {krow([
      <Kpi key="1" label="Offline Rate" value={nn(off.rate)} fmt={pct1} color={offBand(nn(off.rate))} />,
      <Kpi key="2" label="Busy hours" value={nn(off.totBusyMin) / 60} fmt={(v) => num(Math.round(v)) + " h"} />,
      <Kpi key="3" label="Working hours" value={nn(off.totAvailMin) / 60} fmt={(v) => num(Math.round(v)) + " h"} />,
      <Kpi key="4" label="Branches trading" value={bb.length} fmt={num} />,
    ])}
    {off.missing && off.missing.length > 0 && <div className="ops-empty-note" style={{ minHeight: 0, borderStyle: "solid", borderColor: B.yellow, color: "#9a6b00" }}>{off.missing.length} branch{off.missing.length > 1 ? "es have" : " has"} no working hours set — using the default of {off.default}h/day (marked ✱ below). Set exact hours under “Working Hours” at the top of the Operations page.</div>}
    <Sec title="Offline trend (hours/day)">{(() => { const bt = d.ops_busy_trend || []; return <EChart height={200} option={multiLineOption({ x: bt.map((r) => String(r.x).slice(5, 10)), fmt: (v) => v.toFixed(1) + "h", series: [{ name: "Offline", data: bt.map((r) => nn(r.value) / 3600), color: B.red, area: true }] })} />; })()}</Sec>
    <div className="opsm-2"><Sec title="By reason">{barBig((d.ops_busy_reason || []).filter((r) => r.label).map((r) => ({ label: r.label, value: nn(r.value) })), B.red, num)}</Sec><Sec title={`Offline rate by ${all ? "brand" : "branch"} (busy ÷ working minutes)`}>{bb.length ? barBig((all ? Object.values(bb.reduce((m, r) => { const b = r.brand || "—"; (m[b] ||= { location: b, busy: 0, avail: 0 }); m[b].busy += (r.busyMin || 0); m[b].avail += (r.availMin || 0); return m; }, {})).map((g) => ({ location: g.location, rate: g.avail ? g.busy / g.avail : 0 })).sort((a, b) => b.rate - a.rate) : bb).slice(0, 12).map((r) => ({ label: r.location, value: (r.rate || 0) * 100 })), null, (v) => v.toFixed(1) + "%", (v) => (v < 2 ? B.green : v <= 5 ? B.yellow : B.red), pl) : <div className="ops-empty-note">No trading branches in this period.</div>}</Sec></div>
    <Sec title="Offline rate — per branch (working-hours based)"><AgTable title="Offline by branch" filename="Offline-Rate" height={320} rows={bb} columns={[
      { headerName: "Brand", field: "brand", minWidth: 90 }, { headerName: "Location", field: "location", flex: 1, minWidth: 140 },
      { headerName: "Busy (min)", field: "busyMin", type: "rightAligned", valueFormatter: (p) => num(p.value) }, { headerName: "Trading days", field: "days", type: "rightAligned" },
      { headerName: "Hours/day", field: "hours", type: "rightAligned", valueFormatter: (p) => (p.data.defaulted ? p.value + " ✱" : p.value) }, { headerName: "Available (min)", field: "availMin", type: "rightAligned", valueFormatter: (p) => num(p.value) },
      { headerName: "Offline %", field: "rate", type: "rightAligned", valueFormatter: (p) => pct1(p.value), cellClassRules: { "sev-high": (p) => p.value > 0.05, "sev-med": (p) => p.value > 0.02 && p.value <= 0.05, "sev-low": (p) => p.value <= 0.02 } }]} /></Sec>
    <Sec title="Offline log — per incident (exact Power BI columns)"><AgTable title="Offline log" filename="Offline-Log" height={360} rows={d.ops_offline_log || []} {...rowFilter("branch")} columns={[
      { headerName: "Brand", field: "brand", minWidth: 90 }, { headerName: "Location", field: "branch", flex: 1, minWidth: 140 }, { headerName: "Date", field: "date", valueFormatter: (p) => String(p.value || "").slice(0, 10), minWidth: 110 },
      { headerName: "From", field: "from", valueFormatter: (p) => hmTime(p.value), minWidth: 80 }, { headerName: "To", field: "to", valueFormatter: (p) => hmTime(p.value), minWidth: 80 },
      { headerName: "Durations", field: "durations", minWidth: 100 }, { headerName: "Comment", field: "comment", flex: 1.4, minWidth: 200 }]} /></Sec>
  </>); }

  // scorecard
  const metrics = [
    { label: "Complaint Rate", v: nn(k.complaint), fmt: pctF, band: compBand(nn(k.complaint)), key: "complaint", data: daily.map((r) => nn(r.complaint) * 100) },
    { label: "Avg Prep", v: nn(k.prep), fmt: minF, band: prepBand(nn(k.prep)), key: "prep", data: daily.map((r) => nn(r.prep)) },
    { label: "Avg Delivery", v: nn(k.delivery), fmt: minF, band: delBand(nn(k.delivery)), key: "delivery", data: daily.map((r) => nn(r.delivery)) },
    { label: "Avg Rating", v: nn(k.rating), fmt: rateF, band: rateBand(nn(k.rating)), key: "rating", data: [] },
    { label: "Offline Rate", v: nn(k.offline), fmt: pct1, band: offBand(nn(k.offline)), key: "offline", data: [] },
  ];
  return (<>
    <div className="opsm-scoregrid">{metrics.map((m) => (
      <div key={m.label} className="card opsm-metric"><span className="uplabel">{m.label}</span><span className="opsk-val num" style={{ color: m.band }}>{m.fmt(m.v)}</span>
        {m.data.length > 0 && <EChart height={70} option={multiLineOption({ x: dx, fmt: (v) => v.toFixed(1), series: [{ name: m.label, data: m.data, color: m.band, area: true }] })} />}
      </div>))}</div>
    <Sec title="Complaints by channel" data-viz="ops_channel_complaints" data-viz-label="Complaints by Channel">{<EChart height={220} option={donutOption({ data: (d.ops_channel_complaints || []).filter((c) => c.label).slice(0, 6).map((c) => ({ label: c.label, value: nn(c.complaints) })), fmt: num })} />}</Sec>
  </>);
}
function barBig(data, color, fmt, band, onPick) {
  const d = [...data].sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)); // desc + inverse axis → largest pinned to top
  return <EChart height={Math.max(140, Math.min(300, d.length * 24 + 30))}
    option={barOption({ data: d, horizontal: true, inverse: true, fmt, color: color || T.green, colors: band ? d.map((r) => band(r.value)) : undefined })}
    onEvents={onPick ? { click: (p) => onPick(p.name) } : undefined} />;
}
// horizontal ranked bar with a custom two-value tooltip (count + rate) for the Complaints toggle
function branchDualBar(data, mode, onPick) {
  const d = [...data].sort((a, b) => (mode === "rate" ? b.rate - a.rate : b.count - a.count)).slice(0, 12);
  const vals = d.map((r) => (mode === "rate" ? +Number(r.rate).toFixed(2) : r.count));
  const option = {
    grid: { left: 8, right: 16, top: 10, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => { const r = d[ps[0].dataIndex]; return `<b>${r.label}</b><br/>Count: ${num(r.count)}<br/>Rate: ${Number(r.rate).toFixed(2)}%`; } },
    xAxis: { type: "value", axisLabel: { color: T.muted, fontFamily: T.font } },
    yAxis: { type: "category", data: d.map((r) => r.label), inverse: true, axisLabel: { color: T.muted, fontFamily: T.font } },
    series: [{ type: "bar", data: vals, itemStyle: { color: B.red, borderRadius: [0, 6, 6, 0] }, barMaxWidth: 26 }],
  };
  return <EChart height={Math.max(140, Math.min(320, d.length * 24 + 30))} option={option}
    onEvents={onPick ? { click: (p) => onPick(p.name) } : undefined} />;
}

function ReportModal({ title, onClose, children }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";                 // lock page scroll while open
    return () => { document.removeEventListener("keydown", h); document.body.style.overflow = ""; };
  }, [onClose]);
  // flexbox-centered overlay so framer-motion's scale can't clobber the centering transform
  return (
    <motion.div className="opsm-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose}>
      <motion.div className="opsm" role="dialog" onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.2 }}>
        <div className="opsm-head">
          <button className="opsm-back" onClick={onClose}><ArrowLeft size={15} /> Back</button>
          <b className="opsm-title">{title}</b>
          <button className="opsm-x" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="opsm-body">{children}</div>
      </motion.div>
    </motion.div>
  );
}

const DEFAULT_ORDER = ["complaints", "prep", "delivery", "journey", "ratings", "hidden", "busy"];
// server viz that primarily drives each tile's preview (for the debug Inspector)
const TILE_VIZ = { prep: "ops_trend_hourly", delivery: "ops_trend_daily", ratings: "ops_by_location", hidden: "ops_hidden_items", busy: "ops_busy_reason" };
const LS_ORDER = "ops.order.v1", LS_HIDDEN = "ops.hidden.v1", LS_SIZES = "ops.sizes.v1";
const loadLS = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v || def; } catch { return def; } };

// endpoints each modal refetches when a cross-filter is applied (so all visuals re-scope together)
const MODAL_NAMES = {
  complaints: ["ops_kpis", "ops_extra_kpis", "ops_trend_daily", "ops_complaints_hourly", "ops_by_location", "ops_channel_complaints", "ops_complaint_cat", "ops_complaint_pivot", "ops_complaints_branch", "ops_reviews"],
  prep: ["ops_kpis", "ops_extra_kpis", "ops_trend_hourly", "ops_trend_daily", "ops_by_location", "ops_prep_heatmap", "ops_prep_buckets"],
  delivery: ["ops_kpis", "ops_extra_kpis", "ops_trend_hourly", "ops_delivery_daily", "ops_by_location", "ops_delivery_heatmap", "ops_delivery_buckets"],
  journey: ["ops_kpis", "ops_extra_kpis", "ops_trend_daily", "ops_trend_hourly", "ops_by_location"],
  ratings: ["ops_kpis", "ops_trend_daily", "ops_by_location", "ops_reviews"],
  hidden: ["ops_extra_kpis", "ops_hidden_trend", "ops_hidden_items", "ops_hidden_loc", "ops_hidden_detail"],
  busy: ["ops_kpis", "ops_extra_kpis", "ops_busy_trend", "ops_busy_reason", "ops_by_location", "ops_offline_log"],
};
const FILTER_LABEL = { fl: "Location", fcat: "Category", fc: "Channel", fpb: "Prep bucket", fdb: "Delivery bucket" };

/* interactive modal body: cross-filter state + Count/Rate toggle, re-fetches scoped data on selection */
function DetailBody({ id, d, baseQ, offline }) {
  const [filter, setFilter] = useState(null);   // { param, value }
  const [fd, setFd] = useState(null);            // this modal's own fetched data (overrides d)
  const [floading, setFloading] = useState(false);
  const [cmMode, setCmMode] = useState("count");
  const dRef = useRef(d); dRef.current = d;      // read latest page data without re-running the fetch effect
  useEffect(() => { setFilter(null); setFd(null); setCmMode("count"); }, [id]);
  // On open, only fetch the detail visuals the PAGE didn't already load (the heavy
  // modal-only queries — pivots, logs, heatmaps). Everything the tiles already have
  // is reused from `d`, so the complaints modal goes from ~10 queries to ~3. When a
  // cross-filter is applied we must refetch the whole set (scoped), so all re-scope.
  useEffect(() => {
    let live = true;
    const all = MODAL_NAMES[id] || [];
    const has = (n) => { const v = dRef.current[n]; return v != null && !(Array.isArray(v) && v.length === 0) && !(v && v.error); };
    const names = filter ? all : all.filter((n) => !has(n));
    if (!filter) setFd(null);                    // reuse the page's data for what's already loaded
    if (!names.length) { setFloading(false); return () => { live = false; }; }
    // Fetch each visual INDEPENDENTLY (not one blocking batch) so each chart paints
    // the moment its own query returns — the slow 3-level pivot no longer holds up
    // "Top categories" / "By location".
    setFloading(true);
    let remaining = names.length;
    const q = filter ? `${baseQ}&${filter.param}=${encodeURIComponent(filter.value)}` : baseQ;
    for (const n of names) {
      fetchViz(n, q)
        .then((r) => { if (live) setFd((prev) => ({ ...(prev || {}), [n]: r })); })
        .catch(() => {})
        .finally(() => { if (live && --remaining === 0) setFloading(false); });
    }
    return () => { live = false; };
  }, [filter, id, baseQ]);
  const onPick = (param, value) => setFilter((f) => (f && f.param === param && f.value === value ? null : { param, value }));
  const dd = fd ? { ...d, ...fd } : d;
  const ctx = { onPick, active: filter, cmMode, setCmMode, offline, all: !/[?&]brand=/.test(baseQ || "") };
  return (
    <>
      {(filter || (floading && !fd)) && (
        <div className="opsm-filterbar">
          {filter && <span className="opsm-chip">Filtered by {FILTER_LABEL[filter.param] || ""}: <b>{filter.value}</b>
            <button onClick={() => setFilter(null)} aria-label="clear filter"><X size={13} /></button></span>}
          {floading && <span className="opsm-chip-load">loading detail…</span>}
        </div>
      )}
      {detailBody(id, dd, ctx)}
    </>
  );
}

// ---- Targets vs Actual: Ops Director sets per-store, per-KPI targets; managers track shortfall ----
const OPS_T_FMT = {
  min: (v) => (v == null ? "—" : (+v).toFixed(1) + "m"),
  pct: (v) => (v == null ? "—" : (+v * 100).toFixed(1) + "%"),
  num: (v) => (v == null ? "—" : (+v).toFixed(2)),
};
function OpsTargets({ locs, brand, canEdit, loading }) {
  const [kpis, setKpis] = useState([]);
  const [targets, setTargets] = useState({});
  useEffect(() => { fetch("/api/ops-targets", { credentials: "include" }).then((r) => r.json()).then((j) => { setKpis(j.kpis || []); setTargets(j.targets || {}); }).catch(() => {}); }, []);

  async function setTarget(location, kpi, value) {
    setTargets((t) => { const nt = { ...t, [location]: { ...(t[location] || {}) } }; if (value === "" || value == null) delete nt[location][kpi]; else nt[location][kpi] = Number(value); return nt; });
    try { await fetch("/api/ops-targets", { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ location, kpi, value: value === "" ? null : Number(value) }) }); } catch {}
  }

  if (brand === "all") {
    if (!canEdit) return null;   // managers only see it per-brand; editors get a hint
    return (
      <div className="card opst-card"><div className="opst-head">
        <span className="opsbar-title">Targets vs Actual <span className="opsbar-sub">Select a brand above to set per-store targets</span></span>
      </div></div>
    );
  }
  const stores = [...locs].filter((r) => r.label).sort((a, b) => nn(b.net) - nn(a.net));
  if (!stores.length) return null;

  const cell = (r, kp) => {
    const actual = has(r[kp.key]) ? +r[kp.key] : null;
    const tgt = targets[r.label]?.[kp.key];
    const fmt = OPS_T_FMT[kp.unit] || OPS_T_FMT.num;
    let tone = "", diff = null;
    if (actual != null && tgt != null) { diff = kp.lower ? actual - tgt : tgt - actual; tone = diff > 0.0001 ? "bad" : "ok"; }
    const offTxt = diff == null ? "" : (kp.unit === "pct" ? (Math.abs(diff) * 100).toFixed(1) + "pp" : Math.abs(diff).toFixed(kp.unit === "num" ? 2 : 1));
    return (
      <td key={kp.key} className={`opst-cell ${tone}`}>
        <span className="opst-actual">{fmt(actual)}</span>
        {canEdit
          ? <input className="opst-in" type="number" step="any" min="0" defaultValue={tgt ?? ""} placeholder="set target"
              onBlur={(e) => { const v = e.target.value.trim(); if (String(tgt ?? "") !== v) setTarget(r.label, kp.key, v); }} />
          : <span className="opst-tgt">{tgt != null ? "target " + fmt(tgt) : "no target"}</span>}
        {tone === "bad" && <span className="opst-off">▲ {offTxt} {kp.lower ? "over" : "under"}</span>}
        {tone === "ok" && <span className="opst-good">✓ on target</span>}
      </td>
    );
  };

  return (
    <div className="card opst-card" data-viz-nomenu="1">
      <div className="opst-head"><span className="opsbar-title">Targets vs Actual <span className="opsbar-sub">{brand} · {stores.length} stores{canEdit ? " · set a target per store & KPI" : " · vs Ops Director targets"}</span></span></div>
      <div className="opst-scroll">
        <table className="opst-table">
          <thead><tr><th className="l">Store</th>{kpis.map((kp) => <th key={kp.key}>{kp.label}</th>)}</tr></thead>
          <tbody>{stores.map((r) => <tr key={r.label}><td className="l opst-store">{r.label}</td>{kpis.map((kp) => cell(r, kp))}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Working Hours: internal (admin/ops-director) entry of operating hours/day
// per brand+branch. Drives the offline-rate denominator. Not shown to managers.
function WorkingHoursCard({ locs, brand, canEdit }) {
  const [wh, setWh] = useState({ hours: {}, times: {}, default: 14 });
  useEffect(() => { fetch("/api/ops-working-hours", { credentials: "include" }).then((r) => r.json()).then((j) => setWh({ hours: j.hours || {}, times: j.times || {}, default: j.default || 14 })).catch(() => {}); }, []);
  if (!canEdit) return null;                          // internal only — never shown to managers
  const key = (loc) => `${brand}::${loc}`;
  async function put(body, optimistic) {
    setWh(optimistic);
    try { const r = await fetch("/api/ops-working-hours", { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) }); const j = await r.json(); if (j && j.hours) setWh({ hours: j.hours, times: j.times || {}, default: j.default }); } catch {}
  }
  const setHours = (loc, v) => put({ brand, location: loc, hours: v === "" ? null : Number(v) }, (w) => { const h = { ...w.hours }; if (v === "") delete h[key(loc)]; else h[key(loc)] = Number(v); return { ...w, hours: h }; });
  const setDefault = (v) => { if (v === "" || !isFinite(Number(v))) return; put({ default: Number(v) }, (w) => ({ ...w, default: Number(v) })); };
  const [importing, setImporting] = useState(false);
  async function importFromFile() {
    if (importing) return; setImporting(true);
    try {
      const r = await fetch("/api/admin/import-working-hours", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (j.error) alert("Import failed: " + j.error);
      else { alert(`Imported working hours from Branches Data.\nMatched ${j.matched} stores to model locations, ${j.unmatched} unmatched.` + (j.unmatchedList?.length ? "\n\nUnmatched: " + j.unmatchedList.slice(0, 20).map((u) => `${u.brand}/${u.store}`).join(", ") : ""));
        const wh2 = await fetch("/api/ops-working-hours", { credentials: "include" }).then((x) => x.json()); setWh({ hours: wh2.hours || {}, times: wh2.times || {}, default: wh2.default || 14 }); }
    } catch (e) { alert("Import failed"); } finally { setImporting(false); }
  }
  const stores = [...locs].filter((r) => r.label).sort((a, b) => nn(b.net) - nn(a.net));
  return (
    <div className="card opst-card" data-viz-nomenu="1">
      <div className="opst-head">
        <span className="opsbar-title">Working Hours <span className="opsbar-sub">Internal · offline rate = busy ÷ (hours × 60 × days in period). Open–close fed from Branches Data; override hours below.</span></span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn" onClick={importFromFile} disabled={importing} title="Import hours from Branches Data.xlsx, matched to model locations">{importing ? "Importing…" : "Import from Branches file"}</button>
          <label className="wh-default">Default&nbsp;<input type="number" min="1" max="24" step="0.5" defaultValue={wh.default} onBlur={(e) => setDefault(e.target.value.trim())} />&nbsp;h/day</label>
        </div>
      </div>
      {brand === "all"
        ? <div className="opsbar-sub" style={{ padding: "6px 4px 2px" }}>Select a brand above to set each store’s hours. Company offline rate uses every brand+branch that traded; unset branches fall back to the default above.</div>
        : (!stores.length ? <div className="opsbar-sub" style={{ padding: "6px 4px 2px" }}>No trading stores for {brand} in this period.</div>
          : <div className="opst-scroll"><table className="opst-table">
              <thead><tr><th className="l">Store</th><th>Open – Close</th><th>Hours / day</th><th>Status</th></tr></thead>
              <tbody>{stores.map((r) => { const set = wh.hours[key(r.label)] != null; const t = (wh.times || {})[key(r.label)] || {}; return (
                <tr key={r.label}><td className="l opst-store">{r.label}</td>
                  <td className="opst-cell opst-times">{t.open && t.close ? `${t.open} – ${t.close}` : (t.raw || "—")}</td>
                  <td className="opst-cell"><input className="opst-in" type="number" min="1" max="24" step="0.5" defaultValue={set ? wh.hours[key(r.label)] : ""} placeholder={`default ${wh.default}`}
                    onBlur={(e) => { const v = e.target.value.trim(); if (String(wh.hours[key(r.label)] ?? "") !== v) setHours(r.label, v); }} /></td>
                  <td className="opst-cell">{set ? <span className="opst-good">✓ set</span> : <span className="opst-off">default {wh.default}h</span>}</td></tr>); })}</tbody>
            </table></div>)}
    </div>
  );
}

// per-table, multi-select Operations filters
const EMPTY_F = { vc: [], vh: [], rc: [], rb: [], rh: [] };
const EMPTY_OPTS = { validation: { complaints: [], hidden: [] }, responsible: { complaints: [], busy: [], hidden: [] } };

// a compact multi-select dropdown (button → checkbox popover)
function MultiSelect({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const toggle = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const summary = value.length === 0 ? "All" : value.length === 1 ? value[0] : `${value.length} selected`;
  return (
    <div className="ms" ref={ref}>
      <label className="ms-label">{label}</label>
      <button className={"ms-btn" + (value.length ? " on" : "")} onClick={() => setOpen((o) => !o)} title={value.join(", ") || "All"}>
        <span className="ms-sum">{summary}</span><ChevronDown size={13} className={open ? "up" : ""} />
      </button>
      {open && (
        <div className="ms-pop">
          {options.length ? options.map((v) => (
            <label key={v} className={"ms-opt" + (value.includes(v) ? " on" : "")}><input type="checkbox" checked={value.includes(v)} onChange={() => toggle(v)} /><span>{v}</span></label>
          )) : <div className="ms-empty">No values</div>}
          {value.length > 0 && <button className="ms-clr" onClick={() => onChange([])}>Clear selection</button>}
        </div>
      )}
    </div>
  );
}

function OpsFilterPopup({ opts, value, onApply, onClose }) {
  const [f, setF] = useState(value);
  const count = Object.values(f).reduce((s, a) => s + a.length, 0);
  const set = (key) => (v) => setF((s) => ({ ...s, [key]: v }));
  return (
    <motion.div className="ofp-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="ofp" onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}>
        <div className="ofp-head"><b><Filter size={15} /> Operations Filters</b><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="ofp-body">
          <div className="ofp-report">
            <div className="ofp-report-h">Complaints</div>
            <div className="ofp-report-row">
              <MultiSelect label="Validation" options={opts.validation.complaints} value={f.vc} onChange={set("vc")} />
              <MultiSelect label="Responsible Party" options={opts.responsible.complaints} value={f.rc} onChange={set("rc")} />
            </div>
          </div>
          <div className="ofp-report">
            <div className="ofp-report-h">Offline / Busy</div>
            <div className="ofp-report-row">
              <MultiSelect label="Responsible Party" options={opts.responsible.busy} value={f.rb} onChange={set("rb")} />
            </div>
          </div>
          <div className="ofp-report">
            <div className="ofp-report-h">Hidden Items</div>
            <div className="ofp-report-row">
              <MultiSelect label="Validation" options={opts.validation.hidden} value={f.vh} onChange={set("vh")} />
              <MultiSelect label="Responsible Party" options={opts.responsible.hidden} value={f.rh} onChange={set("rh")} />
            </div>
          </div>
        </div>
        <div className="ofp-foot"><button className="btn" onClick={() => setF(EMPTY_F)} disabled={!count}>Clear all</button><button className="btn primary" onClick={() => onApply(f)}>Apply{count ? ` (${count})` : ""}</button></div>
      </motion.div>
    </motion.div>
  );
}

export default function OperationsPage({ sel, role = "ceo", brand: gbrand = "all", canSetTargets = false }) {
  const reduce = useReducedMotion();
  const [range, setRange] = useState(null);
  const [d, setD] = useState({});
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState(() => loadLS(LS_ORDER, DEFAULT_ORDER));
  const [hidden, setHidden] = useState(() => loadLS(LS_HIDDEN, []));
  const [sizes, setSizes] = useState(() => loadLS(LS_SIZES, {}));   // tileId → "full" (else normal)
  const [customize, setCustomize] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [seeMore, setSeeMore] = useState(null); // full detail modal (report id)
  const [updated, setUpdated] = useState(null); // client-cache "last updated" ts
  const dragId = useRef(null);
  // page-level Operations filters — per table, multi-select (via popup)
  const [filters, setFilters] = useState(EMPTY_F);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterOpts, setFilterOpts] = useState(EMPTY_OPTS);
  useEffect(() => { fetch("/api/ops-filters", { credentials: "include" }).then((r) => r.json()).then((j) => setFilterOpts({ validation: j.validation || EMPTY_OPTS.validation, responsible: j.responsible || EMPTY_OPTS.responsible })).catch(() => {}); }, []);
  const activeCount = Object.values(filters).reduce((s, a) => s + a.length, 0);
  const pf = (k, arr) => (arr && arr.length ? `&${k}=${arr.map(encodeURIComponent).join("|")}` : "");
  const extraQ = pf("vc", filters.vc) + pf("vh", filters.vh) + pf("rc", filters.rc) + pf("rb", filters.rb) + pf("rh", filters.rh);
  const bq = gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "";
  const baseQ = selQuery(sel) + bq + extraQ;

  useEffect(() => { fetch(`/api/range?${selQuery(sel)}`, { credentials: "include" }).then((r) => r.json()).then(setRange).catch(() => {}); }, [sel]);
  useEffect(() => { localStorage.setItem(LS_ORDER, JSON.stringify(order)); }, [order]);
  useEffect(() => { localStorage.setItem(LS_HIDDEN, JSON.stringify(hidden)); }, [hidden]);
  useEffect(() => { localStorage.setItem(LS_SIZES, JSON.stringify(sizes)); }, [sizes]);

  // Switching brand must not leave the previous brand's rows on screen while the
  // new brand streams in (only the critical tier is replaced first; detail tiles
  // like complaints-by-location / reviews would otherwise linger). Clear instantly
  // on a brand change so an open modal never shows stale cross-brand data.
  const prevBrand = useRef(gbrand);
  useEffect(() => { if (prevBrand.current !== gbrand) { setD({}); prevBrand.current = gbrand; } }, [gbrand]);

  // computed offline rate (busy minutes ÷ working minutes) — from admin-entered
  // working hours, NOT a DAX measure. Scoped to the current period + brand.
  const [offline, setOffline] = useState(null);
  useEffect(() => {
    let live = true;
    // fire a beat after mount so the visible tiles get Power BI capacity first
    const t = setTimeout(() => {
      fetch(`/api/ops-offline?${selQuery(sel) + bq + extraQ}`, { credentials: "include" }).then((r) => r.json()).then((j) => live && setOffline(j)).catch(() => {});
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [sel, gbrand, extraQ]);

  useEffect(() => {
    let live = true; setLoading(true);
    const q = selQuery(sel) + bq + extraQ;
    let first = true;
    // client SWR: show last-cached critical tier INSTANTLY (even after a browser
    // refresh), then revalidate from the server, then stream the rest behind it.
    swr("ops|" + q, () => fetchBatch(NAMES_CRIT, q), (m, meta) => {
      if (!live) return;
      setD((prev) => (first ? m : { ...prev, ...m }));   // first apply clears the old date
      first = false; setLoading(false); setUpdated(meta.ts);
    }).then(() => {
      // client-cache the tiles too (was a plain re-fetch every visit) — paints the
      // report tiles INSTANTLY from IndexedDB on repeat visits, then revalidates.
      if (live) swr("ops-tile|" + q, () => fetchBatch(NAMES_TILE, q), (m2) => { if (live) setD((prev) => ({ ...prev, ...m2 })); });
    }).catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [sel, gbrand, extraQ]);

  const days = range ? Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1 : 1;
  const mode = days <= 1 ? "day" : days <= 35 ? "period" : "long";
  const comps = activeComparisons(range);          // adaptive WoW/MoM/YoY set for this range
  const primary = comps[0];
  const k = d.ops_kpis || {};
  const dv = (key) => delta(k[key], k[`${key}_${primary.key}`]);
  const gauges = [
    { label: "Complaint Rate", value: nn(k.complaint), max: 0.05, color: B.red, fmt: pctF, dk: "complaint", lower: true, modal: "complaints" },
    { label: "Avg Prep Time", value: nn(k.prep), max: 20, color: B.green, fmt: minF, dk: "prep", lower: true, modal: "prep" },
    { label: "Avg Delivery Time", value: nn(k.delivery), max: 50, color: B.yellow, fmt: minF, dk: "delivery", lower: true, modal: "delivery" },
    { label: "Avg Rating", value: nn(k.rating), max: 5, color: B.yellow, fmt: rateF, dk: "rating", lower: false, modal: "ratings" },
    { label: "Offline Rate", value: nn(offline?.rate), max: 0.1, color: B.green, fmt: pct1, dk: "offline", lower: true, modal: "busy" },
  ];

  const hiddenSet = new Set(hidden);
  const visible = order.filter((id) => TILE_META[id] && !hiddenSet.has(id));
  const hiddenTiles = order.filter((id) => TILE_META[id] && hiddenSet.has(id));
  const onDrop = (targetId) => {
    const from = dragId.current; if (!from || from === targetId) return;
    setOrder((o) => { const a = [...o]; const fi = a.indexOf(from), ti = a.indexOf(targetId); a.splice(ti, 0, a.splice(fi, 1)[0]); return a; });
    dragId.current = null;
  };
  const reset = () => { setOrder(DEFAULT_ORDER); setHidden([]); setSizes({}); };

  return (
    <div className={cls("page opsdash", loading)}>
      <UpdatingBar show={loading} brand={gbrand} />
      {/* ---------- Operational Health: 5 gauge cards ---------- */}
      <div className="ops-health-head">
        <div><span className="opsbar-title">Operational Health</span><span className="opsbar-sub">{presetLabel(sel)}{gbrand !== "all" ? " · " + gbrand : ""} · click a metric for detail</span></div>
        <div className="ops-filters">
          <button className={"ctl ops-filt-btn" + (activeCount ? " on" : "")} onClick={() => setFilterOpen(true)} title="Filter by Validation / Responsible Party (per table, multi-select)">
            <Filter size={14} /> Filters{activeCount ? ` · ${activeCount}` : ""}
          </button>
          {activeCount > 0 && <button className="ops-filt-clear" onClick={() => setFilters(EMPTY_F)} title="Clear all filters"><X size={13} /></button>}
        </div>
      </div>
      <div className="ops-gauges" data-viz="ops_kpis" data-viz-label="Operational Health KPIs">
        {gauges.map((g, i) => (
          <motion.button key={g.label} className="card ops-gauge" onClick={() => setSeeMore(g.modal)}
            initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: reduce ? 0 : i * 0.06 }}>
            <div className="ops-gauge-head"><span className="uplabel">{g.label}</span><span className="ops-gauge-i" title={g.label}>ⓘ</span></div>
            {loading ? <Skeleton h={110} /> : <EChart height={120} option={gaugeOpt(g.value, g.max, g.color, g.fmt, reduce)} />}
            {!loading && <div className="ops-gauge-d">{comps.map((c) => (
              <span key={c.key} className="ops-delta-item"><DeltaPill value={delta(k[g.dk], k[`${g.dk}_${c.key}`])} lowerBetter={g.lower} /><span className="opsk-d-cap">{c.label}</span></span>
            ))}</div>}
          </motion.button>
        ))}
      </div>

      {/* ---------- Operations report tiles ---------- */}
      <div className="opsbar">
        <div className="opsbar-title">Operations reports <span className="opsbar-sub">{mode} view · click a tile for full detail</span></div>
        <div className="spacer" />
        <div className="opsbar-add">
          <button className="btn" onClick={() => setAddOpen((v) => !v)}><Plus size={14} /> Add Report <ChevronDown size={13} /></button>
          <AnimatePresence>{addOpen && (
            <motion.div className="opsbar-menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
              {hiddenTiles.length === 0 && <div className="opsbar-menu-empty">All reports visible</div>}
              {hiddenTiles.map((id) => <button key={id} onClick={() => { setHidden((h) => h.filter((x) => x !== id)); setAddOpen(false); }}>{TILE_META[id]}</button>)}
            </motion.div>)}</AnimatePresence>
        </div>
        <button className={`btn ${customize ? "primary" : ""}`} onClick={() => setCustomize((v) => !v)}><Settings2 size={14} /> {customize ? "Done" : "Customize Layout"}</button>
        <button className="btn" onClick={reset}><RotateCcw size={14} /> Reset</button>
        {updated && <span className="upd-badge" title="Data served from cache, refreshing in background">Updated {agoLabel(updated)}</span>}
      </div>

      {loading ? (
        <div className="opsgrid">{[0, 1, 2].map((i) => <div key={i} className="card"><Skeleton h={170} /></div>)}</div>
      ) : (
        <div className={`opsgrid ${customize ? "editing ios-editing" : ""}`}>
          {visible.map((id, i) => (
            <motion.div key={id} className={`card opstile ${customize ? "ios-tile" : "clickable"}`} style={{ gridColumn: sizes[id] === "full" ? "1 / -1" : undefined }} data-viz={TILE_VIZ[id]} data-viz-label={TILE_VIZ[id] && TILE_META[id]} data-viz-nomenu={customize ? "1" : undefined} layout={!reduce} draggable={customize}
              onDragStart={() => (dragId.current = id)} onDragOver={(e) => customize && e.preventDefault()} onDrop={() => onDrop(id)}
              onClick={() => !customize && setSeeMore(id)}
              initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: reduce ? 0 : i * 0.08 }}>
              {customize && <button className="ios-remove" title="Hide report" onClick={(e) => { e.stopPropagation(); setHidden((h) => [...h, id]); }}><Minus size={14} strokeWidth={3} /></button>}
              {customize && <button className="ios-resize" title={sizes[id] === "full" ? "Shrink" : "Expand to full width"} onClick={(e) => { e.stopPropagation(); setSizes((s) => ({ ...s, [id]: s[id] === "full" ? undefined : "full" })); }}><Maximize2 size={12} strokeWidth={2.5} /></button>}
              <div className="opscard-head">
                {customize && <span className="opscard-grip"><GripVertical size={15} /></span>}
                <span className="opscard-title">{TILE_META[id]}</span>
                <div className="spacer" />
                <button className="opscard-ic" title="Hide" onClick={(e) => { e.stopPropagation(); setHidden((h) => [...h, id]); }}><EyeOff size={15} /></button>
              </div>
              <div className="opstile-body">
                {tilePreview(id, d, mode, gbrand)}
                <button className="opscard-more">Open detail <Maximize2 size={12} /></button>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* ---------- Targets vs Actual + Working Hours (admin/ops settings — bottom) ---------- */}
      <OpsTargets locs={d.ops_by_location || []} brand={gbrand} canEdit={canSetTargets} loading={loading} />
      <WorkingHoursCard locs={d.ops_by_location || []} brand={gbrand} canEdit={canSetTargets} />

      <AnimatePresence>
        {filterOpen && <OpsFilterPopup opts={filterOpts} value={filters} onClose={() => setFilterOpen(false)} onApply={(f) => { setFilters(f); setFilterOpen(false); }} />}
      </AnimatePresence>

      <AnimatePresence>
        {seeMore && TILE_META[seeMore] && (
          <ReportModal title={TILE_META[seeMore]} onClose={() => setSeeMore(null)}><DetailBody id={seeMore} d={d} baseQ={baseQ} offline={offline} /></ReportModal>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================================
//  COMPARE — the comparison experience.
//  Progressive disclosure: Command Center → Executive KPIs → Quality → Growth
//  Bridge → LFL vs Expansion → Drivers → Detail. An executive should be able to
//  stop after the first three sections.
//
//  All arithmetic lives in compareEngine.js (pure + unit-tested, see
//  tests/compare-engine.test.mjs). This file only fetches and renders.
// ============================================================================
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, RotateCcw, Download, AlertTriangle, CheckCircle2, Info, Link2, Presentation, X, ChevronLeft, ChevronRight, CalendarRange, Pencil } from "lucide-react";
import { EChart, DataGrid, DeltaPill, Skeleton, multiLineOption, Term } from "./ui.jsx";
import { kd, kdc, num, T } from "./theme.js";
import { cls, UpdatingBar } from "./Updating.jsx";
import { RangeCalendar } from "./DateControl.jsx";
import {
  nn, lflBreakdown, growthBridge, volumeRateSplit, contributors, mixShift,
  normalize, NORMALIZERS, qualityScore, statusLabel, statusTone, isLowerBetter,
  shiftDays, dayCount, tradingDays, isoOf, ENTITY, buildNarrative,
} from "./compareEngine.js";

const pctTxt = (v, dp = 1) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(dp) + "%");
const ppTxt = (v, dp = 1) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(dp) + " pp");
const fmtDay = (s) => new Date(String(s).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtShort = (s) => new Date(String(s).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const DIMS = [
  { k: "location", label: "Branch" },
  { k: "brand", label: "Brand" },
  { k: "source", label: "Order source" },
  { k: "day", label: "Day of week" },
];
const METRICS = [
  { k: "sales", label: "Net Sales", term: "netsales", fmt: kd, aKey: "aSales", bKey: "bSales" },
  { k: "orders", label: "Orders", term: "orders", fmt: num, aKey: "aOrders", bKey: "bOrders" },
  { k: "aov", label: "AOV", term: "aov", fmt: kdc, aKey: "aAov", bKey: "bAov" },
];

const fetchViz = (name, q) =>
  fetch(`/api/viz/${name}?${q}`, { credentials: "include" })
    .then((r) => (r.ok ? r.json() : { rows: [] }))
    .then((j) => (Array.isArray(j.rows) ? j.rows : j.row ? [j.row] : []))
    .catch(() => []);

// §19 shareable state — the whole comparison lives in the URL, so a copied link
// reopens the exact same view. Security is unaffected: RLS is enforced server-side,
// so a shared link shows the recipient only what their own scope permits.
function readUrlState(today) {
  const p = new URLSearchParams(window.location.search);
  const g = (k, d) => p.get(k) || d;
  return {
    a: { start: g("as", shiftDays(today, -7)), end: g("ae", shiftDays(today, -1)) },
    b: { start: g("bs", shiftDays(today, -14)), end: g("be", shiftDays(today, -8)) },
    dim: g("dim", "location"), metric: g("m", "sales"), norm: g("n", "total"),
    lflOnly: p.get("lfl") === "1", cutHour: p.get("cut") != null ? Number(p.get("cut")) : null,
    eventPick: g("ev", ""), name: g("nm", ""),
  };
}

export default function ComparePage({ brand: gbrand = "all" }) {
  const today = isoOf(new Date());
  const init = useMemo(() => readUrlState(today), []);
  const [a, setA] = useState(init.a);
  const [b, setB] = useState(init.b);
  const [dim, setDim] = useState(init.dim);
  const [metric, setMetric] = useState(init.metric);
  const [norm, setNorm] = useState(init.norm);
  const [lflOnly, setLflOnly] = useState(init.lflOnly);
  const [cutHour, setCutHour] = useState(init.cutHour);   // null = full days
  const [cmpName, setCmpName] = useState(init.name);
  const [coverage, setCoverage] = useState(null);          // { lastHour } for A's final day
  const [copied, setCopied] = useState(false);
  const [present, setPresent] = useState(false);           // §20 story mode
  const [slide, setSlide] = useState(0);
  const [periodOpen, setPeriodOpen] = useState(false);     // period-picker popup

  const [locRows, setLocRows] = useState([]);   // always fetched: powers LFL + bridge
  const [dimRows, setDimRows] = useState([]);   // the currently selected breakdown
  const [trendA, setTrendA] = useState([]);
  const [trendB, setTrendB] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dimLoading, setDimLoading] = useState(false);
  const [freshAt, setFreshAt] = useState(null);
  const [events, setEvents] = useState([]);
  const [eventPick, setEventPick] = useState(init.eventPick);

  // keep the URL in sync so the address bar IS the shareable state
  useEffect(() => {
    const p = new URLSearchParams();
    p.set("as", a.start); p.set("ae", a.end); p.set("bs", b.start); p.set("be", b.end);
    if (dim !== "location") p.set("dim", dim);
    if (metric !== "sales") p.set("m", metric);
    if (norm !== "total") p.set("n", norm);
    if (lflOnly) p.set("lfl", "1");
    if (cutHour != null) p.set("cut", String(cutHour));
    if (eventPick) p.set("ev", eventPick);
    if (cmpName) p.set("nm", cmpName);
    window.history.replaceState(null, "", `${window.location.pathname}?${p}`);
  }, [a, b, dim, metric, norm, lflOnly, cutHour, eventPick, cmpName]);

  useEffect(() => {
    fetch("/api/events", { credentials: "include" }).then((r) => (r.ok ? r.json() : { events: [] }))
      .then((j) => setEvents(j.events || [])).catch(() => {});
  }, []);

  // Occasion-day alignment (§7): pick an event, and both periods snap to the same
  // event-day sequence (Eid Day 1 vs Eid Day 1) rather than matching calendar dates.
  const eventNames = useMemo(() => [...new Set(events.map((e) => e.name))], [events]);
  const applyEventAlignment = useCallback((name) => {
    setEventPick(name);
    if (!name) return;
    const yrs = events.filter((e) => e.name === name).sort((x, y) => y.year - x.year);
    if (yrs.length < 2) return;
    const [cur, prev] = yrs;
    // clip both to the SHORTER event so day-1..day-N line up exactly
    const n = Math.min(dayCount(cur.start, cur.end), dayCount(prev.start, prev.end));
    setA({ start: cur.start, end: shiftDays(cur.start, n - 1) });
    setB({ start: prev.start, end: shiftDays(prev.start, n - 1) });
  }, [events]);
  const activeEvents = useMemo(() => {
    if (!eventPick) return null;
    const yrs = events.filter((e) => e.name === eventPick).sort((x, y) => y.year - x.year).slice(0, 2);
    return yrs.length === 2 ? yrs : null;
  }, [events, eventPick]);
  const unconfirmed = activeEvents ? activeEvents.filter((e) => e.status !== "confirmed") : [];

  const bq = gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "";
  const cutQ = cutHour != null ? `&cutHour=${cutHour}` : "";
  const periodKey = `${a.start}|${a.end}|${b.start}|${b.end}|${gbrand}|${cutHour ?? ""}`;

  // §6 probe A's final day for the last hour that actually carries data — that's
  // how a partial day is detected, rather than assuming the calendar is complete.
  useEffect(() => {
    let live = true;
    fetch(`/api/viz/cmp_coverage?day=${a.end}${bq}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setCoverage(j.row || null); })
      .catch(() => {});
    return () => { live = false; };
  }, [a.end, gbrand]);

  // ---- critical payload: branch grain + both trends (§24 load order) --------
  useEffect(() => {
    let live = true; setLoading(true);
    const q = `aStart=${a.start}&aEnd=${a.end}&bStart=${b.start}&bEnd=${b.end}${bq}${cutQ}`;
    Promise.all([
      fetchViz("cmp_two", `dim=location&${q}`),
      fetchViz("cmp_trend", `tStart=${a.start}&tEnd=${a.end}${bq}${cutQ}`),
      fetchViz("cmp_trend", `tStart=${b.start}&tEnd=${b.end}${bq}${cutQ}`),
    ]).then(([lr, ta, tb]) => {
      if (!live) return;
      setLocRows(lr); setTrendA(ta); setTrendB(tb); setFreshAt(Date.now()); setLoading(false);
    }).catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [periodKey]);

  // ---- secondary payload: the selected breakdown dimension ------------------
  useEffect(() => {
    let live = true;
    if (dim === "location") { setDimRows(locRows); return; }   // reuse, no refetch
    setDimLoading(true);
    fetchViz("cmp_two", `dim=${dim}&aStart=${a.start}&aEnd=${a.end}&bStart=${b.start}&bEnd=${b.end}${bq}${cutQ}`)
      .then((r) => { if (live) { setDimRows(r); setDimLoading(false); } })
      .catch(() => live && setDimLoading(false));
    return () => { live = false; };
  }, [periodKey, dim, locRows]);

  /* ------------------------------------------------------------- derived */
  const bridge = useMemo(() => growthBridge(locRows), [locRows]);
  const L = bridge.breakdown;

  const daysA = dayCount(a.start, a.end), daysB = dayCount(b.start, b.end);
  const tdA = tradingDays(trendA), tdB = tradingDays(trendB);

  const totals = useMemo(() => {
    const src = lflOnly ? L.items.filter((r) => r.cls === ENTITY.COMPARABLE) : L.items;
    const t = src.reduce((s, r) => ({
      aSales: s.aSales + r.aSales, bSales: s.bSales + r.bSales,
      aOrders: s.aOrders + r.aOrders, bOrders: s.bOrders + r.bOrders,
    }), { aSales: 0, bSales: 0, aOrders: 0, bOrders: 0 });
    return { ...t, aAov: t.aOrders ? t.aSales / t.aOrders : 0, bAov: t.bOrders ? t.bSales / t.bOrders : 0 };
  }, [L.items, lflOnly]);

  const vr = useMemo(() => volumeRateSplit(totals), [totals]);

  // completeness = share of calendar days that carry data
  const completenessA = daysA ? Math.min(1, tdA / daysA) : 1;
  const completenessB = daysB ? Math.min(1, tdB / daysB) : 1;
  // §6 A day is "partial" when its data stops before the end of the day. Detected
  // from the data itself (last hour with sales), not from the clock — that also
  // catches late-arriving feeds on a day that has already finished.
  const lastHour = coverage && isFinite(Number(coverage.lastHour)) ? Number(coverage.lastHour) : null;
  const isPartialDay = lastHour != null && lastHour >= 0 && lastHour < 23;
  const includesToday = a.end >= today;
  const partial = isPartialDay || includesToday;
  const hourTxt = (h) => `${(h % 12) || 12}${h < 12 ? "am" : "pm"}`;
  const coverPct = lastHour != null && lastHour >= 0 ? Math.round(((lastHour + 1) / 24) * 100) : 100;

  const quality = useMemo(() => qualityScore({
    daysA, daysB, tradingDaysA: tdA, tradingDaysB: tdB,
    completenessA, completenessB,
    commonBranches: L.counts.comparable,
    branchesA: L.counts.comparable + L.counts.new,
    branchesB: L.counts.comparable + L.counts.missing,
    // once the cutoff is applied both periods are clipped identically, so the
    // comparison is fair again and the penalty no longer applies
    partialDay: partial && cutHour == null,
    partialCutoffLabel: lastHour != null ? hourTxt(lastHour) : "",
    eventAligned: eventPick ? true : null,
  }), [daysA, daysB, tdA, tdB, completenessA, completenessB, L.counts, partial, cutHour, lastHour, eventPick]);

  const normCtx = (side) => ({
    calendarDays: side === "a" ? daysA : daysB,
    tradingDays: side === "a" ? tdA : tdB,
    branches: side === "a" ? L.counts.comparable + L.counts.new : L.counts.comparable + L.counts.missing,
    orders: side === "a" ? totals.aOrders : totals.bOrders,
  });
  // AOV and index are already rates — normalizing them again would be wrong
  const normApplies = (mKey) => mKey !== "aov" && norm !== "total";
  const nz = (v, side, mKey, base) => (normApplies(mKey) ? normalize(v, norm, normCtx(side), base) : v);

  const M = METRICS.find((m) => m.k === metric);

  /* ------------------------------------------------------------- actions */
  const swap = useCallback(() => { setA(b); setB(a); }, [a, b]);
  const reset = useCallback(() => {
    setA({ start: shiftDays(today, -7), end: shiftDays(today, -1) });
    setB({ start: shiftDays(today, -14), end: shiftDays(today, -8) });
    setDim("location"); setMetric("sales"); setNorm("total"); setLflOnly(false);
    setCutHour(null); setEventPick(""); setCmpName("");
  }, [today]);
  const copyLink = useCallback(async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard blocked — the URL bar already holds the state */ }
  }, []);
  const setPrevPeriod = () => setB({ start: shiftDays(a.start, -daysA), end: shiftDays(a.start, -1) });
  const setLastYear = () => setB({ start: shiftDays(a.start, -364), end: shiftDays(a.end, -364) });
  const exportCsv = () => {
    const rows = L.items.map((r) => ({
      branch: r.label, classification: r.cls, reason: r.reason,
      salesA: r.aSales, salesB: r.bSales, salesVariance: r.aSales - r.bSales,
      ordersA: r.aOrders, ordersB: r.bOrders,
    }));
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [`Period A,${a.start} to ${a.end}`, `Period B,${b.start} to ${b.end}`, "",
      cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const el = document.createElement("a"); el.href = url; el.download = `Compare-${a.start}-vs-${b.start}.csv`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /* --------------------------------------------------------------- trend */
  const trend = useMemo(() => {
    const n = Math.max(trendA.length, trendB.length);
    const val = (arr, i) => {
      const r = arr[i]; if (!r) return null;
      if (metric === "aov") return nn(r.orders) ? nn(r.sales) / nn(r.orders) : null;
      return nn(metric === "orders" ? r.orders : r.sales);
    };
    const baseA = val(trendA, 0), baseB = val(trendB, 0);
    const idx = (v, base) => (norm === "indexed" ? (base ? (v / base) * 100 : null) : v);
    return {
      x: Array.from({ length: n }, (_, i) => (trendA[i] ? fmtShort(trendA[i].date) : `Day ${i + 1}`)),
      series: [
        { name: "Period A", data: Array.from({ length: n }, (_, i) => idx(val(trendA, i), baseA)), color: T.accent, width: 2.6 },
        { name: "Period B", data: Array.from({ length: n }, (_, i) => idx(val(trendB, i), baseB)), color: "#98A2B3", width: 2, dashed: true },
      ],
    };
  }, [trendA, trendB, metric, norm]);

  /* ------------------------------------------------------------- bridge */
  const bridgeOption = useMemo(() => {
    const steps = bridge.steps;
    const labels = steps.map((s) => s.label);
    const base = [], bars = [];
    let run = 0;
    steps.forEach((s) => {
      if (s.type === "total") { base.push(0); bars.push(s.value); run = s.value; }
      else { const from = s.value >= 0 ? run : run + s.value; base.push(from); bars.push(Math.abs(s.value)); run += s.value; }
    });
    return {
      grid: { left: 8, right: 16, top: 20, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis", axisPointer: { type: "shadow" },
        formatter: (ps) => { const i = ps[0].dataIndex; const s = steps[i]; return `${s.label}<br/><b>${s.type === "total" ? kd(s.value) : (s.value >= 0 ? "+" : "−") + kd(Math.abs(s.value))}</b>`; },
      },
      xAxis: { type: "category", data: labels, axisLabel: { color: T.muted, fontSize: 10, fontFamily: T.font, interval: 0, width: 90, overflow: "break" }, axisLine: { show: false }, axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { color: T.muted, fontSize: 10, fontFamily: T.font, formatter: (v) => Math.round(v / 1000) + "k" }, splitLine: { lineStyle: { color: T.line, type: "dashed" } } },
      series: [
        { type: "bar", stack: "t", itemStyle: { color: "transparent" }, data: base, silent: true },
        { type: "bar", stack: "t", barWidth: "55%", data: steps.map((s, i) => ({
            value: bars[i],
            itemStyle: {
              color: s.type === "total" ? "#667085" : s.key === "residual" ? "#F79009" : s.value >= 0 ? T.pos : T.red,
              borderRadius: 4,
            },
          })) },
      ],
    };
  }, [bridge]);

  /* ---------------------------------------------------- breakdown table */
  const table = useMemo(() => {
    const rows = (dimRows || []).map((r) => {
      const aS = nn(r.aSales), bS = nn(r.bSales), aO = nn(r.aOrders), bO = nn(r.bOrders);
      return { label: r.label || "—", wd: nn(r.wd), aSales: aS, bSales: bS, aOrders: aO, bOrders: bO,
        aAov: aO ? aS / aO : 0, bAov: bO ? bS / bO : 0 };
    });
    const withMix = mixShift(rows, "aSales", "bSales");
    return dim === "day" ? withMix.sort((x, y) => x.wd - y.wd) : withMix.sort((x, y) => y.aSales - x.aSales);
  }, [dimRows, dim]);

  const contrib = useMemo(() => contributors(table, { key: M.aKey, baseKey: M.bKey, limit: 10 }), [table, M]);

  const narrative = useMemo(() => buildNarrative({
    breakdown: L, volumeRate: vr, contributors: contributors(L.items, { limit: 5 }),
    quality, metricFmt: kd, dimLabel: "branch", mixRows: table,
  }), [L, vr, quality, table]);

  // §20 presentation deck — the guided sequence from the spec, from live numbers
  const slides = useMemo(() => {
    const bigStat = (v, sub) => <div className="cmp-slide-stat"><span className="num">{v}</span><em>{sub}</em></div>;
    const listOf = (rows, tone) => (
      <ul className="cmp-slide-list">
        {rows.slice(0, 5).map((r) => <li key={r.label}><span>{r.label}</span><b className={`num ${tone}`}>{(r.delta >= 0 ? "+" : "−") + kd(Math.abs(r.delta))}</b></li>)}
      </ul>
    );
    const cN = contributors(L.items, { limit: 5 });
    return [
      { kicker: "Executive overview", title: `Net sales ${L.variance >= 0 ? "grew" : "declined"} ${pctTxt(L.totalGrowthPct)}`,
        body: <div className="cmp-slide-row">{bigStat(kd(L.totalA), "Period A")}{bigStat(kd(L.totalB), "Period B")}{bigStat((L.variance >= 0 ? "+" : "−") + kd(Math.abs(L.variance)), "Variance")}</div> },
      { kicker: "Growth composition", title: "Like-for-like versus network",
        body: <div className="cmp-slide-row">{bigStat(pctTxt(L.lflGrowthPct), "LFL growth")}{bigStat((L.newContribution >= 0 ? "+" : "") + kd(L.newContribution), "New branches")}{bigStat(kd(L.closedImpact), "Closed impact")}</div> },
      { kicker: "What moved it", title: "Volume versus ticket",
        body: <div className="cmp-slide-row">{bigStat(kd(vr.orderEffect), "Order effect")}{bigStat(kd(vr.atvEffect), "ATV effect")}</div> },
      { kicker: "Risk areas", title: "Largest negative contributors", body: cN.negative.length ? listOf(cN.negative, "neg") : <p>No material declines.</p> },
      { kicker: "Opportunities", title: "Largest positive contributors", body: cN.positive.length ? listOf(cN.positive, "pos") : <p>No material gains.</p> },
      { kicker: "Trust", title: `Comparison quality ${quality.score} / 100`,
        body: <div><p className="cmp-slide-status">{quality.status}</p>{quality.warnings.length ? <ul className="cmp-slide-list warn">{quality.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : <p>No data-quality issues detected.</p>}</div> },
    ];
  }, [L, vr, quality]);

  const cols = useMemo(() => [
    { key: "label", label: DIMS.find((d) => d.k === dim).label, align: "l", type: "text" },
    { key: M.aKey, label: "Period A", align: "r", render: (r) => <span className="num">{M.fmt(r[M.aKey])}</span> },
    { key: M.bKey, label: "Period B", align: "r", render: (r) => <span className="num">{M.fmt(r[M.bKey])}</span> },
    { key: "_var", label: "Variance", align: "r", render: (r) => <span className="num">{M.fmt(r[M.aKey] - r[M.bKey])}</span> },
    { key: "_g", label: "Growth", align: "r", render: (r) => <DeltaPill value={r[M.bKey] ? (r[M.aKey] - r[M.bKey]) / r[M.bKey] : null} lowerBetter={isLowerBetter(metric)} /> },
    { key: "mixPoints", label: "Mix move", align: "r", render: (r) => <span className={`cmp-pp ${r.mixPoints > 0.05 ? "up" : r.mixPoints < -0.05 ? "down" : ""}`}>{ppTxt(r.mixPoints)}</span> },
  ], [dim, M, metric]);

  /* ------------------------------------------------------------- render */
  const KpiCard = ({ label, term, mKey, av, bv, fmt, contribution }) => {
    const varAbs = av - bv;
    const varPct = bv ? varAbs / bv : null;
    const st = statusLabel(varPct, mKey, { incomplete: completenessA < 0.999 });
    const tone = statusTone(st);
    const nA = nz(av, "a", mKey, bv), nB = nz(bv, "b", mKey, bv);
    return (
      <div className="card cmp-kpi" tabIndex={0}>
        <div className="cmp-kpi-top">
          <span className="uplabel"><Term k={term}>{label}</Term></span>
          <span className={`cmp-status ${tone}`}>{st}</span>
        </div>
        <span className="cmp-kpi-val num">{fmt(nA)}</span>
        <div className="cmp-kpi-foot">
          <DeltaPill value={varPct} lowerBetter={isLowerBetter(mKey)} />
          <span className="cmp-kpi-b">vs {fmt(nB)}</span>
        </div>
        <div className="cmp-kpi-meta">
          <span>Abs <b className="num">{(varAbs >= 0 ? "+" : "−") + fmt(Math.abs(varAbs))}</b></span>
          {daysA > 0 && <span>Daily <b className="num">{(varAbs / daysA >= 0 ? "+" : "−") + fmt(Math.abs(varAbs / daysA))}</b></span>}
          {contribution != null && <span>Share <b className="num">{pctTxt(contribution, 0)}</b></span>}
        </div>
      </div>
    );
  };

  const Sec = ({ n, title, sub, children, viz, label }) => (
    <section className="cmp-sec" data-viz={viz} data-viz-label={label}>
      <header className="cmp-sec-h">
        <span className="cmp-sec-n">{n}</span>
        <div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
      </header>
      {children}
    </section>
  );

  return (
    <div className={cls("page cmp2", loading)}>
      <UpdatingBar show={loading} brand={gbrand} />

      {/* ============ §1 COMMAND CENTER (sticky) ============ */}
      <div className="cmp-cc stays-live">
        {/* compact summary — the two ranges live in a popup so the bar stays clean */}
        <div className="cmp-periods-row">
          <button className="cmp-periods-trigger" onClick={() => setPeriodOpen(true)} aria-label="Choose comparison periods">
            <CalendarRange size={16} className="cmp-pt-ico" />
            <span className="cmp-pp a"><em>A</em>{fmtDay(a.start)} – {fmtDay(a.end)}<i>{daysA}d</i></span>
            <span className="cmp-pp-vs">vs</span>
            <span className="cmp-pp b"><em>B</em>{fmtDay(b.start)} – {fmtDay(b.end)}<i>{daysB}d</i></span>
            <Pencil size={13} className="cmp-pt-edit" />
          </button>
          <button className="cmp-cc-swap" onClick={swap} title="Swap Period A and B" aria-label="Swap periods"><ArrowLeftRight size={15} /></button>
        </div>

        <div className="cmp-cc-meta">
          <span className={`cmp-chip ${quality.score >= 90 ? "ok" : quality.score >= 55 ? "warn" : "bad"}`}
            title={quality.warnings.join("\n") || "No issues detected"}>
            {quality.score >= 90 ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {quality.status} · {quality.score}/100
          </span>
          <span className="cmp-chip">{lflOnly ? "Like-for-Like" : "Total business"}</span>
          <span className="cmp-chip">{eventPick ? `Aligned: ${eventPick} Day 1→${daysA}` : "Aligned: calendar dates"}</span>
          <span className="cmp-chip">{L.counts.comparable} common branches</span>
          <span className="cmp-chip">{gbrand === "all" ? "All brands" : gbrand}</span>
          <span className={`cmp-chip ${partial && cutHour == null ? "warn" : ""}`}>
            Coverage {cutHour != null ? `to ${hourTxt(cutHour)} (both)` : partial && lastHour != null ? `${coverPct}% — to ${hourTxt(lastHour)}` : `${Math.round(completenessA * 100)}%`}
          </span>
          {freshAt && <span className="cmp-chip muted">Updated {new Date(freshAt).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" })}</span>}
        </div>

        <div className="cmp-cc-actions">
          <button className="cmp2-quick" onClick={setPrevPeriod}>Previous period</button>
          <button className="cmp2-quick" onClick={setLastYear}>Same period last year</button>
          {eventNames.length > 0 && (
            <select className="cmp-sel" value={eventPick} onChange={(e) => applyEventAlignment(e.target.value)} aria-label="Align to business event">
              <option value="">Align to occasion…</option>
              {eventNames.map((n) => <option key={n} value={n}>{n} — this year vs last</option>)}
            </select>
          )}
          <label className="cmp-toggle">
            <input type="checkbox" checked={lflOnly} onChange={(e) => setLflOnly(e.target.checked)} />
            <span>Like-for-Like only</span>
          </label>
          <select className="cmp-sel" value={norm} onChange={(e) => setNorm(e.target.value)} aria-label="Normalization">
            {NORMALIZERS.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
          </select>
          <input className="cmp-name" value={cmpName} placeholder="Name this comparison…" onChange={(e) => setCmpName(e.target.value)} aria-label="Comparison name" />
          <div className="spacer" />
          <button className="cmp2-quick" onClick={copyLink} title="Copy a link that reopens this exact comparison">
            {copied ? <CheckCircle2 size={14} /> : <Link2 size={14} />} {copied ? "Copied" : "Share"}
          </button>
          <button className="cmp2-quick" onClick={() => { setSlide(0); setPresent(true); }} title="Presentation mode"><Presentation size={14} /> Present</button>
          <button className="cmp2-quick" onClick={exportCsv} title="Export branch detail as CSV"><Download size={14} /> Export</button>
          <button className="cmp2-quick" onClick={reset} title="Reset to defaults"><RotateCcw size={14} /> Reset</button>
        </div>
      </div>

      {/* ============ PERIOD PICKER POPUP ============ */}
      {periodOpen && createPortal(
        <div className="cmp-pmodal-scrim" onClick={() => setPeriodOpen(false)}>
          <div className="cmp-pmodal" role="dialog" aria-modal="true" aria-label="Choose comparison periods" onClick={(e) => e.stopPropagation()}>
            <div className="cmp-pmodal-h"><b>Comparison periods</b><button className="ic" onClick={() => setPeriodOpen(false)} aria-label="Close"><X size={16} /></button></div>
            <div className="cmp-pmodal-body">
              <div className="cmp-pcol a">
                <div className="cmp-pcol-h"><span className="cmp-cc-tag">Period A — under review</span><span className="cmp-cc-days">{fmtDay(a.start)} – {fmtDay(a.end)} · {daysA}d</span></div>
                <RangeCalendar sel={{ preset: "custom", start: a.start, end: a.end }} onPick={(s, e) => setA({ start: s, end: e })} />
              </div>
              <button className="cmp-pmodal-swap" onClick={swap} title="Swap A and B"><ArrowLeftRight size={16} /> Swap</button>
              <div className="cmp-pcol b">
                <div className="cmp-pcol-h"><span className="cmp-cc-tag">Period B — baseline</span><span className="cmp-cc-days">{fmtDay(b.start)} – {fmtDay(b.end)} · {daysB}d</span></div>
                <RangeCalendar sel={{ preset: "custom", start: b.start, end: b.end }} onPick={(s, e) => setB({ start: s, end: e })} />
              </div>
            </div>
            <div className="cmp-pmodal-quick">
              <span className="cmp-pmodal-qlabel">Set Period B to</span>
              <button className="cmp2-quick" onClick={setPrevPeriod}>Previous period</button>
              <button className="cmp2-quick" onClick={setLastYear}>Same period last year</button>
              {eventNames.length > 0 && (
                <select className="cmp-sel" value={eventPick} onChange={(e) => applyEventAlignment(e.target.value)} aria-label="Align to business event">
                  <option value="">Align to occasion…</option>
                  {eventNames.map((n) => <option key={n} value={n}>{n} — this year vs last</option>)}
                </select>
              )}
            </div>
            <div className="cmp-pmodal-foot">
              <button className="btn primary" onClick={() => setPeriodOpen(false)}>Done</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ============ §6 PARTIAL-DAY PROTECTION ============ */}
      {partial && (
        <div className={`cmp-warn ${cutHour != null ? "fixed" : ""}`} role="status">
          {cutHour != null ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <div>
            {cutHour != null ? (
              <>
                <b>Same-hour comparison active — both periods clipped to {hourTxt(cutHour)}</b>
                <ul><li>Every figure on this page counts only hours up to {hourTxt(cutHour)} in <em>both</em> periods, so the part-day is compared like for like. <button className="cmp-linkbtn" onClick={() => setCutHour(null)}>Switch back to full days</button></li></ul>
              </>
            ) : (
              <>
                <b>Period A ends on an incomplete day</b>
                <ul>
                  <li>
                    {fmtDay(a.end)} has data to <b>{lastHour != null ? hourTxt(lastHour) : "an earlier hour"}</b> ({coverPct}% of the day).
                    Comparing it against a full day understates Period A.
                    {lastHour != null && <> <button className="cmp-linkbtn" onClick={() => setCutHour(lastHour)}>Compare both periods to {hourTxt(lastHour)}</button></>}
                  </li>
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {/* ============ §7 UNCONFIRMED EVENT DATES ============ */}
      {unconfirmed.length > 0 && (
        <div className="cmp-warn" role="status">
          <Info size={15} />
          <div>
            <b>Estimated event dates — awaiting business confirmation</b>
            <ul>
              {unconfirmed.map((e) => <li key={e.id}>{e.name} {e.year}: {fmtDay(e.start)} – {fmtDay(e.end)} is an estimate. An admin should confirm it in Admin → Business Events before this comparison is treated as final.</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* ============ §17 QUALITY WARNINGS ============ */}
      {quality.warnings.length > 0 && (
        <div className="cmp-warn" role="status">
          <AlertTriangle size={15} />
          <div>
            <b>Comparison quality {quality.score}/100 — {quality.status}</b>
            <ul>{quality.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        </div>
      )}

      {/* ============ §2 EXECUTIVE KPI SUMMARY ============ */}
      <Sec n="1" title="Executive summary" sub={`${fmtDay(a.start)} – ${fmtDay(a.end)} versus ${fmtDay(b.start)} – ${fmtDay(b.end)}${norm !== "total" ? ` · ${NORMALIZERS.find((x) => x.k === norm).label}` : ""}`}>
        {loading ? <div className="cmp2-kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="card cmp-kpi"><Skeleton h={92} /></div>)}</div> : (
          <div className="cmp2-kpis">
            <KpiCard label="Net Sales" term="netsales" mKey="sales" av={totals.aSales} bv={totals.bSales} fmt={kd} contribution={1} />
            <KpiCard label="Orders" term="orders" mKey="orders" av={totals.aOrders} bv={totals.bOrders} fmt={num}
              contribution={vr.variance ? vr.orderEffect / vr.variance : null} />
            <KpiCard label="AOV" term="aov" mKey="aov" av={totals.aAov} bv={totals.bAov} fmt={kdc}
              contribution={vr.variance ? vr.atvEffect / vr.variance : null} />
            <div className="card cmp-kpi">
              <div className="cmp-kpi-top"><span className="uplabel">LFL growth</span>
                <span className={`cmp-status ${statusTone(statusLabel(L.lflGrowthPct, "sales"))}`}>{statusLabel(L.lflGrowthPct, "sales")}</span>
              </div>
              <span className="cmp-kpi-val num">{pctTxt(L.lflGrowthPct)}</span>
              <div className="cmp-kpi-foot"><span className="cmp-kpi-b">{L.counts.comparable} branches in both periods</span></div>
              <div className="cmp-kpi-meta">
                <span>Total <b className="num">{pctTxt(L.totalGrowthPct)}</b></span>
                <span>Expansion <b className="num">{pctTxt(L.expansionPct)}</b></span>
                <span>Closure <b className="num">{pctTxt(L.closurePct)}</b></span>
              </div>
            </div>
          </div>
        )}
      </Sec>

      {/* ============ §15 EXECUTIVE NARRATIVE ============ */}
      <Sec n="2" title="What the numbers say" sub="generated from the calculated results on this page — no external model, no invented causes">
        {loading ? <Skeleton h={160} /> : (
          <div className="cmp-narr">
            {narrative.map((s) => (
              <div key={s.title} className={`card cmp-narr-card ${s.tone}`}>
                <span className="uplabel">{s.title}</span>
                <ul>
                  {s.lines.map((l, i) => (
                    <li key={i} className={l.hypothesis ? "hyp" : ""}>
                      {l.hypothesis && <span className="cmp-hyp-tag">Hypothesis</span>}
                      {l.text}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Sec>

      {/* ============ §5 INDEXED TREND ============ */}
      <Sec n="3" title={`Daily ${M.label} — A vs B`} sub={norm === "indexed" ? "indexed to each period's first day = 100" : "aligned by day index"} viz="cmp_trend" label={`Daily ${M.label}`}>
        <div className="cmp-ctrls">
          <div className="cc-hr-switch" role="tablist" aria-label="Metric">
            {METRICS.map((m) => <button key={m.k} role="tab" aria-selected={metric === m.k} className={`cc-hr-seg ${metric === m.k ? "on" : ""}`} onClick={() => setMetric(m.k)}>{m.label}</button>)}
          </div>
        </div>
        <div className="card">
          {loading ? <Skeleton h={260} /> : !trend.x.length ? <div className="dt-empty">No data for these ranges</div>
            : <EChart height={260} option={multiLineOption({ x: trend.x, series: trend.series, fmt: norm === "indexed" ? (v) => Number(v).toFixed(1) : M.fmt })} />}
        </div>
      </Sec>

      {/* ============ §3 GROWTH BRIDGE ============ */}
      <Sec n="4" title="Growth bridge" sub="how Period B net sales became Period A net sales" viz="cmp_two" label="Growth Bridge">
        <div className="card">
          {loading ? <Skeleton h={300} /> : !L.items.length ? <div className="dt-empty">No data</div> : (
            <>
              <EChart height={300} option={bridgeOption} />
              <p className="cmp-note">
                {bridge.reconciles
                  ? <><CheckCircle2 size={13} /> Components reconcile exactly to the total variance of {kd(L.variance)}.</>
                  : <><AlertTriangle size={13} /> Unexplained residual of {kd(L.residual)} is shown as its own step rather than hidden.</>}
              </p>
            </>
          )}
        </div>
      </Sec>

      {/* ============ §4 LFL vs EXPANSION ============ */}
      <Sec n="5" title="Like-for-Like versus network growth" sub="separating same-branch performance from openings and closures">
        <div className="cmp-lfl">
          {[
            { label: "Total growth", val: L.totalGrowthPct, abs: L.variance, note: `${L.items.length} branches in scope` },
            { label: "Like-for-Like", val: L.lflGrowthPct, abs: L.lflDelta, note: `${L.counts.comparable} in both periods` },
            { label: "New branches", val: L.expansionPct, abs: L.newContribution, note: `${L.counts.new} new in Period A` },
            { label: "Closed / missing", val: L.closurePct, abs: L.closedImpact, note: `${L.counts.missing} absent in Period A` },
          ].map((x) => (
            <div key={x.label} className="card cmp-lfl-card">
              <span className="uplabel">{x.label}</span>
              <span className={`cmp-lfl-val num ${x.abs > 0 ? "pos" : x.abs < 0 ? "neg" : ""}`}>{pctTxt(x.val)}</span>
              <span className="cmp-lfl-abs num">{(x.abs >= 0 ? "+" : "−") + kd(Math.abs(x.abs))}</span>
              <span className="cmp-lfl-note">{x.note}</span>
            </div>
          ))}
        </div>
        {(L.counts.new > 0 || L.counts.missing > 0) && (
          <div className="card cmp-excl">
            <div className="card-head"><span className="card-title">Branches excluded from Like-for-Like</span><span className="uplabel">with reason</span></div>
            <ul className="cmp-excl-list">
              {L.items.filter((r) => r.cls === ENTITY.NEW_IN_A || r.cls === ENTITY.MISSING_IN_A).slice(0, 12).map((r) => (
                <li key={r.label}>
                  <b>{r.label}</b>
                  <span className={`cmp-tag ${r.cls === ENTITY.NEW_IN_A ? "new" : "gone"}`}>{r.cls}</span>
                  <span className="cmp-excl-why">{r.reason}</span>
                  <span className="num">{kd(r.cls === ENTITY.NEW_IN_A ? r.aSales : r.bSales)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Sec>

      {/* ============ §10 CONTRIBUTORS ============ */}
      <Sec n="6" title="Top contributors" sub="ranked by absolute impact on the movement, not percentage growth">
        <div className="cmp-ctrls">
          <div className="cc-hr-switch" role="tablist" aria-label="Break down by">
            {DIMS.map((d) => <button key={d.k} role="tab" aria-selected={dim === d.k} className={`cc-hr-seg ${dim === d.k ? "on" : ""}`} onClick={() => setDim(d.k)}>{d.label}</button>)}
          </div>
        </div>
        {dimLoading ? <Skeleton h={200} /> : (
          <div className="cmp-contrib">
            {[{ t: "Largest positive", rows: contrib.positive, tone: "pos" }, { t: "Largest negative", rows: contrib.negative, tone: "neg" }].map((g) => (
              <div key={g.t} className="card">
                <div className="card-head"><span className="card-title">{g.t}</span><span className="uplabel">{M.label}</span></div>
                {!g.rows.length ? <div className="dt-empty">None</div> : (
                  <ul className="cmp-contrib-list">
                    {g.rows.map((r) => (
                      <li key={r.label}>
                        <span className="cmp-contrib-n" title={r.label}>{r.label}</span>
                        <span className={`cmp-contrib-bar ${g.tone}`}><i style={{ width: `${Math.min(100, Math.abs(r.shareOfSide || 0) * 100)}%` }} /></span>
                        <span className={`num cmp-contrib-v ${g.tone}`}>{(r.delta >= 0 ? "+" : "−") + M.fmt(Math.abs(r.delta))}</span>
                        <span className="cmp-contrib-s num">{pctTxt(r.shareOfSide, 0)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Sec>

      {/* ============ §12 DETAIL TABLE ============ */}
      <Sec n="7" title={`${M.label} by ${DIMS.find((d) => d.k === dim).label}`} sub="mix movement in percentage points" viz="cmp_two" label="Comparison detail">
        <div className="card">
          {dimLoading ? <Skeleton h={300} /> : !table.length ? <div className="dt-empty">No data for these ranges</div> : (
            <DataGrid title={`${M.label} by ${DIMS.find((d) => d.k === dim).label}`} filename={`Compare-${dim}-${metric}`}
              columns={cols} rows={table} defaultSort={dim === "day" ? null : { key: M.aKey, dir: "desc" }} />
          )}
        </div>
      </Sec>

      {/* ============ §26 METHODOLOGY ============ */}
      <Sec n="8" title="Methodology & reconciliation" sub="how these numbers are produced">
        <div className="card cmp-method">
          <dl>
            <dt>Net Sales variance</dt>
            <dd className="num">{kd(totals.aSales)} − {kd(totals.bSales)} = {kd(totals.aSales - totals.bSales)} ({pctTxt(totals.bSales ? (totals.aSales - totals.bSales) / totals.bSales : null, 2)})</dd>
            <dt>Like-for-Like</dt>
            <dd>Branches with sales above 0 in <em>both</em> periods ({L.counts.comparable} of {L.items.length}). LFL growth = {kd(L.lflDelta)} ÷ {kd(L.lflB)}.</dd>
            <dt>Growth bridge</dt>
            <dd>LFL {kd(L.lflDelta)} + new {kd(L.newContribution)} + closed {kd(L.closedImpact)} = {kd(L.lflDelta + L.newContribution + L.closedImpact)}, versus a total variance of {kd(L.variance)}. {bridge.reconciles ? "Reconciled." : `Residual ${kd(L.residual)} shown explicitly.`}</dd>
            <dt>Order vs ATV split</dt>
            <dd>Order effect {kd(vr.orderEffect)} (volume change at the Period B ticket) + ATV effect {kd(vr.atvEffect)} (ticket change on Period A volume) = {kd(vr.orderEffect + vr.atvEffect)}.</dd>
            <dt>Mix movement</dt>
            <dd>Expressed in percentage points (share A − share B), never as growth of a percentage.</dd>
            <dt>Data completeness</dt>
            <dd>Period A {Math.round(completenessA * 100)}% ({tdA} of {daysA} days carry data) · Period B {Math.round(completenessB * 100)}% ({tdB} of {daysB}).</dd>
          </dl>
        </div>
      </Sec>

      {/* ============ §20 PRESENTATION MODE ============ */}
      {present && <PresentMode slides={slides} slide={slide} setSlide={setSlide} onClose={() => setPresent(false)}
        title={cmpName || "Period Comparison"} periodTxt={`${fmtDay(a.start)} – ${fmtDay(a.end)}  vs  ${fmtDay(b.start)} – ${fmtDay(b.end)}`}
        freshAt={freshAt} brandTxt={gbrand === "all" ? "All brands" : gbrand} />}
    </div>
  );
}

// §20 Presentation mode: a guided, large-type sequence for management meetings.
// Reuses the already-computed results — no refetch. Keyboard: ← → navigate, Esc closes.
function PresentMode({ slides, slide, setSlide, onClose, title, periodTxt, freshAt, brandTxt }) {
  const n = slides.length;
  const go = useCallback((d) => setSlide((s) => Math.max(0, Math.min(n - 1, s + d))), [n, setSlide]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);
  const s = slides[slide] || {};
  return (
    <div className="cmp-present" role="dialog" aria-modal="true" aria-label="Presentation mode">
      <header className="cmp-present-top">
        <div><b>{title}</b><span>{periodTxt} · {brandTxt}</span></div>
        <button className="ic" onClick={onClose} aria-label="Exit presentation"><X size={18} /></button>
      </header>
      <div className="cmp-present-stage">
        <span className="cmp-present-n">{slide + 1} / {n} · {s.kicker}</span>
        <h2>{s.title}</h2>
        <div className="cmp-present-body">{s.body}</div>
      </div>
      <footer className="cmp-present-foot">
        <button className="cmp2-quick" onClick={() => go(-1)} disabled={slide === 0}><ChevronLeft size={15} /> Back</button>
        <div className="cmp-present-dots">{slides.map((_, i) => <span key={i} className={i === slide ? "on" : ""} onClick={() => setSlide(i)} />)}</div>
        <button className="cmp2-quick" onClick={() => go(1)} disabled={slide === n - 1}>Next <ChevronRight size={15} /></button>
        {freshAt && <span className="cmp-present-ts">Data as of {new Date(freshAt).toLocaleString("en-GB", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })}</span>}
      </footer>
    </div>
  );
}

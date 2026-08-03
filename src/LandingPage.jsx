import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { X, ChevronDown, Filter, Wallet, Home } from "lucide-react";
import { Rise, EChart, Matrix, DataGrid, CountUp, Pill, DeltaPill, Skeleton, gaugeOption, BrandMark, ChannelMark } from "./ui.jsx";
import AgTable from "./AgTableLazy.jsx";
import { HOME_WIDGETS } from "./widgets/homeWidgets.jsx";
import WidgetGrid from "./widgets/WidgetGrid.jsx";
import { kd, kdc, num, kk, T, tooltipBase } from "./theme.js";
import { selQuery, presetLabel, activeComparisons } from "./dates.js";
import { cls, UpdatingBar } from "./Updating.jsx";
import { swr } from "./clientCache.js";

async function fetchViz(name, qstr) {
  const res = await fetch(`/api/viz/${name}?${qstr}`);
  if (!res.ok) throw new Error(name);
  const j = await res.json();
  return { data: j.row != null ? j.row : j.rows || [], extra: j.extraCols || [] };
}
// build a table's columns from its fixed base + any admin-added measures (extraCols),
// dropping typed base measures whose data is now absent (removed via the editor).
function withExtras(baseMeasures, rows, extraCols) {
  const keep = new Set(["share", "wow", "mom", "yoy"]);
  const base = baseMeasures.filter((m) => m.render || keep.has(m.key) || rows.some((r) => r && r[m.key] != null));
  const extra = (extraCols || []).filter((c) => !baseMeasures.some((m) => m.key === c.key)).map((c) => ({
    key: c.key, label: c.label, align: "r",
    render: (r) => { const v = r[c.key]; if (v == null) return <span className="num" style={{ color: "var(--muted-2)" }}>—</span>; const n = Number(v); return <span className="num">{isFinite(n) ? (Math.abs(n) >= 1000 ? kd(n) : Number.isInteger(n) ? num(n) : n.toFixed(2)) : String(v).slice(0, 24)}</span>; },
  }));
  return [...base, ...extra];
}
const nnum = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const has = (v) => v != null && isFinite(Number(v));
const delta = (cur, prev) => (has(cur) && has(prev) && Number(prev) !== 0 ? (Number(cur) - Number(prev)) / Number(prev) : null);
const fmtPct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
const minFmt = (v) => (has(v) ? Number(v).toFixed(1) + " min" : "—");
const pctFmt = (v) => (has(v) ? (Number(v) * 100).toFixed(2) + "%" : "—");

function buildQ(sel, scope, xf, omit) {
  let s = selQuery(sel);
  if (scope && scope.length) s += "&loc=" + encodeURIComponent(scope.join("|"));
  if (xf.brand && omit !== "brand") s += "&fb=" + encodeURIComponent(xf.brand);
  if (xf.channel && omit !== "channel") s += "&fc=" + encodeURIComponent(xf.channel);
  if (xf.location && omit !== "location") s += "&fl=" + encodeURIComponent(xf.location);
  return s;
}
const isTrue = (v) => v === true || v === 1;
function splitEnrich(rows, groupField) {
  const leaves = [], subs = {}; let grand = null;
  for (const r of rows) {
    if (isTrue(r.isGrandTotal)) grand = r;
    else if (isTrue(r.isGroupTotal)) subs[r[groupField] ?? "—"] = r;
    else leaves.push(r);
  }
  const grandNet = grand ? nnum(grand.netSales) : Object.values(subs).reduce((s, r) => s + nnum(r.netSales), 0);
  const enrich = (r) => ({
    ...r, _k: (r[groupField] ?? "") + "|" + (r.location ?? ""),
    wow: delta(r.netSales, r.netSales_w), mom: delta(r.netSales, r.netSales_m), yoy: delta(r.netSales, r.netSales_y),
    ordWow: delta(r.orders, r.orders_w), ordMom: delta(r.orders, r.orders_m), ordYoy: delta(r.orders, r.orders_y),
    share: grandNet ? nnum(r.netSales) / grandNet : null,
  });
  const groupTotals = {};
  Object.entries(subs).forEach(([k, v]) => { groupTotals[k] = enrich(v); });
  return { leaves: leaves.map(enrich), groupTotals, grand: grand ? enrich(grand) : null };
}
// rank by absolute KD impact (gap-to-target OR week swing, whichever larger)
function attention(entities, nameKey, netKey, tgtKey, wkKey) {
  const items = entities.map((e) => {
    const net = nnum(e[netKey]), tgt = nnum(e[tgtKey]), netW = nnum(e[wkKey]);
    const dT = tgt ? net - tgt : null, dW = netW ? net - netW : null;
    let impact = dT, pct = tgt ? (net - tgt) / tgt : null;
    if (dW != null && (dT == null || Math.abs(dW) > Math.abs(dT))) { impact = dW; pct = netW ? (net - netW) / netW : null; }
    return { name: e[nameKey], impact, pct };
  }).filter((x) => x.impact != null && isFinite(x.impact));
  return {
    problems: items.filter((x) => x.impact < 0).sort((a, b) => a.impact - b.impact).slice(0, 3),
    wins: items.filter((x) => x.impact > 0).sort((a, b) => b.impact - a.impact).slice(0, 3),
  };
}
const SCOPE_ROLE = (role) => role === "area" || role === "ops";

// operational health score 0–100 from the branch ops metrics (higher = healthier)
function opsHealthScore(o) {
  let s = 100;
  if (has(o.prep)) s -= Math.max(0, Number(o.prep) - 10) * 2.2;        // prep over 10 min
  if (has(o.delivery)) s -= Math.max(0, Number(o.delivery) - 30) * 1.1; // delivery over 30 min
  if (has(o.complaint)) s -= Number(o.complaint) * 1600;               // 1% complaint ≈ 16 pts
  if (has(o.offline)) s -= Number(o.offline) * 500;                    // 1% offline ≈ 5 pts
  return Math.max(0, Math.min(100, Math.round(s)));
}
const scoreTone = (s) => (s < 60 ? "bad" : s <= 80 ? "warn" : "good");
// tiny sparkline across the comparison periods (last year → last month → last week → now)
const sparkOption = (data, color) => ({
  grid: { left: 2, right: 2, top: 4, bottom: 2 },
  xAxis: { type: "category", show: false, data: data.map((_, i) => i) },
  yAxis: { type: "value", show: false, scale: true },
  series: [{ type: "line", data, smooth: true, showSymbol: false, connectNulls: true,
    lineStyle: { color, width: 2 }, areaStyle: { color: color + "22" } }],
});
const periodSpark = (o, base, color) => {
  const data = [o[`${base}_y`], o[`${base}_m`], o[`${base}_w`], o[base]].map((v) => (has(v) ? Number(v) : null));
  if (data.filter((v) => v != null).length < 2) return null;
  return <EChart height={40} option={sparkOption(data, color)} />;
};
const RoleFill = ({ title, sub, children }) => (
  <div className="lf-sec">
    <div className="lf-head"><span className="lf-title">{title}</span>{sub && <span className="lf-sub-cap">{sub}</span>}</div>
    {children}
  </div>
);

/* ------------------ shared table column sets ------------------ */
const shareCell = (r) => <span className="num">{r.share != null ? (r.share * 100).toFixed(1) + "%" : "—"}</span>;
// dynamic delta columns — one per active comparison (WoW/MoM/YoY) for this range
const DELTA_KEY = { w: "wow", m: "mom", y: "yoy" };
// the row also carries the compared-period value (netSales_w/_m/_y), so the pill can
// show the real figures and the exact window it was measured against
const BASE_KEY = { w: "netSales_w", m: "netSales_m", y: "netSales_y" };
const deltaCols = (comps) => comps.map((c) => ({
  key: DELTA_KEY[c.key],
  label: c.short,
  term: c.short,                       // header click → EN/AR/HI definition
  align: "r",
  tip: `${c.label}${c.rangeText ? " — comparing to " + c.rangeText : ""}`,
  render: (r) => (
    <DeltaPill
      value={r[DELTA_KEY[c.key]]}
      termKey={c.short}
      current={r.netSales}
      base={r[BASE_KEY[c.key]]}
      curLabel="This period"
      baseLabel={c.rangeText || c.label}
      fmt={kd}
    />
  ),
}));
// orders-based WoW/MoM/YoY delta columns. Values are precomputed on the row
// (ordWow/ordMom/ordYoy) exactly like the sales wow/mom/yoy columns.
const ORD_DELTA = { w: "ordWow", m: "ordMom", y: "ordYoy" };
const ORD_BASE = { w: "orders_w", m: "orders_m", y: "orders_y" };
const ordersDeltaCols = (comps) => comps.map((c) => ({
  key: ORD_DELTA[c.key],
  label: "Ord " + c.short,
  align: "r",
  tip: `Orders ${c.label}${c.rangeText ? " — comparing to " + c.rangeText : ""}`,
  render: (r) => (
    <DeltaPill value={r[ORD_DELTA[c.key]]} current={r.orders} base={r[ORD_BASE[c.key]]}
      curLabel="This period" baseLabel={c.rangeText || c.label} fmt={num} />
  ),
}));
// derived Orders Target = Sales Target / AOV target (resolved per row), + its gap %
const gapPct = (g) => (g == null || !isFinite(g) ? "—" : (g >= 0 ? "+" : "") + (g * 100).toFixed(1) + "%");
const ordersTargetOf = (r, aovResolver) => { const a = aovResolver ? aovResolver(r) : null; return a > 0 ? nnum(r.target) / a : null; };
const ordersTargetCol = (aovResolver) => ({
  key: "ordersTarget", label: "Ord Target", align: "r", always: true,
  render: (r) => { const ot = ordersTargetOf(r, aovResolver); return <span className="num">{ot != null ? num(Math.round(ot)) : "—"}</span>; },
});
const ordersGapCol = (aovResolver) => ({
  key: "ordersGap", label: "Ord Gap %", align: "r", always: true,
  render: (r) => { const ot = ordersTargetOf(r, aovResolver); const g = ot ? nnum(r.orders) / ot - 1 : null; return <Pill text={gapPct(g)} />; },
});
// full measure set — grouped: SALES block, then ORDERS block (count → W/M/Y → target
// → gap), then AOV. Runrate % removed (now the ACC top KPI).
const buildFull = (comps, aovResolver) => [
  { key: "netSales", label: "Net Sales", align: "r", type: "kd", total: true },
  { key: "share", label: "Share %", align: "r", render: shareCell },
  ...deltaCols(comps),
  { key: "target", label: "Sales Target", align: "r", type: "kd", total: true },
  { key: "gapText", label: "Sales Gap %", align: "r", type: "pct" },
  { key: "orders", label: "Orders", align: "r", type: "num", total: true },
  ...ordersDeltaCols(comps),
  ordersTargetCol(aovResolver),
  ordersGapCol(aovResolver),
  { key: "aov", label: "AOV", align: "r", type: "kdc" },
];
// channels DO carry targets in the model → same full column set as Brand
const buildChannel = buildFull;
const OPS_META = [
  { key: "prep", label: "Avg Prep Time", fmt: minFmt },
  { key: "delivery", label: "Avg Delivery Time", fmt: minFmt },
  { key: "complaint", label: "Complaint Ratio", fmt: pctFmt },
  { key: "discount", label: "Discount / Offer %", fmt: pctFmt },
];

/* ------------------ small animated KPI card ------------------ */
function Kpi({ index, label, value, format, deltaVal, deltaLabel = "vs last week", gapText, lowerBetter, loading, live, hero, period }) {
  return (
    <Rise index={index} className={`card kpi2 hoverable${hero ? " kpi2-hero" : ""}`}>
      {hero && <span className="kpi2-hero-ic"><Wallet size={16} /></span>}
      <span className="uplabel">{label}{live && <span className="livedot" style={{ marginLeft: 6 }} />}{period && <span className="kpi2-period">{period}</span>}</span>
      {loading ? <Skeleton w="62%" h={24} /> : <span className="kpi2-val num"><CountUp value={value || 0} format={format} /></span>}
      {!loading && (gapText !== undefined
        ? <span className="kpi2-delta"><Pill text={gapText} /><span className="kpi2-lbl">vs target</span></span>
        : deltaVal !== undefined && <span className="kpi2-delta"><span className="pulse"><DeltaPill value={deltaVal} lowerBetter={lowerBetter} /></span><span className="kpi2-lbl">{deltaLabel}</span></span>)}
    </Rise>
  );
}
// Achievement % card — headline = projected (actual + forecast) vs target,
// with the actual-so-far % underneath. Tone: green ≥100%, amber ≥90%, red below.
function AchCard({ index, label, actual, forecast, loading }) {
  const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const tone = (v) => (v == null ? "flat" : v >= 1 ? "pos" : v >= 0.9 ? "warn" : "neg");
  return (
    <Rise index={index} className="card kpi ach-kpi">
      <span className="uplabel">{label}</span>
      {loading ? <Skeleton w="60%" h={26} /> : (
        <>
          <span className={`ach-main num ${tone(forecast)}`}>{pct(forecast)}</span>
          <span className="ach-sub">projected · actual to date <b className="num">{pct(actual)}</b></span>
        </>
      )}
    </Rise>
  );
}

// Achievement gauge — fluorescent iOS ring showing projected (actual + forecast)
// achievement %. `value` is a 0–1 ratio.
function AchGauge({ index, label, value, loading }) {
  return (
    <Rise index={index} className="card kpi2 ach-gauge">
      <span className="uplabel">{label}</span>
      {loading ? <Skeleton w={64} h={64} style={{ borderRadius: "50%", margin: "2px auto" }} /> : <EChart height={104} option={gaugeOption({ value: (Number(value) || 0) * 100 })} />}
    </Rise>
  );
}

// ACC KPI — the model's Runrate % (e.g. "-4%"): projected achievement gap vs target.
function AccKpi({ index, label = "ACC", text, loading, period = "Runrate %" }) {
  const n = text != null && text !== "" ? parseFloat(String(text).replace(/[^0-9.\-]/g, "")) : null;
  const tone = n == null ? "" : n >= 0 ? "pos" : "neg";
  return (
    <Rise index={index} className="card kpi2 kpi2-big hoverable">
      <span className="uplabel">{label}{period && <span className="kpi2-period">{period}</span>}</span>
      {loading ? <Skeleton w="52%" h={30} /> : <span className={`kpi2-val num kpi2-val-big ${tone}`}>{text || "—"}</span>}
      {!loading && <span className="kpi2-lbl">projected vs target</span>}
    </Rise>
  );
}
// vs-period labels for the hero KPI delta rows
const VS_LABEL = { w: "vs last week", m: "vs last month", y: "vs last year" };
// Large headline KPI — one value + a stack of comparison rows (vs target / vs last
// week / month / year). `rows` items are either { label, gapText } or { label, deltaVal }.
function HeroKpi({ index, label, value, format, live, hero, tone, period, rows, loading }) {
  return (
    <Rise index={index} className={`card kpi2 kpi2-big hoverable${hero ? " kpi2-hero" : ""}${tone === "neg" ? " neg" : ""}`}>
      {hero && <span className="kpi2-hero-ic"><Wallet size={16} /></span>}
      <span className="uplabel">{label}{live && <span className="livedot" style={{ marginLeft: 6 }} />}{period && <span className="kpi2-period">{period}</span>}</span>
      {loading ? <Skeleton w="66%" h={30} /> : <span className="kpi2-val num kpi2-val-big"><CountUp value={value || 0} format={format} /></span>}
      {!loading && (
        <div className="kpi2-deltas">
          {(rows || []).filter(Boolean).map((r, i) => (
            <div key={i} className="kpi2-drow">
              {r.gapText !== undefined ? <Pill text={r.gapText || "—"} /> : <DeltaPill value={r.deltaVal} lowerBetter={r.lowerBetter} />}
              <span className="kpi2-drow-lbl">{r.label}</span>
            </div>
          ))}
        </div>
      )}
    </Rise>
  );
}

function GaugeCard({ index, achievement, loading }) {
  return (
    <Rise index={index} className="card kpi2 kpi-gaugecard">
      <span className="uplabel">Target Achievement</span>
      {loading ? <Skeleton w={70} h={70} style={{ borderRadius: "50%", margin: "2px auto" }} /> : <EChart height={132} option={gaugeOption({ value: achievement })} />}
    </Rise>
  );
}

/* Which landing queries each view actually renders. Fetching only these
   cuts the CEO/GM view from 9 parallel Power BI queries down to 5, and Area
   from 9 to 7 — the rest were wasted round-trips. (landing_branches was dead:
   its result was never read.) */
const VIEW_QUERIES = {
  ceo:  ["landing_head", "landing_achievement", "landing_ops", "landing_hourly", "landing_brand_matrix", "landing_channel_matrix", "landing_story"],
  gm:   ["landing_head", "landing_achievement", "landing_ops", "landing_hourly", "landing_brand_matrix", "landing_channel_matrix", "landing_story"],
  area: ["landing_head", "landing_ops", "landing_ops_branches", "landing_channel_matrix", "landing_story", "landing_branch_matrix", "landing_ops_matrix"],
  ops:  ["landing_ops", "landing_ops_branches", "landing_brand_matrix"],
};
const QUERY_OMIT = {
  landing_ops_branches: "location", landing_brand_matrix: "brand", landing_channel_matrix: "channel",
  landing_branch_matrix: "location", landing_ops_matrix: "location",
};

/* =============================== page =============================== */
export default function LandingPage({ sel, resolved, role = "gm", brand: gbrand = "all", view = "ceo", asRole, refreshKey = 0, userName = "", source = "all", onOpenPage }) {
  const reduce = useReducedMotion();
  const comps = useMemo(() => activeComparisons(resolved), [resolved && resolved.start, resolved && resolved.end]);
  const primary = comps[0];
  const [head, setHead] = useState({});
  const [ach, setAch] = useState({});
  const [ops, setOps] = useState({});
  const [opsBranches, setOpsBranches] = useState([]);
  const [brandRaw, setBrandRaw] = useState([]);
  const [channelRaw, setChannelRaw] = useState([]);
  const [branchMxRaw, setBranchMxRaw] = useState([]);
  const [opsMxRaw, setOpsMxRaw] = useState([]);
  const [branches, setBranches] = useState([]);
  const [story, setStory] = useState({});
  const [hourly, setHourly] = useState([]);
  const [extras, setExtras] = useState({});      // admin-added measure columns per viz
  const [allLocations, setAllLocations] = useState([]);
  const [scope, setScope] = useState([]);
  const [xfilter, setXfilter] = useState({ brand: null, channel: null, location: null });
  const [aovT, setAovT] = useState({ months: {} });   // admin-set monthly AOV target overrides
  const [aovBase, setAovBase] = useState({});          // trailing-6-month actual AOV per brand / brand::channel
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/aov-targets", { credentials: "include" }).then((r) => r.json()).then((j) => j && setAovT(j)).catch(() => {});
    fetch("/api/aov-baseline" + (gbrand && gbrand !== "all" ? "?brand=" + encodeURIComponent(gbrand) : ""), { credentials: "include" }).then((r) => r.json()).then((j) => j && setAovBase(j.map || {})).catch(() => {});
  }, [gbrand]);

  const effScope = SCOPE_ROLE(role) ? scope : [];
  const scopeStr = effScope.join("|");
  const xfStr = JSON.stringify(xfilter);
  const bq = (gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "") + (asRole ? "&asRole=" + encodeURIComponent(asRole) : "");
  const srcFilter = source && source !== "all" ? source : null;
  const dataKey = view + "|" + (asRole || "") + "|" + scopeStr + "|" + xfStr + "|" + gbrand + "|" + (srcFilter || "") + "|" + selQuery(sel);
  const fade = reduce ? {} : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.28 } };
  const fill = { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 };

  useEffect(() => { setXfilter({ brand: null, channel: null, location: null }); if (!SCOPE_ROLE(role)) setScope([]); }, [role]);

  // Switching brand: clear the previous brand's data immediately so it never lingers
  // on screen while the new brand's (possibly slow, different-model) queries load.
  useEffect(() => {
    setHead({}); setAch({}); setOps({}); setOpsBranches([]);
    setBrandRaw([]); setChannelRaw([]); setBranchMxRaw([]); setOpsMxRaw([]);
    setStory({}); setHourly([]); setLoading(true);
  }, [gbrand]);

  useEffect(() => {
    if (!SCOPE_ROLE(role)) return;
    let live = true;
    fetchViz("landing_branches", selQuery(sel) + bq).then((r) => live && setAllLocations((r.data || []).map((x) => x.label).filter(Boolean).sort())).catch(() => {});
    return () => { live = false; };
  }, [sel, role, gbrand]);

  useEffect(() => {
    let live = true; setLoading(true);
    const need = VIEW_QUERIES[view] || VIEW_QUERIES.ceo;
    const xfEff = { ...xfilter, channel: xfilter.channel || srcFilter };   // global Order Source acts as a base channel filter
    const Q = (omit) => buildQ(sel, effScope, xfEff, omit) + bq;
    // paint ONE visual's slice — used both progressively (as each query lands) and by
    // the full apply(). Lets KPIs render the moment landing_head arrives instead of
    // blocking on the slowest of the 7 Power BI queries.
    const setSlice = (n, r) => {
      const d = r && r.data, ex = r && r.extra;
      switch (n) {
        case "landing_head": setHead(d || {}); break;
        case "landing_achievement": setAch(d || {}); break;
        case "landing_ops": setOps(d || {}); break;
        case "landing_ops_branches": setOpsBranches(d || []); setExtras((x) => ({ ...x, landing_ops_branches: ex })); break;
        case "landing_brand_matrix": setBrandRaw(d || []); setExtras((x) => ({ ...x, landing_brand_matrix: ex })); break;
        case "landing_channel_matrix": setChannelRaw(d || []); setExtras((x) => ({ ...x, landing_channel_matrix: ex })); break;
        case "landing_story": setStory(d || {}); break;
        case "landing_hourly": setHourly(d || []); break;
        case "landing_branch_matrix": setBranchMxRaw(d || []); setExtras((x) => ({ ...x, landing_branch_matrix: ex })); break;
        case "landing_ops_matrix": setOpsMxRaw(d || []); break;
        default: break;
      }
    };
    const apply = (m) => { if (!live || !m) return; for (const n of Object.keys(m)) setSlice(n, m[n]); setLoading(false); };
    // Stale-while-revalidate against IndexedDB: if we've seen this exact view before,
    // paint it INSTANTLY (0 network), then refresh in the background. On a cold load,
    // each visual paints as soon as ITS query resolves (KPIs first) — no all-or-nothing wait.
    swr(
      "landing|v2|" + dataKey,
      () => Promise.all(need.map((n) => fetchViz(n, Q(QUERY_OMIT[n] || null))
        .then((r) => { if (live) { setSlice(n, r); if (n === "landing_head") setLoading(false); } return [n, r]; })
        .catch(() => [n, {}]))).then((pairs) => Object.fromEntries(pairs)),
      (data) => apply(data),
    ).catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [dataKey, refreshKey]);

  const achievement = head.target > 0 ? (nnum(head.netSales) / nnum(head.target)) * 100 : 0;
  const brand = useMemo(() => splitEnrich(brandRaw, "brand"), [brandRaw]);
  const channel = useMemo(() => splitEnrich(channelRaw, "source"), [channelRaw]);
  const branchMx = useMemo(() => splitEnrich(branchMxRaw, "location"), [branchMxRaw]);
  const opsMx = useMemo(() => splitEnrich(opsMxRaw, "brand"), [opsMxRaw]);
  const branchRows = useMemo(() => brand.leaves.map((r) => ({ ...r })), [brand]);   // this brand's locations (full cols)
  const opsRows = useMemo(() => opsBranches.map((r) => ({
    ...r, _k: r.label, prepWow: delta(r.prep, r.prep_w), net: nnum(r.net),
  })), [opsBranches]);

  const toggleXf = (dim, val) => setXfilter((x) => ({ ...x, [dim]: x[dim] === val ? null : val }));
  const clearXf = (dim) => setXfilter((x) => ({ ...x, [dim]: null }));
  const chips = ["brand", "channel", "location"].map((d) => xfilter[d] && { dim: d, val: xfilter[d] }).filter(Boolean);

  // ---- Effective AOV target = admin override (this month) ?? trailing-6-month actual.
  const selMonth = useMemo(() => {
    const d = resolved && resolved.end ? new Date(resolved.end) : null;
    const dd = d && !isNaN(d.getTime()) ? d : new Date();
    return `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}`;
  }, [resolved && resolved.end]);
  const aovEff = (b, channel) => {
    const mo = (aovT.months && aovT.months[selMonth]) || {};
    if (channel) { const k = b + "::" + channel; if (mo[k] != null) return mo[k]; if (aovBase[k] != null) return aovBase[k]; }
    if (mo[b] != null) return mo[b];
    return aovBase[b] != null ? aovBase[b] : null;
  };
  // scope-level blended AOV target for the head KPIs (all-brands → sales-weighted blend)
  const effAov = useMemo(() => {
    if (gbrand && gbrand !== "all") return aovEff(gbrand);
    let sumT = 0, sumOrd = 0;
    for (const [b, row] of Object.entries(brand.groupTotals || {})) { const a = aovEff(b), t = nnum(row.target); if (a > 0 && t > 0) { sumT += t; sumOrd += t / a; } }
    return sumOrd > 0 ? sumT / sumOrd : null;
  }, [aovT, aovBase, selMonth, gbrand, brand]);
  // per-row AOV resolvers for the tables (grand rows fall back to the scope blend)
  const brandAovResolver = (r) => (r.brand ? aovEff(r.brand) : effAov);
  const channelAovResolver = (r) => (!r.source ? effAov : (gbrand && gbrand !== "all" ? aovEff(gbrand, r.source) : effAov));
  const gapStr = (ratio) => (ratio == null || !isFinite(ratio) ? undefined : (ratio >= 0 ? "+" : "") + (ratio * 100).toFixed(1) + "%");
  const ordersTargetHead = effAov ? nnum(head.target) / effAov : null;
  const ordersGapText = ordersTargetHead ? gapStr(nnum(head.orders) / ordersTargetHead - 1) : undefined;
  const aovGapText = effAov ? gapStr(nnum(head.aov) / effAov - 1) : undefined;

  /* attention per role */
  const attn = useMemo(() => {
    if (view === "ceo") return { ...attention(Object.values(brand.groupTotals || {}), "brand", "netSales", "target", "netSales_w"), kind: "brand" };
    if (view === "gm") return { ...attention(branchRows, "location", "netSales", "target", "netSales_w"), kind: "location" };
    // ops: worst prep, worst complaints, best improving prep
    const withData = opsRows.filter((r) => has(r.prep));
    const worstPrep = [...withData].sort((a, b) => b.prep - a.prep).slice(0, 3).map((r) => ({ name: r.label, val: minFmt(r.prep), tone: "bad" }));
    const worstComp = [...opsRows.filter((r) => has(r.complaint))].sort((a, b) => b.complaint - a.complaint).slice(0, 3).map((r) => ({ name: r.label, val: pctFmt(r.complaint), tone: "bad" }));
    const improving = [...withData.filter((r) => r.prepWow != null && r.prepWow < 0)].sort((a, b) => a.prepWow - b.prepWow).slice(0, 3).map((r) => ({ name: r.label, val: fmtPct(r.prepWow), tone: "good" }));
    return { kind: "ops", worstPrep, worstComp, improving };
  }, [view, brand, branchRows, opsRows]);

  const attnDim = view === "ceo" ? "brand" : "location";

  /* ---- tables ---- */
  // dynamic column sets: base columns + any admin-added measures, per editable table
  const aovDeps = [comps, aovT, aovBase, selMonth, gbrand, effAov];
  const fullMeasures = useMemo(() => buildFull(comps, brandAovResolver), aovDeps);
  const channelMeasures = useMemo(() => buildChannel(comps, channelAovResolver), aovDeps);
  const brandMeas = useMemo(() => withExtras(fullMeasures, [...Object.values(brand.groupTotals || {}), ...brand.leaves], extras.landing_brand_matrix), [brand, extras, fullMeasures]);
  const channelMeas = useMemo(() => withExtras(channelMeasures, [...Object.values(channel.groupTotals || {}), ...channel.leaves], extras.landing_channel_matrix), [channel, extras, channelMeasures]);
  const branchMeas = useMemo(() => withExtras(fullMeasures, [...Object.values(branchMx.groupTotals || {}), ...branchMx.leaves], extras.landing_branch_matrix), [branchMx, extras, fullMeasures]);

  const brandTable = (
    <Matrix filename="Brand-Performance" rows={brand.leaves} groupTotals={brand.groupTotals} grandTotalRow={brand.grand}
      groupKey="brand" groupLabel="Brand" childKey="location" childLabel="Location" measures={brandMeas}
      onGroupClick={(g) => toggleXf("brand", g)} activeGroup={xfilter.brand} groupMark={(g) => <BrandMark name={g} size={18} />}
      openGroup={gbrand !== "all" ? gbrand : undefined}
      groupInsight={(g) => brand.groupTotals[g]?.insight} />
  );
  const sourceTable = (
    <Matrix filename="Source-Performance" rows={channel.leaves} groupTotals={channel.groupTotals} grandTotalRow={channel.grand}
      groupKey="source" groupLabel="Channel" childKey="location" childLabel="Location" measures={channelMeas}
      onGroupClick={(g) => toggleXf("channel", g)} activeGroup={xfilter.channel} groupMark={(g) => <ChannelMark name={g} size={18} />} />
  );
  // Area Manager: branches ranked by net, expand to channel breakdown
  const branchMatrixTable = (
    <Matrix filename="Branch-Performance" rows={branchMx.leaves} groupTotals={branchMx.groupTotals} grandTotalRow={branchMx.grand}
      groupKey="location" groupLabel="Branch / Location" childKey="source" childLabel="Channel" measures={branchMeas}
      onGroupClick={(g) => toggleXf("location", g)} activeGroup={xfilter.location} childMark={(r) => <ChannelMark name={r.source} size={16} />} />
  );
  const locCols = [
    { key: "location", label: "Location", align: "l", type: "text", render: (r) => <b>{r.location}</b> },
    ...brandMeas,
  ];
  const locationsTable = (
    <DataGrid title="Locations" filename="Locations" columns={locCols} rows={branchRows}
      defaultSort={{ key: "netSales", dir: "desc" }} onRowClick={(r) => toggleXf("location", r.location)} activeKey={xfilter.location} rowKeyField="location" />
  );
  const opsCols = [
    { key: "label", label: "Location", align: "l", type: "text", render: (r) => <b>{r.label}</b> },
    { key: "brand", label: "Brand", align: "l", type: "text" },
    { key: "prep", label: "Avg Prep", align: "r", type: "num", render: (r) => <span className="num">{minFmt(r.prep)}</span> },
    { key: "delivery", label: "Avg Delivery", align: "r", type: "num", render: (r) => <span className="num">{minFmt(r.delivery)}</span> },
    { key: "complaint", label: "Complaint %", align: "r", type: "num", render: (r) => <span className="num">{pctFmt(r.complaint)}</span> },
    { key: "discount", label: "Discount %", align: "r", type: "num", render: (r) => <span className="num">{pctFmt(r.discount)}</span> },
    { key: "prepWow", label: "Prep WoW", align: "r", type: "num", render: (r) => <DeltaPill value={r.prepWow} lowerBetter /> },
    ...withExtras([], opsRows, extras.landing_ops_branches),
  ];
  const opsTable = (
    <DataGrid title="Operations Performance — worst first" filename="Operations-Performance" columns={opsCols} rows={opsRows}
      defaultSort={{ key: "prep", dir: "desc" }} onRowClick={(r) => toggleXf("location", r.label)} activeKey={xfilter.location} />
  );
  const brandSummaryCols = [
    { key: "netSales", label: "Net Sales", align: "r", type: "kd", total: true },
    { key: "orders", label: "Orders", align: "r", type: "num", total: true },
    { key: "target", label: "Target", align: "r", type: "kd", total: true },
    { key: "gapText", label: "Gap %", align: "r", type: "pct" },
  ];
  const brandSummary = (
    <Matrix filename="Brand-Summary" rows={brand.leaves} groupTotals={brand.groupTotals} grandTotalRow={brand.grand}
      groupKey="brand" groupLabel="Brand" childKey="location" childLabel="Location" measures={brandSummaryCols}
      groupMark={(g) => <BrandMark name={g} size={18} />} />
  );

  const TableCard = ({ children, className = "", viz, style }) => (
    <div className={`card ${className}`} data-viz={viz} style={style}>
      {loading ? <div style={{ padding: 12 }}><Skeleton h={170} /></div> : <motion.div key={dataKey} {...fade} style={fill}>{children}</motion.div>}
    </div>
  );

  // Target / forecast achievement. Only MTD is shown now (actual-to-date vs MTD target).
  const nnn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const pctOf = (a, b) => (nnn(b) ? nnn(a) / nnn(b) : null);
  const achMtd = pctOf(ach.mtdSales, ach.mtdTarget);

  /* ---- KPI rows per role ---- */
  const selLabel = presetLabel(sel);   // "Yesterday" / "This month" / date range — the top picker
  // comparison rows (vs last week / month / year) for a head measure
  const cmpRows = (cur, keyBase, lowerBetter) => comps.map((c) => ({ label: VS_LABEL[c.key] || c.short, deltaVal: delta(cur, head[`${keyBase}_${c.key}`]), lowerBetter }));
  const salesRows = [{ label: "vs target", gapText: head.gapText }, ...cmpRows(head.netSales, "netSales")];
  // SALES card is GREEN when we hit target, RED when short. Key off the SAME "vs target"
  // value the user sees (gapText, e.g. "+7%" / "-15%") so the colour always matches the
  // pill — a minus means below target → red. Fall back to gapKD only when the text is
  // blank (single day with no target text).
  const gapTxt = String(head.gapText ?? "").trim();
  const salesBelow = gapTxt !== "" ? /[-−]/.test(gapTxt) : (has(head.gapKD) ? nnum(head.gapKD) < 0 : false);
  const salesTone = salesBelow ? "neg" : "pos";
  const ordersRows = [{ label: "vs target", gapText: ordersGapText }, ...cmpRows(head.orders, "orders")];
  const aovRows = [{ label: "vs target", gapText: aovGapText }, ...cmpRows(head.aov, "aov")];
  // TOP BAND (big): Sales / Orders / AOV — value + vs target + vs last week/month/year — plus ACC.
  const HeadlineRow = () => (
    <div className="ach-row headline-row hero-kpis" data-viz="landing_head" data-viz-label="Headline KPIs">
      <HeroKpi index={0} label="Sales" value={head.netSales} format={kd} rows={salesRows} loading={loading} live hero tone={salesTone} period={selLabel} />
      <HeroKpi index={1} label="Orders" value={head.orders} format={num} rows={ordersRows} loading={loading} period={selLabel} />
      <HeroKpi index={2} label="AOV" value={head.aov} format={kdc} rows={aovRows} loading={loading} period={selLabel} />
      <AccKpi index={3} label="ACC" text={head.runrateText} loading={loading} />
    </div>
  );
  // SECOND ROW (small): MTD achievement + supporting KPIs.
  const salesKpis = (
    <>
      <AchGauge index={0} label="MTD Achievement" value={achMtd} loading={loading} />
      <Kpi index={1} label="Forecast Closing" value={head.forecastClosing} format={kd} loading={loading} period="This month" />
      <Kpi index={2} label="MTD Sales" value={ach.mtdSales} format={kd} loading={loading} period="Month to date" />
    </>
  );

  const opsHeroKpis = OPS_META.map((o, i) => (
    <Kpi key={o.key} index={i} label={o.label} value={ops[o.key]} format={o.fmt} deltaVal={delta(ops[o.key], ops[`${o.key}_${primary.key}`])} deltaLabel={primary.label} lowerBetter loading={loading} />
  ));
  const opsRowKpis = OPS_META.map((o, i) => (
    <Kpi key={o.key} index={i} label={o.label} value={ops[o.key]} format={o.fmt} deltaVal={delta(ops[o.key], ops[`${o.key}_${primary.key}`])} deltaLabel={primary.label} lowerBetter loading={loading} />
  ));

  const kpiCount = view === "ops" ? 4 : 6;

  /* ---- Needs Attention content ---- */
  const NeedsAttention = () => (
    <Rise index={6} className="card cc-attn" style={{ gridArea: "attn" }}>
      <div className="cc-attn-head">
        <span className="uplabel">Needs Attention</span>
        <div className="cc-attn-tools">
          {SCOPE_ROLE(role) && <ScopePicker options={allLocations} value={scope} onChange={setScope} />}
          {chips.map((c) => <span className="xchip" key={c.dim}>{c.dim}: <b>{c.val}</b><button onClick={() => clearXf(c.dim)}><X size={11} /></button></span>)}
          {chips.length > 1 && <button className="xchip-clear" onClick={() => setXfilter({ brand: null, channel: null, location: null })}>Clear</button>}
        </div>
      </div>
      {loading ? <Skeleton h={26} /> : (
        <motion.div key={dataKey} {...fade} className="cc-attn-pills">
          {attn.kind === "ops" ? (
            <>
              {attn.worstPrep.map((it) => <span key={"p" + it.name} className="attn-pill bad" title="Slowest prep"><b>{it.name}</b><span className="num">{it.val}</span></span>)}
              {attn.worstComp.map((it) => <span key={"c" + it.name} className="attn-pill bad" title="Most complaints"><b>{it.name}</b><span className="num">{it.val}</span></span>)}
              {attn.improving.map((it) => <span key={"i" + it.name} className="attn-pill good" title="Improving prep"><b>{it.name}</b><span className="num">{it.val}</span></span>)}
              {!attn.worstPrep.length && !attn.worstComp.length && <span className="cc-attn-none">All on track</span>}
            </>
          ) : (
            <>
              {attn.problems.map((it) => <AttnPill key={"p" + it.name} it={it} onClick={() => toggleXf(attnDim, it.name)} />)}
              {attn.wins.map((it) => <AttnPill key={"w" + it.name} it={it} onClick={() => toggleXf(attnDim, it.name)} />)}
              {!attn.problems.length && !attn.wins.length && <span className="cc-attn-none">All on track</span>}
            </>
          )}
        </motion.div>
      )}
    </Rise>
  );

  const StoryBox = () => (
    <motion.div className="card cc-story" style={{ gridArea: "story" }} data-viz="landing_story" data-viz-label="Story"
      initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.45, delay: reduce ? 0 : 0.5 }}>
      <span className="cc-story-cap">{presetLabel(sel)}{gbrand !== "all" ? " · " + gbrand : ""}</span>
      {loading ? <Skeleton w="90%" h={40} /> : (
        <motion.div key={dataKey} {...fade}>
          {[story.headline, story.brand, story.outlook].filter(Boolean).slice(0, 3).map((t, i) => <p key={i} className="cc-story-line" title={t}>{t}</p>)}
          {![story.headline, story.brand, story.outlook].some(Boolean) && <p className="cc-story-line muted">No story for this selection.</p>}
        </motion.div>
      )}
    </motion.div>
  );

  // NOTE: no local HourlyCard wrapper — a component declared in this render body gets a
  // fresh identity every render, and React unmounts the whole subtree (state included)
  // when the type changes. HourlyCardView is used directly at each site instead.
  const hourlyProps = { hourly, sel, gbrand, loading };

  const OpsRow = () => (
    <Rise index={7} className="card cc-strip ops-mini" style={{ gridArea: "ops" }} data-viz="landing_ops" data-viz-label="Operations KPIs">
      <span className="cc-ops-tag"><span className="uplabel">Operations</span><span className="cc-ops-hint">lower is better</span></span>
      {OPS_META.map((o, i) => (
        <React.Fragment key={o.key}>
          <div className="cck-div" />
          <div className="cck">
            <span className="uplabel">{o.label}</span>
            {loading ? <Skeleton w="60%" h={18} /> : <span className="cck-val num"><CountUp value={ops[o.key] || 0} format={o.fmt} /></span>}
            {!loading && <span className="cck-delta"><span className="pulse"><DeltaPill value={delta(ops[o.key], ops[`${o.key}_${primary.key}`])} lowerBetter /></span></span>}
          </div>
        </React.Fragment>
      ))}
    </Rise>
  );

  // ---- role-adaptive scorecard below the tables ----
  let roleFill = null;
  if (view === "gm") {
    const rows = [...branchRows].filter((r) => has(r.netSales));
    const ach = (r) => (has(r.target) && nnum(r.target) > 0 ? nnum(r.netSales) / nnum(r.target) : null);
    rows.sort((a, b) => ((ach(a) ?? 9) - (ach(b) ?? 9)));    // worst first
    if (rows.length) roleFill = (
      <RoleFill title="Location Performance Scorecard" sub="ranked worst-first · click to filter">
        <div className="lf-cards lf-loc">{rows.map((r) => { const a = ach(r); return (
          <button key={r.location} className="lf-loccard" onClick={() => toggleXf("location", r.location)}>
            <span className="lf-name">{r.location}</span>
            <span className="lf-metric num">{kd(nnum(r.netSales))}</span>
            <span className={`lf-sub ${a != null && a < 1 ? "bad" : "good"}`}>{a != null ? (a * 100).toFixed(0) + "% of target" : "no target"}</span>
            {a != null && <EChart height={72} option={gaugeOption({ value: Math.min(150, a * 100) })} />}
          </button>); })}</div>
      </RoleFill>);
  } else if (view === "area") {
    // ONE row per branch — use the per-branch subtotals (leaves are per-channel → duplicates)
    const subs = Object.values(branchMx.groupTotals || {});
    const rows = subs.map((b) => {
      const o = opsRows.find((x) => x.label === b.location) || {};
      const score = opsHealthScore(o);
      const net = nnum(b.netSales), tgt = nnum(b.target);
      const gap = tgt > 0 ? (net - tgt) / tgt : null;
      const action = score < 60 ? "Ops health critical" : gap != null && gap < -0.1 ? "Below target"
        : has(o.complaint) && Number(o.complaint) > 0.02 ? "High complaints" : has(o.prep) && Number(o.prep) > 15 ? "Slow prep" : "On track";
      return { branch: b.location, net, tgt, gap, score, action };
    }).filter((r) => r.branch).sort((a, b) => a.score - b.score);   // problem branches first
    if (rows.length) {
      const critical = rows.filter((r) => r.score < 60).length;
      const bestSales = [...rows].sort((a, b) => b.net - a.net)[0];
      const worst = rows[0];
      roleFill = (<>
        <RoleFill title="My Branches — Health Check" sub={`${rows.length} branches · problem-first`}>
          <div className="lf-table">
            <div className="lf-tr lf-th"><span>Branch</span><span className="r">Net Sales</span><span className="r">Target</span><span className="r">Gap %</span><span className="r">Health</span><span>Action Needed</span></div>
            {rows.map((r) => (
              <div key={r.branch} className={`lf-tr ${scoreTone(r.score)}`}>
                <span className="lf-bname">{r.branch}</span>
                <span className="r num">{kd(r.net)}</span>
                <span className="r num">{r.tgt ? kd(r.tgt) : "—"}</span>
                <span className="r num">{r.gap != null ? fmtPct(r.gap) : "—"}</span>
                <span className="r"><span className={`lf-score ${scoreTone(r.score)}`}>{r.score}</span></span>
                <span className="lf-action">{r.action}</span>
              </div>))}
          </div>
        </RoleFill>
        <div className="lf-cards lf-3" style={{ marginTop: 12 }}>
          <div className="lf-card good"><span className="lf-tag">Best Performer</span><span className="lf-name">{bestSales.branch}</span><span className="lf-metric num">{kd(bestSales.net)}</span><span className="lf-sub good">top by net sales</span></div>
          <div className="lf-card bad"><span className="lf-tag">Needs Attention</span><span className="lf-name">{worst.branch}</span><span className="lf-metric num">{worst.score}</span><span className="lf-sub bad">lowest health score</span></div>
          <div className={`lf-card ${critical ? "bad" : "good"}`}><span className="lf-tag">Action Items</span><span className="lf-metric num">{critical}</span><span className={`lf-sub ${critical ? "bad" : "good"}`}>{critical ? "branches below 60" : "all branches healthy"}</span></div>
        </div>
      </>);
    }
  } else if (view === "ops") {
    const cards = [
      { key: "prep", label: "Avg Prep Time", fmt: minFmt, color: "#12B76A" },
      { key: "delivery", label: "Avg Delivery Time", fmt: minFmt, color: "#2E90FA" },
      { key: "complaint", label: "Complaint Rate", fmt: pctFmt, color: "#F04438" },
      { key: "offline", label: "Offline Rate", fmt: pctFmt, color: "#F79009" },
    ];
    roleFill = (
      <RoleFill title="Operational Efficiency" sub="period trend · lower is better">
        <div className="lf-cards lf-eff">{cards.map((c) => (
          <div key={c.key} className="lf-effcard">
            <span className="lf-name">{c.label}</span>
            <span className="lf-metric num" style={{ color: c.color }}>{c.fmt(ops[c.key])}</span>
            {periodSpark(ops, c.key, c.color)}
            <span className="lf-vs"><DeltaPill value={delta(ops[c.key], ops[`${c.key}_${primary.key}`])} lowerBetter /><small>{primary.label}</small></span>
          </div>))}</div>
      </RoleFill>);
  }

  // ---- Area Manager: kitchen operations + sales ----
  if (view === "area") {
    const CG = "#12B76A", CY = "#F79009", CR = "#F04438";
    const prepC = (v) => (v < 10 ? CG : v <= 15 ? CY : CR), delC = (v) => (v < 35 ? CG : v <= 40 ? CY : CR);
    const compC = (v) => (v < 0.01 ? CG : v <= 0.02 ? CY : CR), rateC = (v) => (v > 4 ? CG : v >= 3.5 ? CY : CR);
    const dpct = (p) => (p.value == null ? "—" : (p.value >= 0 ? "▲ " : "▼ ") + (Math.abs(p.value) * 100).toFixed(1) + "%");
    const growth = { "ag-pos": (p) => p.value > 0, "ag-neg": (p) => p.value < 0 };
    const grandNet = nnum(branchMx.grand?.netSales) || Object.values(branchMx.groupTotals || {}).reduce((s, b) => s + nnum(b.netSales), 0);
    const branchPerf = Object.values(branchMx.groupTotals || {}).map((b) => {
      const o = opsRows.find((x) => x.label === b.location) || {};
      const net = nnum(b.netSales), tgt = nnum(b.target);
      const action = nnum(o.prep) > 15 ? "Slow prep" : tgt && net < tgt * 0.9 ? "Below target" : nnum(o.complaint) > 0.02 ? "High complaints" : nnum(o.rating) && nnum(o.rating) < 3.5 ? "Low rating" : "On track";
      return { branch: b.location, prep: nnum(o.prep), prepWow: delta(o.prep, o.prep_w), delivery: nnum(o.delivery), complaint: nnum(o.complaint), rating: nnum(o.rating), orders: nnum(b.orders), net, net_w: b.netSales_w, net_m: b.netSales_m, net_y: b.netSales_y, share: grandNet ? net / grandNet : null, wow: delta(b.netSales, b.netSales_w), mom: delta(b.netSales, b.netSales_m), yoy: delta(b.netSales, b.netSales_y), target: tgt, gap: tgt ? (net - tgt) / tgt : null, action };
    }).filter((r) => r.branch).sort((a, b) => b.prep - a.prep);   // worst prep first

    const nd = (suf) => delta(head.netSales, head[`netSales_${suf}`]);
    const fD = (v) => (v == null ? "—" : (v >= 0 ? "↑" : "↓") + (Math.abs(v) * 100).toFixed(1) + "%");
    const overallGap = nnum(head.target) ? (nnum(head.netSales) - nnum(head.target)) / nnum(head.target) : null;
    const chs = Object.values(channel.groupTotals || {}).filter((c) => nnum(c.netSales) > 0).sort((a, b) => nnum(b.netSales) - nnum(a.netSales));
    const grandCh = chs.reduce((s, c) => s + nnum(c.netSales), 0);
    const chW = (c) => delta(c.netSales, c.netSales_w);
    const topCh = chs[0], declCh = chs.find((c) => { const w = chW(c); return w != null && w < -0.03; }), growCh = chs.find((c) => { const w = chW(c); return w != null && w > 0.03; });
    const worstPrep = branchPerf[0];
    const bestOp = [...branchPerf].filter((r) => r.prep > 0).sort((a, b) => a.prep - b.prep)[0];
    const salesLeader = [...branchPerf].sort((a, b) => b.net - a.net)[0];
    const hiComp = [...branchPerf].filter((r) => r.complaint > 0.015).sort((a, b) => b.complaint - a.complaint)[0];
    const kitchenIns = `Prep time ${minFmt(ops.prep)}${nnum(ops.prep) > 10 ? ` (${(nnum(ops.prep) - 10).toFixed(1)} min over 10 min target)` : ""}. Delivery ${minFmt(ops.delivery)}. Complaints ${pctFmt(ops.complaint)}. Rating ${nnum(ops.rating).toFixed(2)}. Processed ${num(head.orders)} orders.${worstPrep && worstPrep.prep > 10 ? ` Top issue: ${worstPrep.branch} (${minFmt(worstPrep.prep)} prep).` : ""}${hiComp ? ` ${hiComp.branch} complaints high (${pctFmt(hiComp.complaint)}).` : ""}${worstPrep && worstPrep.prep > 10 ? ` Focus: reduce prep in ${worstPrep.branch}${hiComp ? `, investigate quality in ${hiComp.branch}` : ""}.` : ""}`;
    const salesIns = `Total sales ${kd(head.netSales)} (${fD(nd("w"))} WoW).${topCh ? ` ${topCh.source} is ${(nnum(topCh.netSales) / grandCh * 100).toFixed(1)}% of channel sales (${kd(topCh.netSales)})${chW(topCh) != null ? `, ${chW(topCh) < 0 ? "declining" : "growing"} (${fD(chW(topCh))} WoW)` : ""}.` : ""}${declCh && declCh !== topCh ? ` ${declCh.source} declining (${fD(chW(declCh))} WoW).` : ""}${growCh ? ` ${growCh.source} growing (${fD(chW(growCh))} WoW).` : ""}`;
    const connIns = worstPrep && worstPrep.prep > 10
      ? `${worstPrep.branch} kitchen slow (${minFmt(worstPrep.prep)} prep)${worstPrep.gap != null && worstPrep.gap < 0 ? ` AND sales below target (${fD(worstPrep.gap)})` : ""}. Likely correlation: slow kitchen → poorer ratings → lower sales. Fix ${worstPrep.branch} prep time.`
      : "Kitchens are running within target — no prep-driven sales risk detected this period.";

    // compact channel rows (own table so we can trim to 6 columns + a pinned Total)
    const chanRows = chs.map((c) => ({ channel: c.source, net: nnum(c.netSales), share: grandCh ? nnum(c.netSales) / grandCh : null, wow: chW(c), target: nnum(c.target), gap: nnum(c.target) ? (nnum(c.netSales) - nnum(c.target)) / nnum(c.target) : null }));
    const cg = channel.grand || {};
    const chanTotal = [{ channel: "Total", net: grandCh, share: 1, wow: delta(cg.netSales, cg.netSales_w), target: nnum(cg.target), gap: nnum(cg.target) ? (grandCh - nnum(cg.target)) / nnum(cg.target) : null }];
    const compactIns = `Kitchen: prep ${minFmt(ops.prep)}${worstPrep && worstPrep.prep > nnum(ops.prep) ? ` (${worstPrep.branch} highest ${minFmt(worstPrep.prep)})` : ""}. Sales ${fD(nd("w"))} WoW.${declCh ? ` ${declCh.source} channel declining (${fD(chW(declCh))} WoW).` : growCh ? ` ${growCh.source} channel growing (${fD(chW(growCh))} WoW).` : ""}`;

    const alerts = [];
    branchPerf.filter((r) => r.prep > 15).forEach((r) => alerts.push({ tag: "PREP TIME CRITICAL", text: `${r.branch} kitchen ${minFmt(r.prep)} (target 10 min). Action needed.` }));
    branchPerf.filter((r) => r.complaint > 0.02).forEach((r) => alerts.push({ tag: "COMPLAINTS HIGH", text: `${r.branch} ${pctFmt(r.complaint)} (target <1%). Investigate quality.` }));
    branchPerf.filter((r) => r.rating && r.rating < 3.5).forEach((r) => alerts.push({ tag: "LOW RATING", text: `${r.branch} rating ${r.rating.toFixed(2)} (target >4.0).` }));
    if (declCh) alerts.push({ tag: "SALES ALERT", text: `${declCh.source} channel declining (${fD(chW(declCh))} WoW)${nnum(declCh.target) && nnum(declCh.netSales) < nnum(declCh.target) ? " and below target" : ""}.` });
    if (overallGap != null && overallGap < -0.05) alerts.push({ tag: "SALES ALERT", text: `Overall sales ${(overallGap * 100).toFixed(0)}% below target.` });

    const opCell = (fn) => (p) => ({ color: p.value ? fn(p.value) : undefined, fontWeight: 700 });
    const OP_COLS = [
      { headerName: "Branch", field: "branch", pinned: "left", minWidth: 130, flex: 1 },
      { headerName: "Prep Time", field: "prep", type: "rightAligned", minWidth: 135, cellStyle: opCell(prepC), valueFormatter: (p) => minFmt(p.value) + (p.data.prepWow != null ? (p.data.prepWow >= 0 ? "  ⬆︎" : "  ⬇︎") + (Math.abs(p.data.prepWow) * 100).toFixed(1) + "%" : "") },
      { headerName: "Delivery Time", field: "delivery", type: "rightAligned", minWidth: 110, cellStyle: opCell(delC), valueFormatter: (p) => minFmt(p.value) },
      { headerName: "Complaint Ratio", field: "complaint", type: "rightAligned", minWidth: 120, cellStyle: opCell(compC), valueFormatter: (p) => pctFmt(p.value) },
      { headerName: "Rating", field: "rating", type: "rightAligned", minWidth: 85, cellStyle: opCell(rateC), valueFormatter: (p) => (p.value ? nnum(p.value).toFixed(2) : "—") },
      { headerName: "Orders", field: "orders", type: "rightAligned", minWidth: 90, valueFormatter: (p) => num(p.value) },
    ];
    const salesCols = (nameHdr, nameField) => [
      { headerName: nameHdr, field: nameField, pinned: "left", minWidth: 110, flex: 1 },
      { headerName: "Net Sales", field: "net", type: "rightAligned", minWidth: 92, valueFormatter: (p) => kd(p.value) },
      { headerName: "Share %", field: "share", type: "rightAligned", minWidth: 72, valueFormatter: (p) => (p.value != null ? (p.value * 100).toFixed(1) + "%" : "—") },
      { headerName: "WoW", field: "wow", type: "rightAligned", minWidth: 74, valueFormatter: dpct, cellClassRules: growth },
      { headerName: "Target", field: "target", type: "rightAligned", minWidth: 88, valueFormatter: (p) => (p.value ? kd(p.value) : "—") },
      { headerName: "Gap %", field: "gap", type: "rightAligned", minWidth: 74, valueFormatter: dpct, cellClassRules: growth },
    ];
    const SALES_COLS = salesCols("Branch", "branch");
    const CHAN_COLS = salesCols("Channel", "channel");

    const insCards = [
      bestOp && { tag: "Best Operational", tone: "good", name: bestOp.branch, metric: minFmt(bestOp.prep), sub: `rating ${bestOp.rating ? bestOp.rating.toFixed(2) : "—"}`, delta: bestOp.prepWow, lower: true, row: bestOp },
      worstPrep && { tag: "Needs Attention", tone: "bad", name: worstPrep.branch, metric: minFmt(worstPrep.prep), sub: "highest prep time", delta: worstPrep.prepWow, lower: true, row: worstPrep },
      salesLeader && { tag: "Sales Leader", tone: "good", name: salesLeader.branch, metric: kd(salesLeader.net), sub: `${salesLeader.share != null ? (salesLeader.share * 100).toFixed(1) + "% of sales" : ""}`, delta: salesLeader.wow, lower: false, row: salesLeader },
    ].filter(Boolean);

    // operational measures rendered by the CEO Matrix (identical column widths / styling)
    const opsMeasures = [
      { key: "prep", label: "Prep", align: "r", render: (r) => { const pw = delta(r.prep, r.prep_w); return <span className="num" style={{ color: prepC(nnum(r.prep)), fontWeight: 700 }}>{minFmt(r.prep)}{pw != null ? ` ${pw >= 0 ? "⬆" : "⬇"}${(Math.abs(pw) * 100).toFixed(1)}%` : ""}</span>; } },
      { key: "delivery", label: "Delivery", align: "r", render: (r) => <span className="num" style={{ color: delC(nnum(r.delivery)), fontWeight: 700 }}>{minFmt(r.delivery)}</span> },
      { key: "complaint", label: "Complaint", align: "r", render: (r) => <span className="num" style={{ color: compC(nnum(r.complaint)), fontWeight: 700 }}>{pctFmt(r.complaint)}</span> },
      { key: "rating", label: "Rating", align: "r", render: (r) => <span className="num" style={{ color: r.rating ? rateC(nnum(r.rating)) : undefined, fontWeight: 700 }}>{r.rating ? nnum(r.rating).toFixed(2) : "—"}</span> },
      { key: "orders", label: "Orders", align: "r", type: "num" },
    ];
    // trimmed sales columns for the compact area grid (no MoM/YoY/Runrate)
    const areaBranchMeas = [
      { key: "netSales", label: "Net Sales", align: "r", type: "kd", total: true },
      { key: "share", label: "Share %", align: "r", render: shareCell },
      { key: "wow", label: "WoW", term: "wow", align: "r", render: (r) => <DeltaPill value={r.wow} termKey="wow" current={r.netSales} base={r.netSales_w} curLabel="This period" baseLabel="Same day last week" fmt={kd} /> },
      { key: "target", label: "Target", align: "r", type: "kd", total: true },
      { key: "gapText", label: "Gap %", align: "r", type: "pct" },
      { key: "orders", label: "Orders", align: "r", type: "num", total: true },
      { key: "aov", label: "AOV", align: "r", type: "kdc" },
    ];
    const areaSourceMeas = [
      { key: "netSales", label: "Net Sales", align: "r", type: "kd", total: true },
      { key: "share", label: "Share %", align: "r", render: shareCell },
      { key: "wow", label: "WoW", term: "wow", align: "r", render: (r) => <DeltaPill value={r.wow} termKey="wow" current={r.netSales} base={r.netSales_w} curLabel="This period" baseLabel="Same day last week" fmt={kd} /> },
      { key: "target", label: "Target", align: "r", type: "kd", total: true },
      { key: "gapText", label: "Gap %", align: "r", type: "pct" },
    ];

    return (
      <div className={cls("cc area-page", loading)}>
        <UpdatingBar show={loading} brand={gbrand} />
        <div className="area-kpis">
          <Kpi index={0} label="Avg Prep Time" value={ops.prep} format={minFmt} deltaVal={delta(ops.prep, ops[`prep_${primary.key}`])} deltaLabel={primary.label} lowerBetter loading={loading} />
          <Kpi index={1} label="Avg Delivery Time" value={ops.delivery} format={minFmt} deltaVal={delta(ops.delivery, ops[`delivery_${primary.key}`])} deltaLabel={primary.label} lowerBetter loading={loading} />
          <Kpi index={2} label="Complaint Ratio" value={ops.complaint} format={pctFmt} deltaVal={delta(ops.complaint, ops[`complaint_${primary.key}`])} deltaLabel={primary.label} lowerBetter loading={loading} />
          <Kpi index={3} label="Avg Rating" value={ops.rating} format={(v) => nnum(v).toFixed(2)} deltaVal={delta(ops.rating, ops[`rating_${primary.key}`])} deltaLabel={primary.label} loading={loading} />
          <Kpi index={4} label="Total Orders" value={head.orders} format={num} deltaVal={delta(head.orders, head[`orders_${primary.key}`])} deltaLabel={primary.label} loading={loading} />
          <Kpi index={5} label="Total Sales" value={head.netSales} format={kd} deltaVal={nd(primary.key)} deltaLabel={primary.label} loading={loading} live />
        </div>

        <div className="card cc-strip ops-mini area-strip">
          <span className="cc-ops-tag"><span className="uplabel">Summary</span><span className="cc-ops-hint">operations + sales</span></span>
          {[
            { label: "Discount / Offer %", val: pctFmt(ops.discount), d: delta(ops.discount, ops[`discount_${primary.key}`]), lower: true },
            { label: "Offline Rate", val: pctFmt(ops.offline), d: delta(ops.offline, ops[`offline_${primary.key}`]), lower: true },
            { label: "Gap to Target", val: head.gapText || "—", d: null },
            { label: "Avg Ticket (AOV)", val: kdc(head.aov), d: delta(head.aov, head[`aov_${primary.key}`]) },
            { label: "Forecast Closing", val: kd(head.forecastClosing), d: delta(head.forecastClosing, head[`forecastClosing_${primary.key}`]) },
          ].map((s) => (
            <React.Fragment key={s.label}>
              <div className="cck-div" />
              <div className="cck"><span className="uplabel">{s.label}</span>
                {loading ? <Skeleton w="60%" h={18} /> : <span className="cck-val num">{s.val}</span>}
                {!loading && s.d != null && <span className="cck-delta"><DeltaPill value={s.d} lowerBetter={s.lower} /></span>}
              </div>
            </React.Fragment>
          ))}
        </div>

        <div className="area-grid2">
          <div className="area-cell">
            <div className="area-h">Operational Performance — worst prep first</div>
            {loading ? <Skeleton h={300} /> : <div className="card area-scrollcard area-optable"><Matrix filename="Operational-Performance" rows={opsMx.leaves} groupTotals={opsMx.groupTotals} grandTotalRow={opsMx.grand}
              groupKey="brand" groupLabel="Brand / Location" childKey="location" childLabel="Location" measures={opsMeasures}
              groupMark={(g) => <BrandMark name={g} size={16} />} openGroup={gbrand !== "all" ? gbrand : undefined} /></div>}
          </div>
          <div className="area-cell">
            <div className="area-h">Branch Performance</div>
            {loading ? <Skeleton h={300} /> : <div className="card area-scrollcard">{branchMatrixTable}</div>}
          </div>
          <div className="area-cell">
            <div className="area-h">Source Performance</div>
            {loading ? <Skeleton h={300} /> : <div className="card area-scrollcard">{sourceTable}</div>}
          </div>
          <div className="area-cell">
            <div className="area-h">Operational Insights</div>
            <div className="area-insstack">{insCards.map((c) => (
              <div key={c.tag} className={`area-mini ${c.tone}`}>
                <span className="area-mini-tag">{c.tag}</span>
                <div className="area-mini-row"><b className="area-mini-name">{c.name}</b><span className="area-mini-val num">{c.metric}</span></div>
                <span className="area-mini-sub"><DeltaPill value={c.delta} lowerBetter={c.lower} />{c.sub ? " · " + c.sub : ""}</span>
              </div>))}</div>
          </div>
        </div>

        <div className="area-hourly">
          <HourlyCardView {...hourlyProps} />
        </div>
      </div>
    );
  }

  // CEO / GM landing = a fully customizable board. Every section (KPIs included) is an
  // iOS-style tile you can drag / resize / remove; layouts save per-user, with Reset → default.
  if (view === "ceo" || view === "gm") {
    const homeWidgets = [
      { id: "headline", title: "Headline KPIs", defaultW: 12, sizes: [12], component: <HeadlineRow /> },
      { id: "kpis", title: "KPI Summary", defaultW: 12, sizes: [8, 12], component: <div className="kpi-row kpi-quad" data-viz="landing_head" data-viz-label="KPI cards">{salesKpis}</div> },
      { id: "story", title: "Yesterday Insight", defaultW: 5, sizes: [4, 5, 6, 12], component: <StoryBox /> },
      { id: "attn", title: "Needs Attention", defaultW: 7, sizes: [7, 12], component: <NeedsAttention /> },
      { id: "ops", title: "Operations KPIs", defaultW: 12, sizes: [12], component: <OpsRow /> },
      { id: "brand", title: "Brand Performance", defaultW: 8, sizes: [6, 8, 12], component: <TableCard viz="landing_brand_matrix">{view === "gm" ? locationsTable : brandTable}</TableCard> },
      { id: "hourly", title: "Hourly Sales", defaultW: 4, sizes: [4, 6, 8], component: <HourlyCardView {...hourlyProps} /> },
      { id: "source", title: "Source Performance", defaultW: 12, sizes: [8, 12], component: <TableCard viz="landing_channel_matrix">{sourceTable}</TableCard> },
    ];
    return (
      <div className={cls("cc cc-home", loading)}>
        <UpdatingBar show={loading} brand={gbrand} />
        <WidgetGrid dash="landing" widgets={homeWidgets} isAdmin={false} role={asRole || role} />
        <PinnedHome sel={sel} brand={gbrand} onOpenPage={onOpenPage} />
      </div>
    );
  }

  return (
    <div className={cls("cc", loading)}>
      <UpdatingBar show={loading} brand={gbrand} />
      <div className={`cc-grid role-${view}`}>
        <div className={`kpi-row${view === "ops" ? "" : " kpi-bento"}`}
          style={{ gridArea: "kpis", ...(view === "ops" ? { gridTemplateColumns: `repeat(${kpiCount}, 1fr)` } : {}) }}
          data-viz={view === "ops" ? "landing_ops" : "landing_head"} data-viz-label="KPI cards">
          {view === "ops" ? opsHeroKpis : salesKpis}
        </div>

        <StoryBox />
        <NeedsAttention />

        {view !== "ops" && <OpsRow />}

        <div className={`cc-tables ${view === "ceo" || view === "gm" ? "tbl-split" : "role-tables"}`} style={{ gridArea: "tables" }}>
          {view === "ceo" && (<><TableCard style={{ gridArea: "brand" }} viz="landing_brand_matrix">{brandTable}</TableCard><HourlyCardView {...hourlyProps} /><TableCard style={{ gridArea: "source" }} viz="landing_channel_matrix">{sourceTable}</TableCard></>)}
          {view === "gm" && (<><TableCard style={{ gridArea: "brand" }} viz="landing_brand_matrix">{locationsTable}</TableCard><HourlyCardView {...hourlyProps} /><TableCard style={{ gridArea: "source" }} viz="landing_channel_matrix">{sourceTable}</TableCard></>)}
          {view === "area" && (<><TableCard className="span2" viz="landing_branch_matrix">{branchMatrixTable}</TableCard><TableCard viz="landing_ops_branches">{opsTable}</TableCard></>)}
          {view === "ops" && (<><TableCard className="span2" viz="landing_ops_branches">{opsTable}</TableCard><TableCard viz="landing_brand_matrix">{brandSummary}</TableCard></>)}
        </div>
      </div>
      {!loading && roleFill}
      <PinnedHome sel={sel} brand={gbrand} onOpenPage={onOpenPage} />
    </div>
  );
}

// live renderers for known vizzes; anything else gets a clean generic live render
const PIN_RENDERERS = Object.fromEntries(HOME_WIDGETS.map((w) => [w.viz, w.Comp]));

function GenericPin({ viz, sel, brand }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true; setData(null);
    const qs = selQuery(sel) + (brand && brand !== "all" ? `&brand=${encodeURIComponent(brand)}` : "");
    fetch(`/api/viz/${viz}?${qs}`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setData(j ? (Array.isArray(j.rows) ? j.rows : (j.row ? j.row : [])) : null); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [viz, sel, brand]);
  if (!data) return <Skeleton h={140} />;
  if (Array.isArray(data)) {
    if (!data.length) return <div className="wgw-empty">No data for this selection.</div>;
    const cols = Object.keys(data[0]);
    const nameCol = cols.find((c) => typeof data[0][c] === "string") || cols[0];
    const numCol = cols.find((c) => typeof data[0][c] === "number");
    // name + one number → a clean ranked bar list (nicer than a raw table)
    if (nameCol && numCol) {
      const top = [...data].filter((r) => r[nameCol]).sort((a, b) => nnum(b[numCol]) - nnum(a[numCol])).slice(0, 8);
      const max = nnum(top[0]?.[numCol]) || 1;
      return <div className="wgw-bars">{top.map((r, i) => (
        <div key={i} className="wgw-bar"><span className="wgw-bar-n">{String(r[nameCol])}</span>
          <span className="wgw-bar-track"><span className="wgw-bar-fill" style={{ width: `${(nnum(r[numCol]) / max) * 100}%` }} /></span>
          <span className="wgw-bar-v">{num(r[numCol])}</span></div>))}</div>;
    }
    const cc = cols.slice(0, 5);
    return <table className="wgw-table"><thead><tr>{cc.map((c) => <th key={c} className={typeof data[0][c] === "number" ? "r" : ""}>{c}</th>)}</tr></thead>
      <tbody>{data.slice(0, 8).map((r, i) => <tr key={i}>{cc.map((c) => <td key={c} className={typeof r[c] === "number" ? "r" : ""}>{typeof r[c] === "number" ? num(r[c]) : String(r[c] ?? "")}</td>)}</tr>)}</tbody></table>;
  }
  const nums = Object.entries(data).filter(([, v]) => typeof v === "number").slice(0, 6);
  if (!nums.length) return <div className="wgw-empty">No data for this selection.</div>;
  return <div className="wgw-kpis">{nums.map(([k, v]) => <div key={k} className="wgw-kpi"><span className="wgw-kpi-l">{k}</span><b className="wgw-kpi-v">{num(v)}</b></div>)}</div>;
}

// A pinned tile renders LIVE for the current top filters (date + brand). Click opens its source page.
function PinTile({ pin, sel, brand, onOpen, onRemove }) {
  const R = PIN_RENDERERS[pin.viz];
  return (
    <div className="card pinned-card" style={{ gridColumn: `span ${pin.col || 12}` }}>
      <div className="pinned-card-h">
        <button className="pinned-open" onClick={() => onOpen(pin)} title={`Open in ${pin.page || "page"}`}><b>{pin.label}</b></button>
        <button className="ic" title="Remove from Home" onClick={() => onRemove(pin)}><X size={13} /></button>
      </div>
      <div className="pinned-card-b">
        {R ? <R sel={sel} brand={brand} /> : <GenericPin viz={pin.viz} sel={sel} brand={brand} />}
      </div>
    </div>
  );
}

// Pinned visuals — live for the top selection, click to open the source page.
function PinnedHome({ sel, brand, onOpenPage }) {
  const [pins, setPins] = useState(null);
  const load = () => fetch("/api/home/pins", { credentials: "include" }).then((r) => r.json()).then((j) => setPins(j.pins || [])).catch(() => setPins([]));
  useEffect(() => { load(); const h = () => load(); window.addEventListener("home-pins-changed", h); return () => window.removeEventListener("home-pins-changed", h); }, []);
  const remove = (pin) => fetch(`/api/home/pins/${encodeURIComponent(pin.key || pin.viz)}`, { method: "DELETE", credentials: "include" }).then(() => load()).catch(() => {});
  const open = (pin) => { if (onOpenPage && pin.page) onOpenPage(pin.page, brand); };
  if (!pins || !pins.length) return null;
  return (
    <div className="pinned-home">
      <div className="pinned-head"><Home size={14} /> Pinned to Home <span>{pins.length}</span></div>
      <div className="pinned-grid">
        {pins.map((p) => <PinTile key={p.key || p.viz} pin={p} sel={sel} brand={brand} onOpen={open} onRemove={remove} />)}
      </div>
    </div>
  );
}

// Hourly sales vs the 4-week hourly average — green above, red below, grey ~on-par.
// MUST live at module scope: when this was declared inside LandingPage's body, every
// parent re-render created a new function identity, so React unmounted/remounted it
// and its `drill` state was wiped — the drill modal closed itself the moment the next
// SWR wave landed.
// Metric = what the bars measure. Each ships its own value column + three benchmark
// columns, all switchable without a refetch.
const HR_METRIC = {
  sales:  { label: "Sales",  valField: "value",  fmt: kd,  benchFields: { yesterday: "yesterday",    lastweek: "lastWeek",    last4: "last4" } },
  orders: { label: "Orders", valField: "orders", fmt: num, benchFields: { yesterday: "ordYesterday", lastweek: "ordLastWeek", last4: "ordLast4" } },
};
// Benchmark = what each bar is compared against.
const HR_BENCH = [
  { mode: "yesterday", label: "Yesterday", tip: "vs same hour yesterday" },
  { mode: "lastweek",  label: "Last week", tip: "vs same day last week" },
  { mode: "last4",     label: "4-wk avg",  tip: "vs 4-week avg" },
];
function HourlyCardView({ hourly, sel, gbrand, loading }) {
  const [drill, setDrill] = useState(null);   // { hour, loc, src, loading }
  const [metric, setMetric] = useState("sales"); // "sales" | "orders"
  const [mode, setMode] = useState("last4");     // "yesterday" | "lastweek" | "last4"
  const M = HR_METRIC[metric];
  const B = HR_BENCH.find((b) => b.mode === mode) || HR_BENCH[2];
  const benchField = M.benchFields[mode];
  const rows = [...hourly].sort((a, b) => Number(a.x) - Number(b.x));
  const fmtHour = (h) => { const n = Number(h) % 24; return `${n % 12 || 12}${n < 12 ? "am" : "pm"}`; };
  const openDrill = (row) => {
    if (!row) return; const hr = row.x;
    setDrill({ hour: hr, metric, loading: true });
    const q = selQuery(sel) + (gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "") + "&hr=" + hr + "&hbench=" + mode + "&hmetric=" + metric;
    Promise.all([
      fetch(`/api/viz/landing_hourly_drill?${q}&hdim=loc`, { credentials: "include" }).then((r) => r.json()).catch(() => ({})),
      fetch(`/api/viz/landing_hourly_drill?${q}&hdim=src`, { credentials: "include" }).then((r) => r.json()).catch(() => ({})),
    ]).then(([lj, sj]) => setDrill({ hour: hr, metric, benchLabel: B.tip, loc: (lj.rows || lj.data || []), src: (sj.rows || sj.data || []) }));
  };
  const data = rows.map((r) => {
    const v = nnum(r[M.valField]), avg = nnum(r[benchField]);
    let color = "var(--line-2)";
    if (avg > 0) { if (v >= avg * 1.05) color = T.pos; else if (v <= avg * 0.95) color = T.red; }
    return { value: v, avg, itemStyle: { color, borderRadius: [5, 5, 0, 0] } };
  });
  const option = {
    grid: { left: 4, right: 8, top: 12, bottom: 18, containLabel: true },
    tooltip: { ...tooltipBase, trigger: "axis", formatter: (ps) => { const d = ps[0].data; const vs = d.avg > 0 ? (d.value - d.avg) / d.avg : null; return `${ps[0].axisValue}<br/><b>${M.fmt(d.value)}${metric === "orders" ? " orders" : ""}</b>${vs != null ? ` · ${vs >= 0 ? "▲" : "▼"} ${Math.abs(vs * 100).toFixed(0)}% ${B.tip}` : ""}`; } },
    xAxis: { type: "category", data: rows.map((r) => fmtHour(r.x)), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 9.5, fontFamily: T.font, interval: 2 } },
    yAxis: { type: "value", splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 9.5, fontFamily: T.font, formatter: kk } },
    series: [{ type: "bar", data, barWidth: "60%" }],
  };
  return (
    <div className="card cc-hourly" style={{ gridArea: "hourly" }} data-viz="landing_hourly" data-viz-label={`Hourly ${M.label}`}>
      <div className="cc-hourly-head">
        <div className="cc-hourly-ttl"><span className="uplabel">Hourly {M.label}</span><span className="cc-hourly-sub">{B.tip} · click an hour to see what drove it</span></div>
        <div className="cc-hr-controls">
          <div className="cc-hr-switch" role="tablist" aria-label="Metric">
            {Object.entries(HR_METRIC).map(([k, o]) => (
              <button key={k} role="tab" aria-selected={metric === k}
                className={`cc-hr-seg ${metric === k ? "on" : ""}`}
                onClick={() => setMetric(k)}>{o.label}</button>
            ))}
          </div>
          <div className="cc-hr-switch" role="tablist" aria-label="Comparison benchmark">
            {HR_BENCH.map((o) => (
              <button key={o.mode} role="tab" aria-selected={mode === o.mode}
                className={`cc-hr-seg ${mode === o.mode ? "on" : ""}`}
                onClick={() => setMode(o.mode)}>{o.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="cc-hourly-chart">
        {loading ? <Skeleton w="100%" h={300} /> : rows.length ? <EChart height={300} option={option} onEvents={{ click: (p) => openDrill(rows[p.dataIndex]) }} /> : <p className="cc-story-line muted">No hourly data.</p>}
      </div>
      {drill && <HourDrillModal drill={drill} fmtHour={fmtHour} onClose={() => setDrill(null)} />}
    </div>
  );
}

// Hourly drill-down: for the clicked hour, which stores / channels drove the gain or drop vs the benchmark.
function HourDrillModal({ drill, fmtHour, onClose }) {
  const fmt = drill.metric === "orders" ? num : kd;   // orders are plain counts, not KD
  const section = (title, rows) => {
    const list = [...(rows || [])].map((r) => ({ ...r, delta: nnum(r.net) - nnum(r.avg) })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8);
    return (
      <div className="hd-col">
        <div className="hd-col-h">{title}</div>
        {list.length ? list.map((r, i) => {
          const tone = r.delta > 1 ? "up" : r.delta < -1 ? "down" : "";
          return (
            <div key={i} className="hd-row">
              <span className="hd-name" title={r.label}>{r.label}</span>
              <span className="hd-net">{fmt(r.net)}</span>
              <span className={`hd-delta ${tone}`}>{r.delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(r.delta))}</span>
            </div>
          );
        }) : <div className="hd-empty">No data.</div>}
      </div>
    );
  };
  // Portal to <body>: this modal is position:fixed but renders inside a .card /
  // widget tile. Any transform OR filter on an ancestor (card hover-lift, the
  // WidgetGrid layout animation, the loading blur) becomes the containing block
  // for fixed positioning and traps the modal inside the tile. The portal makes
  // it immune to whatever the tile is doing.
  return createPortal(
    <>
      <div className="modal-scrim" onClick={onClose} />
      <div className="modal hd-modal">
        <div className="modal-head"><b>{fmtHour(drill.hour)} — what drove it</b><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">
          <p className="hd-hint">Net sales in this hour {drill.benchLabel || "vs 4-week avg"}, per store / channel. <span className="hd-up">▲ green</span> = above benchmark (gain), <span className="hd-down">▼ red</span> = below (drop). Ranked by biggest swing.</p>
          {drill.loading ? <Skeleton h={140} /> : <div className="hd-cols">{section("By Store", drill.loc)}{section("By Channel", drill.src)}</div>}
        </div>
      </div>
    </>,
    document.body
  );
}

function AttnPill({ it, onClick }) {
  const neg = it.impact < 0;
  return (
    <button className={`attn-pill ${neg ? "bad" : "good"}`} onClick={onClick}
      title={`${it.name} · ${neg ? "-" : "+"}${kd(Math.abs(it.impact))} (${fmtPct(it.pct)})`}>
      <b>{it.name}</b><span className="num">{(neg ? "-" : "+") + kd(Math.abs(it.impact))}</span>
    </button>
  );
}

function ScopePicker({ options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const toggle = (loc) => onChange(value.includes(loc) ? value.filter((v) => v !== loc) : [...value, loc]);
  const label = value.length ? `${value.length} branch${value.length > 1 ? "es" : ""}` : "All branches";
  return (
    <div className="scope" ref={ref}>
      <button className="scope-btn" onClick={() => setOpen((o) => !o)}><Filter size={12} /> {label} <ChevronDown size={12} /></button>
      <AnimatePresence>
        {open && (
          <motion.div className="scope-pop" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <div className="scope-actions"><button onClick={() => onChange([])}>All</button><button onClick={() => onChange([...options])}>Select all</button></div>
            <div className="scope-list">
              {options.map((loc) => <label key={loc} className="scope-item"><input type="checkbox" checked={value.includes(loc)} onChange={() => toggle(loc)} />{loc}</label>)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

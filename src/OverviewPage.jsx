import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { X, Store, ChevronDown } from "lucide-react";
import { Card, Rise, EChart, Matrix, multiLineOption, heatOption, treemapOption, scatterOption, barOption, donutOption, groupedBarOption, DataGrid, Pill, CountUp, DeltaPill, Skeleton, ChannelMark, BrandMark, Term } from "./ui.jsx";
import { kd, kdc, kk, num, T, tooltipBase } from "./theme.js";
import { channelColorOf, brandColorOf } from "./logos.js";
import { selQuery, presetLabel, activeComparisons } from "./dates.js";
import { cls, UpdatingBar } from "./Updating.jsx";
import { swr } from "./clientCache.js";

/* ---------------- data helpers ---------------- */
async function fetchViz(name, q) {
  const res = await fetch(`/api/viz/${name}?${q}`);
  if (!res.ok) throw new Error(name);
  const j = await res.json();
  return j.row != null ? j.row : j.rows || [];
}
const nnum = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const has = (v) => v != null && isFinite(Number(v));
const delta = (a, b) => (has(a) && has(b) && Number(b) !== 0) ? (Number(a) - Number(b)) / Number(b) : null;
const fmtPct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
const hourLabel = (h) => String(h).padStart(2, "0") + ":00";
const DAY3 = (d) => (d || "").slice(0, 3);
const isoDay = (s) => String(s || "").slice(0, 10);
const prettyDay = (s) => { const d = isoDay(s); return d ? d.slice(5) : ""; };

function filtersQ(xf, omit) {
  let s = "";
  if (xf.brand && omit !== "brand") s += "&fb=" + encodeURIComponent(xf.brand);
  if (xf.channel && omit !== "channel") s += "&fc=" + encodeURIComponent(xf.channel);
  const locs = Array.isArray(xf.location) ? xf.location : (xf.location ? [xf.location] : []);
  if (locs.length && omit !== "location") s += "&fl=" + encodeURIComponent(locs.join("|"));
  return s;
}
function buildQ(sel, xf, omit) { return selQuery(sel) + filtersQ(xf, omit); }
function addDaysISO(iso, n) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function movingAvg(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k];
    return s / n;
  });
}
function cumulative(arr) { let s = 0; return arr.map((v) => (s += nnum(v))); }
function weekKey(iso) { // ISO-ish year-week from yyyy-mm-dd
  const d = new Date(iso + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + "-W" + String(wk).padStart(2, "0");
}
function groupBy(rows, keyFn, label) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, { key: k, label: label(r, k), net: 0, target: 0, orders: 0 }); const o = m.get(k); o.net += nnum(r.net); o.target += nnum(r.target); o.orders += nnum(r.orders); }
  return [...m.values()];
}

const SECTIONS = [
  { id: "when", n: "1", title: "When", q: "Time patterns — when do we actually sell?" },
  { id: "where", n: "2", title: "Where", q: "Locations — which branches drive the number?" },
  { id: "how", n: "3", title: "How", q: "Channels — where is the mix shifting?" },
  { id: "howmuch", n: "4", title: "How much", q: "Ticket economics — volume vs ticket size" },
  { id: "compare", n: "5", title: "Comparisons", q: "Same day last week vs last month vs last year" },
  { id: "deep", n: "6", title: "Deep dive", q: "Brand × channel × location × day" },
];
const MODE_LABEL = { day: "Day view", period: "Period view", long: "Long-range view" };

/* ---------------- scroll-in wrapper ---------------- */
function InView({ children, reduce, style, className, ...rest }) {
  return (
    <motion.div className={className} style={style} {...rest}
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-8% 0px" }}
      transition={{ duration: 0.4, ease: [0.22, 0.61, 0.36, 1] }}>
      {children}
    </motion.div>
  );
}

function Section({ id, n, title, q, summary, mode, children, reduce }) {
  return (
    <section id={id} className="sa-section">
      <div className="sa-sec-head">
        <span className="sa-sec-n">{n}</span>
        <div>
          <h2 className="sa-sec-title">{title}</h2>
          <p className="sa-sec-q">{q}</p>
        </div>
      </div>
      {summary && (
        <InView reduce={reduce} className="sa-summary">
          <span className="sa-summary-badge">SUMMARY</span>
          <span className="sa-summary-text">{summary}</span>
        </InView>
      )}
      {children}
    </section>
  );
}

function ChartCard({ title, sub, height = 280, loading, empty, children, reduce, wide, ...rest }) {
  return (
    <InView reduce={reduce} className={`card sa-chart ${wide ? "wide" : ""}`} {...rest}>
      <div className="card-head"><span className="card-title">{title}</span>{sub && <span className="uplabel">{sub}</span>}</div>
      {loading ? <Skeleton h={height} /> : empty ? <div className="dt-empty">No data for this selection</div> : children}
    </InView>
  );
}

// Row × Column heatmap for operational planning. Rows are branches (or channels);
// columns are weekdays OR trading hours depending on the selected range — a single
// day has no weekday spread, so it breaks down by hour instead. Cell = the chosen
// metric (Sales / Orders / AOV), shaded within the metric. Totals on the right.
const DAY_ORDER = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = { Sunday: "Sun", Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat" };
const hourLabelH = (h) => { const n = Number(h) % 24; return `${n % 12 || 12}${n < 12 ? "a" : "p"}`; };
// Power-BI-style matrix: TIME as rows, each ENTITY (location / channel) a column
// group. % is computed PER COLUMN (each entity's hours sum to 100%). Shading is
// per-column intensity (its own peak hour = darkest). AOV is optional (Add AOV).
function PivotHeat({ rows, loading, rowKey = "loc", rowLabel = "Branch", byHour = false, title = "Location", compact = false }) {
  const [pct, setPct] = useState(false);
  const [showAov, setShowAov] = useState(false);
  const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const colKey = byHour ? "hour" : "day";
  const clean = (rows || []).filter((r) => r[rowKey] != null && String(r[rowKey]).trim() && r[colKey] != null && String(r[colKey]).trim());
  const entities = [...new Set(clean.map((r) => r[rowKey]))].sort();                    // → column groups
  const timeKeys = byHour
    ? [...new Set(clean.map((r) => Number(r.hour)))].sort((a, b) => a - b)
    : DAY_ORDER.filter((d) => clean.some((r) => r[colKey] === d));                       // → rows
  const timeLabel = byHour ? (t) => hourLabelH(t) : (t) => DAY_ABBR[t] || t;
  const grid = {};
  for (const r of clean) { const t = String(byHour ? Number(r.hour) : r[colKey]); (grid[r[rowKey]] ||= {})[t] = { sales: nn(r.sales), orders: nn(r.orders) }; }
  const aovOf = (c) => (c && c.orders ? c.sales / c.orders : null);
  // per-ENTITY stats: max (for its own column shading) + total (for its % column)
  const stat = {};
  for (const e of entities) {
    let sMax = 0, oMax = 0, aMax = 0, sTot = 0, oTot = 0;
    for (const t of timeKeys) { const c = grid[e]?.[String(t)]; if (!c) continue; sTot += c.sales; oTot += c.orders; if (c.sales > sMax) sMax = c.sales; if (c.orders > oMax) oMax = c.orders; const a = aovOf(c); if (a > aMax) aMax = a; }
    stat[e] = { sMax, oMax, aMax, sTot, oTot };
  }
  const chip = (v, mx, hue) => { if (!mx || v == null || v <= 0) return "transparent"; const t = Math.max(0, Math.min(1, v / mx)); return `color-mix(in srgb, ${hue} ${Math.round(t * 78) + 8}%, transparent)`; };
  const ink = (v, mx) => (mx > 0 && v / mx > 0.58 ? "#fff" : "var(--ink-700)");
  const sTxt = (v, e) => (v == null ? "" : pct ? (stat[e].sTot > 0 ? (v / stat[e].sTot * 100).toFixed(1) + "%" : "") : num(v));
  const oTxt = (v, e) => (v == null ? "" : pct ? (stat[e].oTot > 0 ? (v / stat[e].oTot * 100).toFixed(1) + "%" : "") : num(v));
  const aTxt = (v) => (v == null ? "" : kdc(v));
  const colTitle = byHour ? "Hour" : "Day";
  const span = showAov ? 3 : 2;

  return (
    <div className="ldh">
      <div className="ldh-head">
        <span className="card-title">{title} × {colTitle} — Sales · Orders{showAov ? " · AOV" : ""}{pct ? " (% of column)" : ""}</span>
        <button className={`cc-hr-seg cc-hr-pct ${pct ? "on" : ""}`} title="Toggle % of each column" onClick={() => setPct((p) => !p)}>{pct ? "123" : "%"}</button>
        <button className={`cc-hr-seg ${showAov ? "on" : ""}`} onClick={() => setShowAov((a) => !a)}>{showAov ? "Hide AOV" : "Add AOV"}</button>
        <span className="ldh-legend"><i className="ldh-lg-s" />sales <i className="ldh-lg-o" />orders{showAov && <> <i className="ldh-lg-a" />aov</>}</span>
      </div>
      {loading ? <Skeleton h={260} /> : !entities.length ? <div className="dt-empty">No data for this selection</div> : (
        <div className="ldh-scroll">
          <table className="ldh-table ldh-matrix">
            <thead>
              <tr>
                <th className="ldh-corner" rowSpan={2}>{colTitle}</th>
                {entities.map((e) => <th key={e} className="ldh-ent" colSpan={span} title={e}>{e}</th>)}
              </tr>
              <tr>
                {entities.map((e) => [
                  <th key={e + "s"} className="ldh-sub ldh-gsep">Sales</th>,
                  <th key={e + "o"} className="ldh-sub">Orders</th>,
                  ...(showAov ? [<th key={e + "a"} className="ldh-sub">AOV</th>] : []),
                ])}
              </tr>
            </thead>
            <tbody>
              {timeKeys.map((t) => (
                <tr key={t}>
                  <td className="ldh-loc">{timeLabel(t)}</td>
                  {entities.map((e) => { const c = grid[e]?.[String(t)]; const a = aovOf(c); const st = stat[e]; return [
                    <td key={e + "s"} className="ldh-mc ldh-gsep" style={{ background: chip(c?.sales, st.sMax, "var(--accent)"), color: c ? ink(c.sales, st.sMax) : undefined }}>{c ? sTxt(c.sales, e) : "·"}</td>,
                    <td key={e + "o"} className="ldh-mc" style={{ background: chip(c?.orders, st.oMax, "#2E90FA"), color: c ? ink(c.orders, st.oMax) : undefined }}>{c ? oTxt(c.orders, e) : ""}</td>,
                    ...(showAov ? [<td key={e + "a"} className="ldh-mc ldh-mc-a" style={{ background: chip(a, st.aMax, "#F79009"), color: a != null ? ink(a, st.aMax) : undefined }}>{aTxt(a)}</td>] : []),
                  ]; })}
                </tr>
              ))}
              <tr className="ldh-totrow">
                <td className="ldh-loc">Total</td>
                {entities.map((e) => { const st = stat[e]; const a = st.oTot ? st.sTot / st.oTot : null; return [
                  <td key={e + "s"} className="ldh-mc num ldh-gsep">{sTxt(st.sTot, e)}</td>,
                  <td key={e + "o"} className="ldh-mc num">{oTxt(st.oTot, e)}</td>,
                  ...(showAov ? [<td key={e + "a"} className="ldh-mc num">{aTxt(a)}</td>] : []),
                ]; })}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================ page ================================= */
// multi-select location filter for the Sales Analysis sidebar (checkbox popover)
function LocMultiSelect({ options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const toggle = (l) => { const s = new Set(value); s.has(l) ? s.delete(l) : s.add(l); onChange([...s]); };
  const label = !value.length ? "All locations" : value.length === 1 ? value[0] : `${value.length} locations`;
  return (
    <div className="sa-locms" ref={ref}>
      <button className="ctl sa-locsel" onClick={() => setOpen((o) => !o)} title="Filter locations">
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <ChevronDown size={13} style={{ flex: "none", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open && (
        <div className="sa-locms-pop">
          <button className="sa-locms-opt sa-locms-all" onClick={() => onChange([])}>All locations</button>
          {options.map((l) => (
            <label key={l} className="sa-locms-opt"><input type="checkbox" checked={value.includes(l)} onChange={() => toggle(l)} /><span>{l}</span></label>
          ))}
          {!options.length && <div className="sa-locms-opt" style={{ opacity: .6 }}>No branches</div>}
        </div>
      )}
    </div>
  );
}

export default function OverviewPage({ sel, brand: gbrand = "all", source = "all" }) {
  const reduce = useReducedMotion();
  const [range, setRange] = useState(null);
  const [head, setHead] = useState({});
  const [hourly, setHourly] = useState([]);
  const [profile, setProfile] = useState([]);
  const [daily, setDaily] = useState([]);
  const [heat, setHeat] = useState([]);
  const [branches, setBranches] = useState([]);
  const [locDay, setLocDay] = useState([]);
  const [locHour, setLocHour] = useState([]);
  const [srcHour, setSrcHour] = useState([]);
  const [channels, setChannels] = useState([]);
  const [chSeries, setChSeries] = useState([]);
  const [chHourly, setChHourly] = useState([]);
  const [buckets, setBuckets] = useState([]);
  const [compare, setCompare] = useState({});
  const [cmpDim, setCmpDim] = useState([]);
  const [cmpW, setCmpW] = useState([]);
  const [cmpM, setCmpM] = useState([]);
  const [cmpY, setCmpY] = useState([]);
  const [deepDims, setDeepDims] = useState(["brand", "channel", "location"]);
  const [deep, setDeep] = useState([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const [sections, setSections] = useState({});   // DAX-generated section takeaways
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState("when");
  const [xfilter, setXfilter] = useState({ brand: null, channel: null, location: [] });
  const [overlays, setOverlays] = useState({ lastWeek: true, expected: true });

  const days = range ? Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1 : 1;
  const mode = days <= 1 ? "day" : days <= 35 ? "period" : "long";
  // adaptive comparison set (hides WoW past 7 days, YoY-only past 30, etc.)
  const cmps = useMemo(() => activeComparisons(range), [range && range.start, range && range.end]);
  const showW = cmps.some((c) => c.key === "w"), showM = cmps.some((c) => c.key === "m"), showY = cmps.some((c) => c.key === "y");
  // adaptive delta columns (WoW/MoM/YoY) with a hover tooltip showing the compared window
  const DKEY = { w: "wow", m: "mom", y: "yoy" };
  const cmpDeltaCols = () => cmps.map((c) => ({ key: DKEY[c.key], label: c.short, align: "r", type: "num", tip: `${c.label} — comparing to ${c.rangeText}`, render: (r) => <DeltaPill value={r[DKEY[c.key]]} /> }));
  // orders-growth columns (WoW/MoM/YoY), same shape as the sales delta columns
  const ODKEY = { w: "ordWow", m: "ordMom", y: "ordYoy" };
  const cmpOrdersDeltaCols = () => cmps.map((c) => ({ key: ODKEY[c.key], label: "Ord " + c.short, align: "r", type: "num", tip: `Orders ${c.label} — comparing to ${c.rangeText}`, render: (r) => <DeltaPill value={r[ODKEY[c.key]]} /> }));
  // global Order Source acts as a base channel filter (overridden by an in-page channel click)
  const xfEff = useMemo(() => ({ ...xfilter, channel: xfilter.channel || (source && source !== "all" ? source : null) }), [xfilter, source]);
  const xfStr = JSON.stringify(xfEff);
  const bq = gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "";
  const contentKey = gbrand + "|" + selQuery(sel) + "|" + xfStr;   // drives the crossfade + re-observe
  // brand's branches with sales — options for the in-page Location filter (brand view only)
  const locOptions = useMemo(() => [...new Set(branches.map((b) => b.label).filter(Boolean))].sort(), [branches]);
  useEffect(() => { setXfilter((x) => ((x.location && x.location.length) ? { ...x, location: [] } : x)); }, [gbrand]);

  useEffect(() => { fetch(`/api/range?${selQuery(sel)}`).then((r) => r.json()).then(setRange).catch(() => {}); }, [sel]);

  useEffect(() => {
    let live = true; setLoading(true);
    const q = buildQ(sel, xfEff) + bq;                  // time/KPI: all filters apply
    const qLoc = buildQ(sel, xfEff, "location") + bq;   // branch tables omit their own dim
    const qCh = buildQ(sel, xfEff, "channel") + bq;     // channel table omits its own dim
    const qDim = buildQ(sel, xfEff, gbrand === "all" ? "brand" : "location") + bq; // compare table omits its own dim
    // single-day selection → break branches down by hour, not weekday
    const isDayMode = !!sel && (sel.preset === "today" || sel.preset === "yesterday" || (sel.preset === "custom" && sel.start && sel.start === sel.end));
    const apply = (a) => {
      if (!live || !a) return;
      const [h, hr, pr, dl, hm, br, ch, cs, chh, bk, cmp, cd, secs, ld, lh, sh] = a;
      setHead(h || {}); setHourly(hr || []); setProfile(pr || []); setDaily(dl || []); setHeat(hm || []); setBranches(br || []);
      setChannels(ch || []); setChSeries(cs || []); setChHourly(chh || []); setBuckets(bk || []); setSections(secs || {});
      setCompare(cmp || {}); setCmpDim(cd || []); setLocDay(ld || []); setLocHour(lh || []); setSrcHour(sh || []);
      setLoading(false);
    };
    // instant paint from IndexedDB, then background revalidate
    swr(
      "overview|" + gbrand + "|" + selQuery(sel) + "|" + xfStr,
      () => Promise.all([
        fetchViz("landing_head", q), fetchViz("ov_hourly", q), fetchViz("ov_profile", q),
        fetchViz("ov_daily", q), fetchViz("ov_heatmap", q), fetchViz("ov_branches", qLoc),
        fetchViz("ov_channels", qCh), fetchViz("ov_channel_series", q), fetchViz("ov_channel_hourly", q),
        fetchViz("ov_buckets", q), fetchViz("ov_compare", q), fetchViz("ov_compare_dim", qDim),
        fetchViz("ov_sections", q), fetchViz("ov_loc_day", qLoc),
        isDayMode ? fetchViz("ov_loc_hour", qLoc) : Promise.resolve([]),
        fetchViz("ov_src_hour", qCh),
      ]),
      (a) => apply(a),
    ).catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [sel, xfStr, gbrand]);

  // Section 5 overlay — weekday-aligned WoW/MoM/YoY daily series (aligned by day index).
  useEffect(() => {
    if (!range) { setCmpW([]); setCmpM([]); setCmpY([]); return; }
    let live = true;
    const fq = filtersQ(xfEff) + bq;
    const shifted = (n) => `start=${addDaysISO(range.start, n)}&end=${addDaysISO(range.end, n)}${fq}`;
    Promise.all([
      fetchViz("ov_daily", shifted(-7)), fetchViz("ov_daily", shifted(-28)), fetchViz("ov_daily", shifted(-364)),
    ]).then(([w, m, y]) => { if (live) { setCmpW(w || []); setCmpM(m || []); setCmpY(y || []); } }).catch(() => {});
    return () => { live = false; };
  }, [range?.start, range?.end, xfStr, gbrand]);

  // Section 6 deep-dive — refetch when the chosen dimensions change.
  useEffect(() => {
    let live = true; setDeepLoading(true);
    const q = buildQ(sel, xfilter) + bq + "&dims=" + deepDims.join(",");
    fetchViz("ov_deepdive", q).then((rows) => { if (live) { setDeep(rows || []); setDeepLoading(false); } })
      .catch(() => live && setDeepLoading(false));
    return () => { live = false; };
  }, [sel, xfStr, gbrand, deepDims]);

  // active-section highlight (re-attach after crossfade re-mounts the sections)
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: "-45% 0px -50% 0px" });
    SECTIONS.forEach((s) => { const el = document.getElementById(s.id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [contentKey]);

  const goTo = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); };
  const clearXf = (dim) => setXfilter((x) => ({ ...x, [dim]: dim === "location" ? [] : null }));
  const locArr = (x) => (Array.isArray(x.location) ? x.location : (x.location ? [x.location] : []));
  const setLoc = (name) => { if (!name) return; setXfilter((x) => { const a = locArr(x); return { ...x, location: a.includes(name) ? a.filter((l) => l !== name) : [...a, name] }; }); };
  const activeLoc = xfilter.location && xfilter.location.length === 1 ? xfilter.location[0] : null;   // single-select highlight only
  const chips = ["brand", "channel", "location"].map((d) => {
    const val = xfilter[d];
    if (!val || (Array.isArray(val) && !val.length)) return null;
    return { d, v: Array.isArray(val) ? (val.length === 1 ? val[0] : `${val.length} locations`) : val };
  }).filter(Boolean);

  /* ---- Section 2: WHERE — branch data (respects the global brand hierarchy) ---- */
  const allBrands = gbrand === "all";
  const setBrandXf = (name) => { if (name) setXfilter((x) => ({ ...x, brand: x.brand === name ? null : name })); };
  const branchTotal = useMemo(() => branches.reduce((s, b) => s + nnum(b.net), 0) || 1, [branches]);
  // colour palette per brand (for brand-coloured treemap/scatter at All Brands)
  const brandColor = useMemo(() => {
    const names = [...new Set(branches.map((b) => b.brand).filter(Boolean))];
    const m = {}; names.forEach((n) => { m[n] = brandColorOf(n); }); return m;
  }, [branches]);
  const branchRows = useMemo(() => branches.map((b) => ({
    ...b, _k: (b.brand || "") + "|" + b.label,
    gapPct: b.target > 0 ? (nnum(b.net) - nnum(b.target)) / nnum(b.target) : null,
    ach: b.target > 0 ? nnum(b.net) / nnum(b.target) : null,
    wow: delta(b.net, b.net_w), mom: delta(b.net, b.net_m), yoy: delta(b.net, b.net_y), pct: nnum(b.net) / branchTotal,
    ordWow: delta(b.orders, b.orders_w), ordMom: delta(b.orders, b.orders_m), ordYoy: delta(b.orders, b.orders_y),
  })), [branches, branchTotal]);
  // brand-level subtotals for the All-Brands drill-down matrix
  const brandGroups = useMemo(() => {
    const by = {}; branchRows.forEach((r) => { (by[r.brand] = by[r.brand] || []).push(r); });
    const gt = {}; let gNet = 0, gNetW = 0, gNetM = 0, gNetY = 0, gTgt = 0, gOrd = 0, gOrdW = 0, gOrdM = 0, gOrdY = 0;
    const sum = (items, k) => items.reduce((s, r) => s + nnum(r[k]), 0);
    Object.entries(by).forEach(([bn, items]) => {
      const net = sum(items, "net"), netw = sum(items, "net_w"), netm = sum(items, "net_m"), nety = sum(items, "net_y");
      const tgt = sum(items, "target"), ord = sum(items, "orders"), ordw = sum(items, "orders_w"), ordm = sum(items, "orders_m"), ordy = sum(items, "orders_y");
      gt[bn] = { brand: bn, net, target: tgt, orders: ord, aov: ord ? net / ord : null, wow: delta(net, netw), mom: delta(net, netm), yoy: delta(net, nety), ordWow: delta(ord, ordw), ordMom: delta(ord, ordm), ordYoy: delta(ord, ordy), gapPct: tgt ? (net - tgt) / tgt : null };
      gNet += net; gNetW += netw; gNetM += netm; gNetY += nety; gTgt += tgt; gOrd += ord; gOrdW += ordw; gOrdM += ordm; gOrdY += ordy;
    });
    const grand = { net: gNet, target: gTgt, orders: gOrd, aov: gOrd ? gNet / gOrd : null, wow: delta(gNet, gNetW), mom: delta(gNet, gNetM), yoy: delta(gNet, gNetY), ordWow: delta(gOrd, gOrdW), ordMom: delta(gOrd, gOrdM), ordYoy: delta(gOrd, gOrdY), gapPct: gTgt ? (gNet - gTgt) / gTgt : null };
    return { groupTotals: gt, grand };
  }, [branchRows]);
  // At All Brands, aggregate to BRAND level (a single branch means nothing across brands);
  // when one brand is scoped, show its individual branches.
  const treeData = useMemo(() => allBrands
    ? Object.values(brandGroups.groupTotals).map((g) => ({ name: g.brand, value: nnum(g.net), color: brandColor[g.brand] }))
    : branchRows.map((b) => ({ name: b.label, value: nnum(b.net), pct: b.pct })), [allBrands, brandGroups, branchRows, brandColor]);
  const scatterPts = useMemo(() => allBrands
    ? Object.values(brandGroups.groupTotals).map((g) => ({ name: g.brand, x: nnum(g.orders), y: nnum(g.aov), size: nnum(g.net), color: brandColor[g.brand] }))
    : branchRows.map((b) => ({
        name: b.label, x: nnum(b.orders), y: nnum(b.aov), size: nnum(b.net),
        color: b.ach == null ? T.green : b.ach >= 1 ? T.green : b.ach >= 0.85 ? "#F79009" : T.red,
      })), [allBrands, brandGroups, branchRows, brandColor]);
  const whereSummary = (() => {
    if (loading || !branchRows.length) return "";
    const below = branchRows.filter((b) => b.ach != null && b.ach < 1).length;
    if (allBrands) {
      const topBrand = Object.values(brandGroups.groupTotals).sort((a, b) => b.net - a.net)[0];
      const nB = Object.keys(brandGroups.groupTotals).length;
      return `Across ${nB} brands, ${topBrand?.brand} leads with ${kd(topBrand?.net)}; ${below} of ${branchRows.length} branches are below target — expand a brand to drill into its branches.`;
    }
    const top = [...branchRows].sort((a, b) => b.net - a.net)[0];
    return `${gbrand} — ${top.label} leads with ${kd(top.net)} (${(top.pct * 100).toFixed(0)}% of ${gbrand}); ${below} of ${branchRows.length} ${gbrand} branches are below target.`;
  })();
  const branchMeasures = [
    { key: "net", label: "Net Sales", align: "r", type: "kd", total: true },
    ...cmpDeltaCols(),
    { key: "target", label: "Target", align: "r", type: "kd", total: true },
    { key: "gapPct", label: "Gap %", align: "r", render: (r) => (r.gapPct != null ? <Pill value={r.gapPct} /> : "—") },
    { key: "orders", label: "Orders", align: "r", type: "num", total: true },
    ...cmpOrdersDeltaCols(),
    { key: "aov", label: "AOV", align: "r", type: "kdc" },
  ];
  const branchCols = [
    { key: "label", label: "Location", align: "l", type: "text" },
    { key: "net", label: "Net Sales", align: "r", type: "kd" },
    { key: "target", label: "Target", align: "r", type: "kd" },
    { key: "gapPct", label: "Gap %", align: "r", type: "num", render: (r) => (r.gapPct != null ? <Pill value={r.gapPct} /> : "—") },
    ...cmpDeltaCols(),
    { key: "orders", label: "Orders", align: "r", type: "num" },
    ...cmpOrdersDeltaCols(),
    { key: "aov", label: "AOV", align: "r", type: "kdc" },
  ];

  /* ---- derived series ---- */
  const dailyRows = useMemo(() => daily.map((r) => ({ x: isoDay(r.x), net: nnum(r.net), target: nnum(r.target), orders: nnum(r.orders), lw: nnum(r.lw), lm: nnum(r.lm), avg4: nnum(r.avg4) })).filter((r) => r.x), [daily]);
  const weekly = useMemo(() => groupBy(dailyRows, (r) => weekKey(r.x), (_, k) => k.replace(/^\d+-/, "")), [dailyRows]);
  const monthly = useMemo(() => groupBy(dailyRows, (r) => r.x.slice(0, 7), (_, k) => k), [dailyRows]);

  // hourly hero (day mode)
  const hourOpt = useMemo(() => {
    const x = hourly.map((r) => hourLabel(r.x));
    const series = [{ name: "Sales", data: hourly.map((r) => nnum(r.value)), color: T.green, area: true }];
    if (overlays.lastWeek) series.push({ name: "Same day last week", data: hourly.map((r) => (has(r.lastWeek) ? Number(r.lastWeek) : null)), color: T.blue, dashed: true });
    if (overlays.expected) series.push({ name: "Expected (4-wk avg)", data: hourly.map((r) => (has(r.last4) ? Number(r.last4) : null)), color: "#98A2B3", dashed: true });
    return multiLineOption({ x, series, fmt: kd });
  }, [hourly, overlays]);

  // average-day profile (period/long) with prior-period ghost
  const profileOpt = useMemo(() => {
    const dc = Math.max(1, days), pc = Math.max(1, days);
    const x = profile.map((r) => hourLabel(r.x));
    return multiLineOption({
      x, fmt: kd, series: [
        { name: "This period (avg/day)", data: profile.map((r) => nnum(r.cur) / dc), color: T.green, area: true },
        { name: "Prior period (avg/day)", data: profile.map((r) => nnum(r.prev) / pc), color: "#B0B7C3", dashed: true },
      ],
    });
  }, [profile, days]);

  // daily / weekly sales trend. No moving average — just the actual line, with a
  // y-axis that scales to the data (not anchored at 0) so day-to-day movement is
  // readable, and a hover that shows the value + % change vs the previous point.
  const trendOpt = useMemo(() => {
    const src = mode === "long" ? weekly : dailyRows;
    const x = src.map((r) => (mode === "long" ? r.label : prettyDay(r.x)));
    const net = src.map((r) => nnum(r.net));
    const series = [{ name: mode === "long" ? "Weekly sales" : "Daily sales", data: net, color: T.green, area: true }];
    // period view: keep the reference benchmarks (dashed), just no moving average
    if (mode !== "long") {
      const has = (k) => dailyRows.some((r) => nnum(r[k]) > 0);
      if (has("avg4")) series.push({ name: "4-weekday avg", data: dailyRows.map((r) => nnum(r.avg4) || null), color: "#98A2B3", width: 1.8, dashed: true });
      if (has("lw")) series.push({ name: "Same day last week", data: dailyRows.map((r) => nnum(r.lw) || null), color: T.blue, width: 1.8, dashed: true });
    }
    const o = multiLineOption({ x, fmt: kd, series });
    // scale the axis to the data so the trend isn't a flat line hugging the top
    o.yAxis = { ...o.yAxis, scale: true, min: (v) => Math.max(0, v.min - (v.max - v.min) * 0.15) };
    // marker dot + % change vs the previous point on hover (the screenshot UX)
    o.tooltip = {
      ...o.tooltip, trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: T.accent, width: 1, type: "dashed" }, z: 0 },
      formatter: (ps) => {
        const p = ps.find((s) => /sales/i.test(s.seriesName)) || ps[0];
        const i = p.dataIndex; const cur = nnum(net[i]); const prev = i > 0 ? nnum(net[i - 1]) : null;
        const chg = prev ? (cur - prev) / prev : null;
        const arrow = chg == null ? "" : chg >= 0 ? "▲" : "▼";
        const chgTxt = chg == null ? "" : ` <b style="color:${chg >= 0 ? T.pos : T.red}">${arrow} ${(Math.abs(chg) * 100).toFixed(1)}%</b>`;
        const others = ps.filter((s) => s !== p && s.value != null)
          .map((s) => `<div style="color:var(--muted)">${s.marker} ${s.seriesName}: ${kd(s.value)}</div>`).join("");
        return `<div style="font-weight:700;margin-bottom:2px">${p.axisValue}</div><div>${p.marker} <b>${kd(cur)}</b>${chgTxt}</div>${others}`;
      },
    };
    // show the point marker only on the hovered node
    o.series = o.series.map((s, idx) => idx === 0 ? { ...s, showSymbol: false, symbolSize: 8, emphasis: { focus: "series", itemStyle: { borderWidth: 3 } } } : s);
    return o;
  }, [dailyRows, weekly, mode]);

  // monthly progression (long)
  const monthOpt = useMemo(() => multiLineOption({
    x: monthly.map((r) => r.label), fmt: kd,
    series: [{ name: "Monthly sales", data: monthly.map((r) => r.net), color: T.green, area: true },
    { name: "Target", data: monthly.map((r) => r.target), color: "#F79009", dashed: true }],
  }), [monthly]);

  // cumulative pace vs target
  const paceOpt = useMemo(() => {
    const src = mode === "long" ? weekly : dailyRows;
    const x = src.map((r) => (mode === "long" ? r.label : prettyDay(r.x)));
    return multiLineOption({
      x, fmt: kd, series: [
        { name: "Cumulative sales", data: cumulative(src.map((r) => r.net)), color: T.green, area: true },
        { name: "Cumulative target", data: cumulative(src.map((r) => r.target)), color: "#F79009", dashed: true },
      ],
    });
  }, [dailyRows, weekly, mode]);

  // heatmap
  const heatData = useMemo(() => heat.map((r) => ({ row: hourLabel(r.row), col: DAY3(r.col), value: nnum(r.value), wd: r.wd })).filter((r) => r.col), [heat]);

  /* ---- Section 3: HOW — channels ---- */
  const setChannelXf = (name) => { if (name) setXfilter((x) => ({ ...x, channel: x.channel === name ? null : name })); };
  const chTotal = useMemo(() => channels.reduce((s, c) => s + nnum(c.net), 0) || 1, [channels]);
  const chColor = useMemo(() => { const m = {}; channels.forEach((c) => { m[c.label] = channelColorOf(c.label); }); return m; }, [channels]);
  const chRows = useMemo(() => channels.map((c) => ({
    ...c, _k: c.label, share: nnum(c.net) / chTotal,
    wow: delta(c.net, c.net_w), mom: delta(c.net, c.net_m), yoy: delta(c.net, c.net_y),
    ordWow: delta(c.orders, c.orders_w), ordMom: delta(c.orders, c.orders_m), ordYoy: delta(c.orders, c.orders_y),
  })), [channels, chTotal]);
  // channel mix over time — stacked area (day: hourly, else daily; weekly-agg for long)
  const chMixOpt = useMemo(() => {
    const src = mode === "day" ? chHourly : chSeries;
    if (!src.length || !channels.length) return null;
    const isLong = mode === "long";
    const xkey = mode === "day" ? (r) => hourLabel(r.x) : isLong ? (r) => weekKey(isoDay(r.x)) : (r) => isoDay(r.x);
    const xs = [...new Set(src.map(xkey))];
    const m = new Map();
    src.forEach((r) => { const k = xkey(r) + "|" + r.ch; m.set(k, (m.get(k) || 0) + nnum(r.net)); });
    const series = channels.map((c) => ({ name: c.label, stack: "mix", color: chColor[c.label], data: xs.map((x) => m.get(x + "|" + c.label) || 0) }));
    const xlabels = mode === "day" ? xs : isLong ? xs.map((w) => w.replace(/^\d+-/, "")) : xs.map((d) => d.slice(5));
    return multiLineOption({ x: xlabels, series, fmt: kd });
  }, [chSeries, chHourly, channels, chColor, mode]);
  const chDonut = useMemo(() => channels.map((c) => ({ label: c.label, value: nnum(c.net) })), [channels]);
  const chAovBars = useMemo(() => channels.map((c) => ({ label: c.label, value: nnum(c.aov) })), [channels]);
  const chCols = [
    { key: "label", label: "Channel", align: "l", type: "text", render: (r) => <span className="lbl-mark"><ChannelMark name={r.label} size={20} />{r.label}</span> },
    { key: "net", label: "Net Sales", align: "r", type: "kd" },
    { key: "share", label: "Share", align: "r", type: "num", render: (r) => (r.share * 100).toFixed(1) + "%" },
    ...cmpDeltaCols(),
    { key: "orders", label: "Orders", align: "r", type: "num" },
    ...cmpOrdersDeltaCols(),
    { key: "aov", label: "AOV", align: "r", type: "kdc" },
  ];

  /* ---- Section 4: HOW MUCH — ticket economics ---- */
  const bucketNum = (label) => { const m = String(label).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 1e9; };
  const bucketRows = useMemo(() => buckets.map((b) => ({ label: b.label, orders: nnum(b.orders), net: nnum(b.net) }))
    .filter((b) => b.label != null && b.orders > 0).sort((a, b) => bucketNum(a.label) - bucketNum(b.label)), [buckets]);
  const bucketTot = useMemo(() => ({ orders: bucketRows.reduce((s, b) => s + b.orders, 0), net: bucketRows.reduce((s, b) => s + b.net, 0) }), [bucketRows]);
  const histOpt = useMemo(() => barOption({ data: bucketRows.map((b) => ({ label: b.label, value: b.orders })), horizontal: false, fmt: num, color: T.green }), [bucketRows]);
  // grouped bars: each ticket band's share of total orders vs share of total sales
  const bucketPctOpt = useMemo(() => ({
    grid: { left: 6, right: 12, top: 34, bottom: 20, containLabel: true },
    legend: { top: 2, data: ["% of orders", "% of sales"], textStyle: { color: T.muted, fontWeight: 700, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v) => (v != null ? Number(v).toFixed(1) + "%" : "") },
    xAxis: { type: "category", data: bucketRows.map((b) => b.label), axisLabel: { color: T.muted, fontSize: 10, interval: 0, rotate: bucketRows.length > 7 ? 30 : 0 }, axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { color: T.muted, fontSize: 10, formatter: "{value}%" }, splitLine: { lineStyle: { color: T.line } } },
    series: [
      { name: "% of orders", type: "bar", data: bucketRows.map((b) => (bucketTot.orders ? +(b.orders / bucketTot.orders * 100).toFixed(1) : 0)), itemStyle: { color: T.green, borderRadius: [4, 4, 0, 0] } },
      { name: "% of sales", type: "bar", data: bucketRows.map((b) => (bucketTot.net ? +(b.net / bucketTot.net * 100).toFixed(1) : 0)), itemStyle: { color: "#2E90FA", borderRadius: [4, 4, 0, 0] } },
    ],
  }), [bucketRows, bucketTot]);
  const aovTrendOpt = useMemo(() => {
    const src = mode === "long" ? weekly : dailyRows;
    const x = src.map((r) => (mode === "long" ? r.label : prettyDay(r.x)));
    return multiLineOption({ x, fmt: kdc, series: [{ name: "AOV", data: src.map((r) => (r.orders ? r.net / r.orders : null)), color: T.blue, area: true }] });
  }, [dailyRows, weekly, mode]);
  const ordersTrendOpt = useMemo(() => {
    const src = mode === "long" ? weekly : dailyRows;
    const x = src.map((r) => (mode === "long" ? r.label : prettyDay(r.x)));
    return multiLineOption({ x, fmt: num, series: [{ name: "Orders", data: src.map((r) => nnum(r.orders)), color: "#7A5AF8", area: true }] });
  }, [dailyRows, weekly, mode]);
  // AOV comparison bars — by brand at All Brands, by channel when a brand is scoped
  const aovCompare = useMemo(() => allBrands
    ? Object.values(brandGroups.groupTotals).filter((g) => g.aov != null).sort((a, b) => b.aov - a.aov).map((g) => ({ label: g.brand, value: nnum(g.aov) }))
    : chAovBars, [allBrands, brandGroups, chAovBars]);

  /* ---- Section 5: COMPARISONS — weekday-aligned WoW / MoM / YoY ---- */
  const P_CUR = T.green, P_W = "#2E90FA", P_M = "#F79009", P_Y = "#7A5AF8";
  const cmpMetrics = useMemo(() => {
    const c = compare || {};
    return [
      { metric: "Net Sales", cur: nnum(c.net), w: nnum(c.net_w), m: nnum(c.net_m), y: nnum(c.net_y), fmt: kd },
      { metric: "Orders", cur: nnum(c.ord), w: nnum(c.ord_w), m: nnum(c.ord_m), y: nnum(c.ord_y), fmt: num },
      { metric: "AOV", cur: nnum(c.aov), w: nnum(c.aov_w), m: nnum(c.aov_m), y: nnum(c.aov_y), fmt: kdc },
    ];
  }, [compare]);
  const overlay = useMemo(() => {
    const S = (rows) => (rows || []).map((r) => nnum(r.net));
    const cur = dailyRows.map((r) => r.net), w = S(cmpW), m = S(cmpM), y = S(cmpY);
    const N = Math.max(cur.length, w.length, m.length, y.length);
    const x = dailyRows.map((r) => prettyDay(r.x));
    while (x.length < N) x.push("D" + (x.length + 1));
    return { x, cur, w, m, y };
  }, [dailyRows, cmpW, cmpM, cmpY]);
  const overlayOpt = useMemo(() => multiLineOption({
    x: overlay.x, fmt: kd, series: [
      { name: "This period", data: overlay.cur, color: P_CUR, area: true },
      ...(showW ? [{ name: "Last week", data: overlay.w, color: P_W, dashed: true }] : []),
      ...(showM ? [{ name: "Last month", data: overlay.m, color: P_M, dashed: true }] : []),
      ...(showY ? [{ name: "Last year", data: overlay.y, color: P_Y, dashed: true }] : []),
    ],
  }), [overlay, showW, showM, showY]);
  const dayCmpOpt = useMemo(() => groupedBarOption({
    cats: ["Net Sales"], fmt: kd, series: [
      { name: "This day", data: [nnum(compare.net)], color: P_CUR },
      ...(showW ? [{ name: "Last week", data: [nnum(compare.net_w)], color: P_W }] : []),
      ...(showM ? [{ name: "Last month", data: [nnum(compare.net_m)], color: P_M }] : []),
      ...(showY ? [{ name: "Last year", data: [nnum(compare.net_y)], color: P_Y }] : []),
    ],
  }), [compare, showW, showM, showY]);
  const cmpDimRows = useMemo(() => cmpDim.map((r) => ({
    _k: r.label, label: r.label, netCur: nnum(r.netCur), netW: nnum(r.netW), netM: nnum(r.netM), netY: nnum(r.netY),
    vsW: delta(r.netCur, r.netW), vsM: delta(r.netCur, r.netM), vsY: delta(r.netCur, r.netY),
  })), [cmpDim]);
  const cmpDimBar = useMemo(() => {
    const top = [...cmpDimRows].sort((a, b) => b.netCur - a.netCur).slice(0, 8);
    return {
      cats: top.map((r) => r.label), series: [
        { name: "This period", data: top.map((r) => r.netCur), color: P_CUR },
        ...(showW ? [{ name: "Last week", data: top.map((r) => r.netW), color: P_W }] : []),
        ...(showM ? [{ name: "Last month", data: top.map((r) => r.netM), color: P_M }] : []),
        ...(showY ? [{ name: "Last year", data: top.map((r) => r.netY), color: P_Y }] : []),
      ],
    };
  }, [cmpDimRows, showW, showM, showY]);
  const cmpCols = [
    { key: "label", label: allBrands ? "Brand" : "Branch", align: "l", type: "text", render: allBrands ? (r) => <span className="lbl-mark"><BrandMark name={r.label} size={18} />{r.label}</span> : undefined },
    { key: "netCur", label: "This period", align: "r", type: "kd" },
    ...(showW ? [{ key: "vsW", label: "vs LW", align: "r", type: "num", render: (r) => <DeltaPill value={r.vsW} /> }] : []),
    ...(showM ? [{ key: "vsM", label: "vs LM", align: "r", type: "num", render: (r) => <DeltaPill value={r.vsM} /> }] : []),
    ...(showY ? [{ key: "vsY", label: "vs LY", align: "r", type: "num", render: (r) => <DeltaPill value={r.vsY} /> }] : []),
  ];
  const compareSummary = (() => {
    if (loading || !has(compare.net)) return "";
    const parts = [];
    if (showW) parts.push(`${fmtPct(delta(compare.net, compare.net_w))} vs same day last week`);
    if (showM) parts.push(`${fmtPct(delta(compare.net, compare.net_m))} vs last month`);
    if (showY) parts.push(`${fmtPct(delta(compare.net, compare.net_y))} vs last year`);
    return `Net sales ${kd(compare.net)}${parts.length ? " — " + parts.join(", ") + " (weekday-aligned)." : "."}`;
  })();

  /* ---- Section 6: DEEP DIVE — composable pivot grid ---- */
  const DIM_LABEL = { brand: "Brand", channel: "Channel", location: "Location", day: "Day" };
  const DIM_OPTS = ["brand", "channel", "location", "day"];
  const toggleDim = (d) => setDeepDims((ds) => ds.includes(d) ? (ds.length > 1 ? ds.filter((x) => x !== d) : ds) : [...ds, d]);
  const deepCols = useMemo(() => [
    ...deepDims.map((d, i) => ({
      key: "d" + i, label: DIM_LABEL[d], align: "l", type: "text",
      render: d === "day" ? (r) => isoDay(r["d" + i])
        : d === "brand" ? (r) => <span className="lbl-mark"><BrandMark name={r["d" + i]} size={18} />{r["d" + i]}</span>
        : d === "channel" ? (r) => <span className="lbl-mark"><ChannelMark name={r["d" + i]} size={18} />{r["d" + i]}</span>
        : undefined,
      exportVal: d === "day" ? (r) => isoDay(r["d" + i]) : (r) => r["d" + i],
    })),
    { key: "Net", label: "Net Sales", align: "r", type: "kd" },
    { key: "Orders", label: "Orders", align: "r", type: "num" },
    { key: "AOV", label: "AOV", align: "r", type: "kdc" },
  ], [deepDims]);
  const deepRows = useMemo(() => deep.map((r, i) => ({ ...r, _k: i, Net: nnum(r.Net), Orders: nnum(r.Orders), AOV: nnum(r.AOV) })), [deep]);
  const deepCapped = deepRows.length >= 3000;
  const deepSummary = deepLoading ? "" : deep.length
    ? `${deepRows.length}${deepCapped ? "+ (capped)" : ""} combinations across ${deepDims.map((d) => DIM_LABEL[d]).join(" × ")}. Sort any column; export the full grid to Excel.`
    : "";

  /* ---- auto summaries ---- */
  const peak = useMemo(() => {
    const src = mode === "day" ? hourly.map((r) => ({ h: r.x, v: nnum(r.value) })) : profile.map((r) => ({ h: r.x, v: nnum(r.cur) }));
    return src.reduce((a, b) => (b.v > (a?.v ?? -1) ? b : a), null);
  }, [hourly, profile, mode]);
  const peakCell = useMemo(() => heatData.reduce((a, b) => (b.value > (a?.value ?? -1) ? b : a), null), [heatData]);

  const whenSummary = (() => {
    if (loading) return "";
    if (mode === "day") {
      const wow = delta(head.netSales, head.netSales_w);
      return `Peak trading around ${peak ? hourLabel(peak.h) : "—"}. Net sales ${kd(head.netSales)} on the day, ${fmtPct(wow)} vs the same weekday last week.`;
    }
    const first = dailyRows[0]?.net, last = dailyRows[dailyRows.length - 1]?.net;
    const trend = delta(last, first);
    const busiest = peakCell ? `${peakCell.col} ${peakCell.row}` : "—";
    return `Busiest window: ${busiest}. Over ${days} days net sales totalled ${kd(head.netSales)}${mode === "long" ? ", shown at weekly grain" : ""}; day-to-day trend ${fmtPct(trend)} start-to-end.`;
  })();

  const howSummary = (() => {
    if (loading || !channels.length) return "";
    const top = channels[0]; // ranked by net
    const share = nnum(top.net) / chTotal, grow = delta(top.net, top.net_w);
    return `${top.label} leads the channel mix at ${(share * 100).toFixed(0)}% of net (${fmtPct(grow)} WoW), across ${channels.length} active channel${channels.length > 1 ? "s" : ""}.`;
  })();

  const howMuchSummary = (() => {
    if (loading || !bucketRows.length) return "";
    const busiest = [...bucketRows].sort((a, b) => b.orders - a.orders)[0];
    const wow = delta(head.aov, head.aov_w);
    return `Most orders land in the ${busiest.label} ticket band. Blended AOV ${kdc(head.aov)} (${fmtPct(wow)} WoW) on ${num(head.orders)} orders.`;
  })();

  const kpis = [
    { label: "Net Sales", value: head.netSales, fmt: kd, w: head.netSales_w },
    { label: "Orders", value: head.orders, fmt: num, w: head.orders_w },
    { label: "AOV", value: head.aov, fmt: kdc, w: head.aov_w },
    { label: "Gap to Target", value: head.gapKD, fmt: kd, gap: true },
  ];

  return (
    <div className={cls("sa", loading)}>
      <UpdatingBar show={loading} brand={gbrand} />
      {/* sticky section nav */}
      <aside className="sa-nav">
        <div className="sa-mode">{MODE_LABEL[mode]}<span className="sa-mode-days">{days === 1 ? "1 day" : `${days} days`}</span></div>
        {gbrand !== "all" && <div className="sa-brandtag"><Store size={12} /> {gbrand}</div>}
        {gbrand !== "all" && (
          <LocMultiSelect options={locOptions} value={xfilter.location || []}
            onChange={(arr) => setXfilter((x) => ({ ...x, location: arr }))} />
        )}
        <nav className="sa-jump">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`sa-jumpbtn ${active === s.id ? "on" : ""}`} onClick={() => goTo(s.id)}>
              <span className="sa-jump-n">{s.n}</span>{s.title}
            </button>
          ))}
        </nav>
        {chips.length > 0 && (
          <div className="sa-chips">
            <span className="uplabel" style={{ fontSize: 9 }}>Filters</span>
            {chips.map((c) => <span key={c.d} className="xchip">{c.d}: <b>{c.v}</b><button onClick={() => clearXf(c.d)}><X size={11} /></button></span>)}
          </div>
        )}
      </aside>

      {/* scrollable story — crossfades + re-counts when brand/date/filter changes */}
      <div className="sa-body">
       <motion.div key={contentKey} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} style={{ display: "flex", flexDirection: "column", gap: 26 }}>
        {/* KPI band — period totals + WoW */}
        <div className="sa-kpis" data-viz="landing_head" data-viz-label="Overview KPIs">
          {kpis.map((k, i) => (
            <Rise key={k.label} index={i} className="card sa-kpi">
              <span className="uplabel">{k.label}</span>
              {loading ? <Skeleton w="60%" h={20} /> : (
                <span className="sa-kpi-val num" style={k.gap ? { color: nnum(k.value) < 0 ? "var(--red-ink)" : "var(--green-ink)" } : undefined}>
                  <CountUp value={k.value || 0} format={k.fmt} />
                </span>
              )}
              {!loading && !k.gap && <span className="sa-kpi-d"><DeltaPill value={delta(k.value, k.w)} /><Term k="wow" className="cck-delta-cap">WoW</Term></span>}
              {!loading && k.gap && <span className="sa-kpi-d">{presetLabel(sel)}</span>}
            </Rise>
          ))}
        </div>

        {/* ---------------- Section 1: WHEN ---------------- */}
        <Section id="when" n="1" title="When" q="Time patterns — when do we actually sell?" summary={sections.when || whenSummary} mode={mode} reduce={reduce}>
          {mode === "day" ? (
            <ChartCard reduce={reduce} title="Hourly sales — with comparison overlays" sub="day view" height={340} loading={loading} empty={!hourly.length} data-viz="ov_hourly" data-viz-label="Hourly Sales">
              <div className="sa-toggles">
                <button className={`seg-btn ${overlays.lastWeek ? "on" : ""}`} onClick={() => setOverlays((o) => ({ ...o, lastWeek: !o.lastWeek }))}>Same day last week</button>
                <button className={`seg-btn ${overlays.expected ? "on" : ""}`} onClick={() => setOverlays((o) => ({ ...o, expected: !o.expected }))}>Expected (4-wk avg)</button>
              </div>
              <EChart height={300} option={hourOpt} />
              <p className="sa-note">No true hourly forecast exists in the model — “Expected” is the 4-week typical profile.</p>
            </ChartCard>
          ) : (
            <>
              <ChartCard reduce={reduce} title={mode === "long" ? "Weekly sales trend + moving average" : "Daily sales trend + 7-day moving average"} sub={mode === "long" ? "long-range" : "period view"} height={320} loading={loading} empty={!dailyRows.length} data-viz="ov_daily" data-viz-label="Daily Sales">
                <EChart height={300} option={trendOpt} />
              </ChartCard>
              <ChartCard reduce={reduce} title="Average day profile" sub="this period vs prior (ghost)" height={280} loading={loading} empty={!profile.length} data-viz="ov_profile" data-viz-label="Average Day Profile">
                <EChart height={250} option={profileOpt} />
              </ChartCard>
              <ChartCard reduce={reduce} title="Peak windows" sub="net sales by hour × weekday — darkest = busiest" height={280} loading={loading} empty={!heatData.length} data-viz="ov_heatmap" data-viz-label="Peak Windows Heatmap">
                <EChart height={Math.max(360, new Set(heatData.map((x) => x.row)).size * 26 + 70)} option={heatOption({ data: heatData, fmt: kd })} />
              </ChartCard>
              {mode === "long" && (
                <ChartCard reduce={reduce} title="Monthly progression" sub="vs target" height={280} loading={loading} empty={!monthly.length}>
                  <EChart height={250} option={monthOpt} />
                </ChartCard>
              )}
              <ChartCard reduce={reduce} title="Cumulative pace vs target" sub={mode === "long" ? "weekly cumulative" : "daily cumulative"} height={280} loading={loading} empty={!dailyRows.length}>
                <EChart height={250} option={paceOpt} />
              </ChartCard>
            </>
          )}
        </Section>

        {/* ---------------- Section 2: WHERE ---------------- */}
        <Section id="where" n="2" title="Where" q={allBrands ? "Brands — which brands drive the number?" : "Locations — which branches drive the number?"} summary={sections.where || whereSummary} mode={mode} reduce={reduce}>
          <div className="sa-two">
            <ChartCard reduce={reduce} title={allBrands ? "Brand contribution" : "Branch contribution"} sub={allBrands ? "share of net sales · colour = brand · click to filter" : `${gbrand} branches · click to filter`} height={330} loading={loading} empty={!branchRows.length}>
              <EChart height={310} option={treemapOption({ data: treeData, fmt: kd, activeName: allBrands ? xfilter.brand : activeLoc })} onEvents={{ click: (p) => (allBrands ? setBrandXf(p?.name) : setLoc(p?.name)) }} />
            </ChartCard>
            <ChartCard reduce={reduce} title={allBrands ? "Orders vs AOV per brand" : "Orders vs AOV per branch"} sub={allBrands ? "bubble = sales · colour = brand" : "bubble = sales · colour = vs target"} height={330} loading={loading} empty={!branchRows.length}>
              <EChart height={310} option={scatterOption({ points: scatterPts, activeName: allBrands ? xfilter.brand : activeLoc })} onEvents={{ click: (p) => (allBrands ? setBrandXf(p?.data?.name) : setLoc(p?.data?.name)) }} />
              <p className="sa-note">Top-right = busy &amp; premium · bottom-right = busy but low ticket · top-left = quiet but premium.</p>
            </ChartCard>
          </div>
          <InView reduce={reduce} className="card sa-chart" data-viz="ov_branches" data-viz-label="Branch Performance">
            {allBrands ? (
              <Matrix filename="Branch-Performance-by-Brand" rows={branchRows} groupTotals={brandGroups.groupTotals} grandTotalRow={brandGroups.grand}
                groupKey="brand" groupLabel="Brand" childKey="label" childLabel="Branch" measures={branchMeasures}
                onGroupClick={setBrandXf} activeGroup={xfilter.brand} groupMark={(g) => <BrandMark name={g} size={18} />} />
            ) : (
              <DataGrid title={`${gbrand} · Branches`} filename={`${gbrand}-Branches`} columns={branchCols} rows={branchRows}
                onRowClick={(r) => setLoc(r.label)} activeKey={activeLoc} defaultSort={{ key: "net", dir: "desc" }} />
            )}
          </InView>
          <InView reduce={reduce} className="card sa-chart" data-viz={mode === "day" ? "ov_loc_hour" : "ov_loc_day"} data-viz-label={allBrands ? "Brand heatmap" : "Location heatmap"}>
            {mode === "day"
              ? <PivotHeat rows={locHour} loading={loading} byHour title={allBrands ? "Brand" : "Location"} rowLabel={allBrands ? "Brand" : "Branch"} />
              : <PivotHeat rows={locDay} loading={loading} title={allBrands ? "Brand" : "Location"} rowLabel={allBrands ? "Brand" : "Branch"} />}
          </InView>
          <InView reduce={reduce} className="card sa-chart" data-viz="ov_src_hour" data-viz-label="Order Source × Hour heatmap">
            <PivotHeat rows={srcHour} loading={loading} byHour rowKey="src" rowLabel="Order source" title="Order source" />
          </InView>
        </Section>

        {/* ---------------- Section 3: HOW (channels) ---------------- */}
        <Section id="how" n="3" title="How" q="Channels — where is the mix shifting?" summary={sections.how || howSummary} mode={mode} reduce={reduce}>
          <ChartCard reduce={reduce} title="Channel mix over time" sub={mode === "day" ? "by hour · stacked net" : mode === "long" ? "weekly · stacked net" : "daily · stacked net"} height={320} loading={loading} empty={!chMixOpt} data-viz="ov_channel_series" data-viz-label="Channel Mix Over Time">
            <EChart height={300} option={chMixOpt || {}} />
            <p className="sa-note">Stacked net sales by order source — band thickness shows each channel's contribution over the period.</p>
          </ChartCard>
          <div className="sa-two">
            <ChartCard reduce={reduce} title="Channel share" sub="net sales split" height={300} loading={loading} empty={!chDonut.length}>
              <EChart height={280} option={donutOption({ data: chDonut, fmt: kd, colors: chDonut.map((d) => channelColorOf(d.label)) })} />
            </ChartCard>
            <ChartCard reduce={reduce} title="AOV by channel" sub="avg ticket per order source" height={300} loading={loading} empty={!chAovBars.length}>
              <EChart height={280} option={barOption({ data: chAovBars, horizontal: true, fmt: kdc, colors: chAovBars.map((d) => channelColorOf(d.label)) })} />
            </ChartCard>
          </div>
          <InView reduce={reduce} className="card sa-chart" data-viz="ov_channels" data-viz-label="Channel Performance">
            <DataGrid title="Channel performance" filename="Channel-Performance" columns={chCols} rows={chRows}
              onRowClick={(r) => setChannelXf(r.label)} activeKey={xfilter.channel} defaultSort={{ key: "net", dir: "desc" }} />
          </InView>
        </Section>

        {/* ---------------- Section 4: HOW MUCH (ticket economics) ---------------- */}
        <Section id="howmuch" n="4" title="How much" q="Ticket economics — volume vs ticket size" summary={sections.howmuch || howMuchSummary} mode={mode} reduce={reduce}>
          <ChartCard reduce={reduce} title="Order-value distribution" sub="each band's share of orders vs sales" height={320} loading={loading} empty={!bucketRows.length} data-viz="ov_buckets" data-viz-label="Order-Value Distribution">
            <EChart height={300} option={bucketPctOpt} />
            {!loading && bucketRows.length > 0 && (
              <div className="dt-wrap" style={{ marginTop: 10 }}>
                <table className="dt">
                  <thead><tr>
                    <th className="dt-th l">Ticket band</th>
                    <th className="dt-th r">Orders</th><th className="dt-th r">% of orders</th>
                    <th className="dt-th r">Net sales</th><th className="dt-th r">% of sales</th>
                  </tr></thead>
                  <tbody>
                    {bucketRows.map((b) => (
                      <tr key={b.label}>
                        <td className="l">{b.label}</td>
                        <td className="r num">{num(b.orders)}</td>
                        <td className="r num">{bucketTot.orders ? (b.orders / bucketTot.orders * 100).toFixed(1) + "%" : "—"}</td>
                        <td className="r num">{kd(b.net)}</td>
                        <td className="r num">{bucketTot.net ? (b.net / bucketTot.net * 100).toFixed(1) + "%" : "—"}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700, borderTop: "1px solid var(--line-2)" }}>
                      <td className="l">Total</td>
                      <td className="r num">{num(bucketTot.orders)}</td><td className="r num">100%</td>
                      <td className="r num">{kd(bucketTot.net)}</td><td className="r num">100%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            <p className="sa-note">Orders and net sales per ticket band, each as a share of the total — shows whether volume and revenue come from small or large tickets.</p>
          </ChartCard>
          <div className="sa-two">
            <ChartCard reduce={reduce} title="AOV over time" sub={mode === "long" ? "weekly avg ticket" : "avg ticket trend"} height={300} loading={loading} empty={!dailyRows.length}>
              <EChart height={280} option={aovTrendOpt} />
            </ChartCard>
            <ChartCard reduce={reduce} title="Orders over time" sub={mode === "long" ? "weekly volume" : "order volume trend"} height={300} loading={loading} empty={!dailyRows.length}>
              <EChart height={280} option={ordersTrendOpt} />
            </ChartCard>
          </div>
          <ChartCard reduce={reduce} title={allBrands ? "Average ticket by brand" : `Average ticket by channel · ${gbrand}`} sub="AOV comparison" height={Math.max(240, aovCompare.length * 30 + 30)} loading={loading} empty={!aovCompare.length}>
            <EChart height={Math.max(220, aovCompare.length * 30 + 20)} option={barOption({ data: aovCompare, horizontal: true, fmt: kdc, color: T.green })} />
            <p className="sa-note">Net = orders × ticket. Compare which {allBrands ? "brands" : "channels"} sell more per order to see whether growth is volume-led or ticket-led.</p>
          </ChartCard>
        </Section>

        {/* ---------------- Section 5: COMPARISONS ---------------- */}
        <Section id="compare" n="5" title="Comparisons" q={cmps.map((c) => c.label).join(" · ")} summary={compareSummary} mode={mode} reduce={reduce}>
          <div className="sa-cmp-cards" data-viz="ov_compare" data-viz-label="Period Comparison Metrics">
            {cmpMetrics.map((m, i) => (
              <Rise key={m.metric} index={i} className="card sa-cmp">
                <span className="uplabel">{m.metric}</span>
                {loading ? <Skeleton w="60%" h={22} /> : <span className="sa-cmp-val num"><CountUp value={m.cur} format={m.fmt} /></span>}
                {!loading && (
                  <div className="sa-cmp-rows">
                    {showW && <div className="sa-cmp-row"><span>vs last week</span><DeltaPill value={delta(m.cur, m.w)} /><span className="sa-cmp-abs num">{m.fmt(m.w)}</span></div>}
                    {showM && <div className="sa-cmp-row"><span>vs last month</span><DeltaPill value={delta(m.cur, m.m)} /><span className="sa-cmp-abs num">{m.fmt(m.m)}</span></div>}
                    {showY && <div className="sa-cmp-row"><span>vs last year</span><DeltaPill value={delta(m.cur, m.y)} /><span className="sa-cmp-abs num">{m.fmt(m.y)}</span></div>}
                  </div>
                )}
              </Rise>
            ))}
          </div>
          <ChartCard reduce={reduce} title={mode === "day" ? "Net sales — weekday-aligned windows" : "Net sales — this period vs aligned comparisons"} sub={cmps.map((c) => c.label.replace(/^vs /, "")).join(" · ")} height={320} loading={loading} empty={!has(compare.net)}>
            <EChart height={300} option={mode === "day" ? dayCmpOpt : overlayOpt} />
            <p className="sa-note">Comparisons adapt to the selected range: {days} day{days === 1 ? "" : "s"} → {cmps.map((c) => c.short).join(" + ")}. {showW ? "Last week −7d, " : ""}{showM ? "last month, " : ""}{showY ? "last year" : ""} — weekday-aligned.</p>
          </ChartCard>
          <ChartCard reduce={reduce} title={`${allBrands ? "Brand" : gbrand + " branch"} comparison`} sub="top by this period · net" height={320} loading={loading} empty={!cmpDimRows.length} data-viz="ov_compare_dim" data-viz-label="Comparison by Dimension">
            <EChart height={300} option={groupedBarOption({ cats: cmpDimBar.cats, series: cmpDimBar.series, fmt: kd })} />
          </ChartCard>
          <InView reduce={reduce} className="card sa-chart">
            <DataGrid title={`${allBrands ? "Brand" : gbrand + " branch"} — period comparison`} filename="Period-Comparison" columns={cmpCols} rows={cmpDimRows} defaultSort={{ key: "netCur", dir: "desc" }} />
          </InView>
        </Section>

        {/* ---------------- Section 6: DEEP DIVE ---------------- */}
        <Section id="deep" n="6" title="Deep dive" q="Brand × channel × location × day" summary={deepSummary} mode={mode} reduce={reduce}>
          <InView reduce={reduce} className="card sa-chart" data-viz="ov_deepdive" data-viz-label="Deep-Dive Pivot Grid">
            <div className="card-head">
              <span className="card-title">Pivot grid</span>
              <div className="sa-dimpick">
                <span className="uplabel" style={{ fontSize: 9 }}>Group by</span>
                {DIM_OPTS.map((d) => (
                  <button key={d} className={`seg-btn ${deepDims.includes(d) ? "on" : ""}`} onClick={() => toggleDim(d)}>{DIM_LABEL[d]}</button>
                ))}
              </div>
            </div>
            {deepCapped && <p className="sa-note" style={{ marginTop: 0 }}>Showing the top 3,000 combinations by net sales — narrow the date range or drop a dimension to see everything.</p>}
            {deepLoading ? <Skeleton h={360} /> : <DataGrid filename="Deep-Dive-Pivot" columns={deepCols} rows={deepRows} defaultSort={{ key: "Net", dir: "desc" }} />}
          </InView>
        </Section>
       </motion.div>
      </div>
    </div>
  );
}

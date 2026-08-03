import React, { useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, X, SlidersHorizontal, Rocket, Star, TrendingUp, TrendingDown, EyeOff, Lock, Settings } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { EChart, barOption, donutOption, multiLineOption, DeltaPill, Skeleton, DataGrid, Matrix } from "./ui.jsx";
import { selQuery, presetLabel, activeComparisons } from "./dates.js";
import { swr, agoLabel } from "./clientCache.js";
import WidgetGrid from "./widgets/WidgetGrid.jsx";
import { cls, UpdatingBar } from "./Updating.jsx";

const CRIT = ["pm_kpis", "pm_launch_detail", "pm_hero", "pm_category"];
const REST = ["pm_bestsellers", "pm_daypart", "pm_hourly", "pm_xa_cards"];
const HEAVY = ["pm_cat_month", "pm_cat_detail", "pm_cat_bucket"];
const SINGLES = new Set(["pm_kpis", "pm_selected", "pm_xa_cards"]);
const RED = "#E9052A";
const BUCKETS = ["0–1", "1–2", "2–3", "3–4", "4–5", "5–6", "6–7", "7–8", "8–9", "9–10", "10–11", "11–12", "12+"];

async function fetchBatch(names, q) {
  const res = await fetch(`/api/viz-batch?names=${names.join(",")}&${q}`, { credentials: "include" });
  const j = res.ok ? await res.json() : { results: {} };
  const out = {};
  for (const n of names) { const r = j.results ? j.results[n] : null; out[n] = r && r.row !== undefined ? r.row : r && r.rows !== undefined ? r.rows : (SINGLES.has(n) ? {} : []); }
  return out;
}
const fetchViz = (name, q) => fetch(`/api/viz/${name}?${q}`, { credentials: "include" }).then((r) => r.json()).then((j) => (j.row != null ? j.row : j.rows || [])).catch(() => []);
const api = (url, opts) => fetch(url, { credentials: "include", ...opts }).then((r) => r.json());

const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const num = (v) => Math.round(nn(v)).toLocaleString("en-US");
const money = (v) => nn(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const money2 = (v) => nn(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => (v == null ? "—" : (nn(v) * 100).toFixed(1) + "%");
const pct2 = (v) => (v == null ? "—" : (nn(v) * 100).toFixed(2) + "%");
const signPct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
const deltaOf = (cur, prev) => (prev == null || nn(prev) === 0 ? null : (nn(cur) - nn(prev)) / nn(prev));
const shortDate = (v) => { if (!v) return "—"; const dd = new Date(String(v).slice(0, 10)); return isNaN(dd) ? "—" : dd.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
const initials = (s) => String(s || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const DKEY = { w: "_w", m: "_m", y: "_y" };
const COLORS = ["#12B76A", "#2E90FA", "#7A5AF8", "#F79009", "#F04438", "#EE46BC", "#15B79E", "#EAAA08"];
const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthList(range) {
  if (!range || !range.start || !range.end) return [];
  const [sy, sm] = range.start.split("-").map(Number), [ey, em] = range.end.split("-").map(Number);
  const out = []; let y = sy, m = sm, i = 0;
  while ((y < ey || (y === ey && m <= em)) && i < 12) { out.push({ key: `m${i}`, label: `${MN[m - 1]} ${y}` }); m++; if (m > 12) { m = 1; y++; } i++; }
  return out;
}
function heatBg(t) {
  if (t == null) return "transparent";
  t = Math.max(0, Math.min(1, t)); const lp = (a, b, u) => Math.round(a + (b - a) * u); let r, g, b;
  if (t < 0.5) { const u = t / 0.5; r = lp(255, 253, u); g = lp(255, 224, u); b = lp(255, 138, u); }
  else { const u = (t - 0.5) / 0.5; r = lp(253, 214, u); g = lp(224, 69, u); b = lp(138, 80, u); }
  return `rgb(${r},${g},${b})`;
}
const heatText = (t) => (t != null && t > 0.72 ? "#fff" : "#1F2937");

function PmSelect({ label, value, options, onChange, width = 172, allText = "All", disabled = false }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(""); const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const filtered = useMemo(() => { const s = q.toLowerCase(); return options.filter((o) => !s || String(o).toLowerCase().includes(s)).slice(0, 300); }, [options, q]);
  return (
    <div className={`pm-sel ${disabled ? "locked" : ""}`} ref={ref} style={{ width }}>
      <button className={`pm-sel-btn ${value ? "set" : ""}`} disabled={disabled} title={disabled ? "Set by administrator" : undefined} onClick={() => !disabled && setOpen((o) => !o)}>
        <span className="pm-sel-lbl">{label}</span><span className="pm-sel-val">{value || allText}</span>
        {disabled ? <Lock size={12} /> : value ? <X size={13} onClick={(e) => { e.stopPropagation(); onChange(""); }} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="pm-sel-pop">
          <input autoFocus className="pm-sel-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pm-sel-list">
            <button className={`pm-sel-opt ${!value ? "on" : ""}`} onClick={() => { onChange(""); setOpen(false); }}>{allText}</button>
            {filtered.map((o) => <button key={o} className={`pm-sel-opt ${o === value ? "on" : ""}`} onClick={() => { onChange(o); setOpen(false); }}>{o}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

// Selling Price min/max range filter (styled like the other filter controls)
function PriceFilter({ pmin, pmax, onChange, disabled }) {
  const [open, setOpen] = useState(false); const ref = useRef(null);
  const [lo, setLo] = useState(pmin || ""); const [hi, setHi] = useState(pmax || "");
  useEffect(() => { setLo(pmin || ""); setHi(pmax || ""); }, [pmin, pmax]);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const label = pmin || pmax ? `${pmin || "0"}–${pmax || "∞"}` : "All";
  return (
    <div className={`pm-sel ${disabled ? "locked" : ""}`} ref={ref} style={{ width: 150 }}>
      <button className={`pm-sel-btn ${pmin || pmax ? "set" : ""}`} disabled={disabled} title={disabled ? "Set by administrator" : undefined} onClick={() => !disabled && setOpen((o) => !o)}>
        <span className="pm-sel-lbl">Selling Price</span><span className="pm-sel-val">{label}</span>
        {disabled ? <Lock size={12} /> : (pmin || pmax) ? <X size={13} onClick={(e) => { e.stopPropagation(); onChange({ pmin: "", pmax: "" }); }} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="pm-sel-pop" style={{ minWidth: 200 }}>
          <div className="pm-price-row"><input type="number" placeholder="Min" value={lo} onChange={(e) => setLo(e.target.value)} /><span>–</span><input type="number" placeholder="Max" value={hi} onChange={(e) => setHi(e.target.value)} /></div>
          <button className="wg-pop-add" onClick={() => { onChange({ pmin: lo, pmax: hi }); setOpen(false); }}>Apply</button>
        </div>
      )}
    </div>
  );
}

export default function ProductMixPage({ sel, brand: gbrand = "all", isAdmin = false, role = "" }) {
  const [d, setD] = useState({});
  const [range, setRange] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState(null);
  const [lists, setLists] = useState({ products: [], mains: [], cats: [], srcs: [], locs: [] });
  const [f, setF] = useState({ prod: "", cat: "", src: "", loc: "", pmin: "", pmax: "" });
  const [item, setItem] = useState(""); const [main, setMain] = useState("");
  const [sd, setSd] = useState(null); const [md, setMd] = useState(null);
  const [drill, setDrill] = useState({ cat: null, items: [] });   // Category Sales Mix drill-down
  const [excl, setExcl] = useState([]);                            // admin hero exclusions
  const [vc, setVc] = useState(null);                              // admin Visual Config (defaults/locks)
  const [vcOpen, setVcOpen] = useState(false);
  const [pmfOpen, setPmfOpen] = useState(false);   // filters live in a popover, not spread across the bar
  const pmfRef = useRef(null);
  useEffect(() => { const h = (e) => { if (pmfRef.current && !pmfRef.current.contains(e.target)) setPmfOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const vcApplied = useRef(false);
  const bq = gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "";
  // build a scope query string from a filter object (global filter bar, or a per-visual override merged over it)
  const buildFq = (o) => ["prod", "cat", "src", "loc", "brand"].map((k) => (o[k] ? `&pm${k === "prod" ? "prod" : k}=` + encodeURIComponent(o[k]) : "")).join("")
    + (o.pmin ? "&pmpmin=" + encodeURIComponent(o.pmin) : "") + (o.pmax ? "&pmpmax=" + encodeURIComponent(o.pmax) : "");
  const fq = buildFq(f);
  const fkey = f.prod + "|" + f.cat + "|" + f.src + "|" + f.loc + "|" + f.pmin + "|" + f.pmax;

  useEffect(() => { fetch(`/api/range?${selQuery(sel)}`, { credentials: "include" }).then((r) => r.json()).then(setRange).catch(() => {}); }, [sel]);
  useEffect(() => {
    // route value lists to the selected brand's model, and scope them to the selected
    // dates — the Source/Location lists are date-filtered server-side, so they must
    // refetch when the range changes or they'd offer values with no orders in it.
    const bqOnly = selQuery(sel) + (gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "");
    Promise.all([fetchViz("pm_products", bqOnly), fetchViz("pm_mainitems", bqOnly), fetchViz("pm_categories", bqOnly), fetchViz("pm_sources", bqOnly), fetchViz("pm_locations", bqOnly)])
      .then(([p, mi, c, s, l]) => setLists({ products: p.map((r) => r.item).filter(Boolean), mains: mi.map((r) => r.item).filter(Boolean), cats: c.map((r) => r.v).filter(Boolean), srcs: s.map((r) => r.v).filter(Boolean), locs: l.map((r) => r.v).filter(Boolean) }));
    if (isAdmin) api("/api/admin/pm-exclusions").then((x) => setExcl(x.hero || [])).catch(() => {});
  }, [isAdmin, gbrand, sel]);
  // admin Visual Config — apply default filters / locks / default selections once
  useEffect(() => {
    api("/api/layouts/productmix").then((r) => {
      const v = r.visuals || {}; setVc(v);
      if (vcApplied.current) return; vcApplied.current = true;
      if (v.filters) setF((x) => ({ ...x, ...Object.fromEntries(Object.entries(v.filters).filter(([, val]) => val)) }));
      if (v.sel && v.sel.product) setItem(v.sel.product);
      if (v.sel && v.sel.main) setMain(v.sel.main);
    }).catch(() => setVc({}));
  }, []);
  const lim = { new_items: (vc && vc.limits && +vc.limits.new_items) || 6, hero: (vc && vc.limits && +vc.limits.hero) || 6, bestsellers: (vc && vc.limits && +vc.limits.bestsellers) || 20 };
  const srt = { bestsellers: (vc && vc.sort && vc.sort.bestsellers) || "sales", category: (vc && vc.sort && vc.sort.category) || "sales" };
  const locked = (dim) => !isAdmin && vc && vc.locked && vc.locked[dim];

  useEffect(() => {
    let live = true; setLoading(true); setDrill({ cat: null, items: [] });
    const q = selQuery(sel) + bq + fq;
    let first = true;
    swr("pmix|" + q, () => fetchBatch(CRIT, q), (m, meta) => { if (!live) return; setD((prev) => (first ? m : { ...prev, ...m })); first = false; setLoading(false); setUpdated(meta.ts); })
      .then(() => { if (!live) return; fetchBatch(REST, q).then((m2) => live && setD((p) => ({ ...p, ...m2 }))); fetchBatch(HEAVY, q).then((m3) => live && setD((p) => ({ ...p, ...m3 }))); })
      .catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [sel, gbrand, fkey]);

  useEffect(() => { if (!item) { setSd(null); return; } let live = true; fetchBatch(["pm_selected", "pm_together"], selQuery(sel) + bq + "&pmitem=" + encodeURIComponent(item)).then((m) => live && setSd(m)); return () => { live = false; }; }, [item, sel, gbrand]);
  useEffect(() => { let live = true; fetchBatch(["pm_xa_cards", "pm_crosssell_items", "pm_attach_items"], selQuery(sel) + bq + (main ? "&pmmain=" + encodeURIComponent(main) : "")).then((m) => live && setMd(m)); return () => { live = false; }; }, [main, sel, gbrand]);
  const vd = (name) => d[name];

  const cmps = useMemo(() => activeComparisons(range), [range && range.start, range && range.end]);
  const months = useMemo(() => monthList(range), [range && range.start, range && range.end]);
  const k = vd("pm_kpis") || {}, category = vd("pm_category") || [], bestsellers = vd("pm_bestsellers") || [], daypart = vd("pm_daypart") || [], hourly = vd("pm_hourly") || [], hero = vd("pm_hero") || [], launchDetail = vd("pm_launch_detail") || [], catMonth = vd("pm_cat_month") || [], catBucket = vd("pm_cat_bucket") || [];
  const together = (sd && sd.pm_together) || [], selOrders = sd && sd.pm_selected && sd.pm_selected.orders;
  const xa = (md && md.pm_xa_cards) || d.pm_xa_cards || {}, crossItems = (md && md.pm_crosssell_items) || [], attachItems = (md && md.pm_attach_items) || [];
  const anyFilter = f.prod || f.cat || f.src || f.loc || f.pmin || f.pmax;
  const activeFilterCount = [f.prod, f.cat, f.src, f.loc, (f.pmin || f.pmax)].filter(Boolean).length;

  const kpis = [
    { label: "Net Sales", base: "sales", value: money(k.sales), cmp: true },
    { label: "Quantity", base: "qty", value: num(k.qty), cmp: true },
    { label: "Orders", base: "orders", value: num(k.orders), cmp: true },
    { label: "AOV", base: null, value: money2(k.aov) },
    { label: "Discount %", base: null, value: pct(k.disc) },
  ];
  const catCols = [
    { key: "label", label: "Category", align: "l" },
    { key: "sales", label: "Net Sales", align: "r", render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) },
    { key: "mix", label: "Mix %", align: "r", render: (r) => pct(r.mix) },
    ...cmps.map((c) => ({ key: "d" + c.key, label: c.short, align: "r", always: true, tip: `${c.label} — vs ${c.rangeText}`, render: (r) => <DeltaPill value={deltaOf(r.sales, r["sales" + DKEY[c.key]])} /> })),
  ];
  const bestCols = [{ key: "item", label: "Item", align: "l" }, { key: "category", label: "Category", align: "l" }, { key: "sales", label: "Net Sales", align: "r", render: (r) => money(r.sales) }, { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) }, { key: "mix", label: "Mix %", align: "r", render: (r) => pct(r.mix) }, { key: "vel", label: "Vel", align: "r", render: (r) => nn(r.vel).toFixed(0) }];

  const detail = useMemo(() => {
    const leaves = [], gt = {}; let grand = null;
    for (const r of (vd("pm_cat_detail") || [])) { if (nn(r.isCat) === 1) grand = r; else if (nn(r.isItem) === 1) gt[r.category] = r; else leaves.push(r); }
    const gq = grand ? nn(grand.qty) : leaves.reduce((s, r) => s + nn(r.qty), 0);
    const qm = (r) => ({ ...r, qtymix: gq ? nn(r.qty) / gq : null });
    return { leaves: leaves.map(qm), groupTotals: Object.fromEntries(Object.entries(gt).map(([kk, v]) => [kk, qm(v)])), grand: grand ? qm(grand) : null };
  }, [d.pm_cat_detail]);
  const detailMeasures = [
    { key: "mix", label: "Mix %", align: "r", total: true, render: (r) => pct2(r.mix) },
    { key: "amt", label: "Amount", align: "r", total: true, render: (r) => money(r.amt) },
    ...cmps.map((c) => ({ key: "d" + c.key, label: c.short, align: "r", always: true, tip: `Amount ${c.label} — vs ${c.rangeText}`, render: (r) => <DeltaPill value={deltaOf(r.amt, r["amt" + DKEY[c.key]])} /> })),
    { key: "qty", label: "Qty", align: "r", total: true, render: (r) => money2(r.qty) },
    { key: "qtymix", label: "Qty Mix", align: "r", total: true, render: (r) => pct2(r.qtymix) },
    { key: "cann", label: "Cannib. %", align: "r", render: (r) => pct2(r.cann) },
  ];
  const monthTotals = useMemo(() => { const t = {}; for (const r of catMonth) for (const mo of months) t[mo.key] = (t[mo.key] || 0) + nn(r[mo.key]); t.tot = catMonth.reduce((s, r) => s + nn(r.tot), 0); return t; }, [catMonth, months]);
  const bucketPivot = useMemo(() => {
    const byCat = {}, colTot = {};
    for (const r of catBucket) { const c = r.category; (byCat[c] = byCat[c] || {})[r.bucket] = nn(r.cnt); colTot[r.bucket] = (colTot[r.bucket] || 0) + nn(r.cnt); }
    const cats = Object.entries(byCat).map(([c, m]) => ({ cat: c, vals: m, total: BUCKETS.reduce((s, b) => s + (m[b] || 0), 0) })).sort((a, b) => b.total - a.total);
    return { cats, colTot, grandTot: BUCKETS.reduce((s, b) => s + (colTot[b] || 0), 0) };
  }, [catBucket]);

  const toggleDrill = (cat) => {
    if (drill.cat === cat) { setDrill({ cat: null, items: [] }); return; }
    setDrill({ cat, items: [], loading: true });
    fetchViz("pm_cat_month_items", selQuery(sel) + bq + fq + "&pmdrillcat=" + encodeURIComponent(cat)).then((rows) => setDrill({ cat, items: rows }));
  };
  async function excludeHero(itemName) {
    const next = [...new Set([...excl, itemName])];
    setExcl(next); await api("/api/admin/pm-exclusions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hero: next }) });
    fetchBatch(["pm_hero"], selQuery(sel) + bq + fq).then((m) => setD((p) => ({ ...p, ...m })));
  }

  const catBar = useMemo(() => barOption({ data: category.slice(0, 10).map((r) => ({ label: r.label, value: nn(r.sales) })), horizontal: true, inverse: true, fmt: money, color: "#7A5AF8" }), [category]);
  const daypartDonut = useMemo(() => donutOption({ data: daypart.map((r) => ({ label: r.label, value: nn(r.sales) })), fmt: money, colors: COLORS }), [daypart]);
  const hourlyOpt = useMemo(() => multiLineOption({ x: hourly.map((r) => r.hour + "h"), fmt: num, series: [{ name: "Orders", data: hourly.map((r) => nn(r.orders)), color: "#2E90FA", area: true }] }), [hourly]);
  const penBar = (rows) => barOption({ data: rows.slice(0, 14).map((r) => ({ label: r.item, value: nn(r.pen) })), horizontal: true, inverse: true, fmt: (v) => (v * 100).toFixed(1) + "%", color: RED });

  // ---- each section as a self-contained widget element (data is bound here) ----
  const el = {
    kpis: (
      <div className="pmix-kpis">{kpis.map((kp) => (
        <div key={kp.label} className="card pmix-kpi">
          <span className="uplabel">{kp.label}</span>
          <span className="pmix-kpi-val num">{loading ? <Skeleton w={70} h={20} /> : kp.value}</span>
          {kp.cmp && !loading && <div className="pmix-kpi-deltas">{cmps.map((c) => <span key={c.key} title={`${c.label} — vs ${c.rangeText}`}><DeltaPill value={deltaOf(k[kp.base], k[kp.base + DKEY[c.key]])} tag={c.short} /></span>)}</div>}
        </div>))}</div>
    ),
    new_items: (
      <div className="card">
        <div className="card-head"><span className="card-title sm"><Rocket size={14} style={{ color: RED, verticalAlign: "-2px", marginRight: 5 }} />New Item Launch</span><span className="card-sub">{launchDetail.length ? launchDetail.length + " new items" : ""} · first sale in period</span></div>
        {launchDetail.length ? (
          <div className="pm-mini-list">{launchDetail.slice(0, lim.new_items).map((it) => { const g = deltaOf(it.sales, it.salesprev); return (
            <div key={it.item} className="pm-mini">
              <span className="pm-mini-av" style={{ background: COLORS[initials(it.item).charCodeAt(0) % COLORS.length] }}>{initials(it.item)}</span>
              <div className="pm-mini-hd"><b title={it.item}>{it.item}</b><span>{it.category} · {shortDate(it.launch)}</span></div>
              <div className="pm-mini-kpis"><div><span>Rev</span><b>{money(it.sales)}</b></div><div><span>Qty</span><b>{num(it.qty)}</b></div><div><span>Vel</span><b>{nn(it.vel).toFixed(0)}</b></div></div>
              {g != null && <span className={`pm-mini-g ${g >= 0 ? "up" : "down"}`}>{g >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{signPct(g)}</span>}
            </div>); })}</div>
        ) : (loading ? <Skeleton h={140} /> : <div className="dt-empty sm">No new items in this period.</div>)}
      </div>
    ),
    hero: (
      <div className="card">
        <div className="card-head"><span className="card-title sm"><Star size={14} style={{ color: "#F5B301", verticalAlign: "-2px", marginRight: 5 }} />Hero Items</span><span className="card-sub">top penetration &amp; velocity{excl.length ? ` · ${excl.length} excluded` : ""}</span></div>
        {hero.length ? (
          <div className="pm-mini-list">{hero.slice(0, lim.hero).map((h, i) => (
            <div key={h.item + i} className="pm-mini">
              <span className="pm-mini-av rank" style={{ background: COLORS[i % COLORS.length] }}>{i + 1}</span>
              <div className="pm-mini-hd"><b title={h.item}>{h.item}</b><span>{h.category}</span></div>
              <div className="pm-mini-kpis"><div><span>Rev</span><b>{money(h.sales)}</b></div><div><span>Pen</span><b>{pct(h.pen)}</b></div><div><span>Vel</span><b>{nn(h.vel).toFixed(0)}</b></div></div>
              {isAdmin && <button className="pm-mini-excl" title="Exclude from Hero (all users)" onClick={() => excludeHero(h.item)}><EyeOff size={12} /></button>}
            </div>))}</div>
        ) : <Skeleton h={140} />}
      </div>
    ),
    fbt: (
      <div className={`card ${item ? "" : "pm-collapsed"}`}>
        <div className="card-head"><span className="card-title sm">Frequently Bought Together</span>
          <PmSelect label="Product" value={item} options={lists.products} onChange={setItem} width={190} allText="Select a product" />
        </div>
        {item && (
          <div className="pm-reveal">
            <div className="pm-fbt-card"><span className="uplabel">Selected Item Orders</span><b>{selOrders == null ? "…" : num(selOrders)}</b></div>
            {together.length ? <EChart height={Math.min(320, Math.max(150, together.length * 20))} option={penBar(together)} /> : <div className="dt-empty sm">No pairings.</div>}
          </div>
        )}
      </div>
    ),
    crossattach: (
      <div className={`card ${main ? "" : "pm-collapsed"}`}>
        <div className="card-head"><span className="card-title sm">Cross-Sell &amp; Attach</span>
          <PmSelect label="Main item" value={main} options={lists.mains} onChange={setMain} width={190} allText="Select a main item" />
        </div>
        {main && (
          <div className="pm-reveal">
            <div className="pm-xa-cards2">
              <div className="pm-xa-card"><span className="uplabel">Cross-Sell Opp. %</span><b>{xa.cross == null ? "…" : pct2(xa.cross)}</b></div>
              <div className="pm-xa-card"><span className="uplabel">Attach Opp. %</span><b>{xa.attach == null ? "…" : pct2(xa.attach)}</b></div>
            </div>
            <div className="pmix-2 tight">
              <div><div className="ops-lbl">Cross-sell items</div>{crossItems.length ? <EChart height={190} option={penBar(crossItems)} /> : <div className="dt-empty sm">—</div>}</div>
              <div><div className="ops-lbl">Attach items</div>{attachItems.length ? <EChart height={190} option={penBar(attachItems)} /> : <div className="dt-empty sm">—</div>}</div>
            </div>
          </div>
        )}
      </div>
    ),
    cat_perf: (<div className="card"><div className="card-head"><span className="card-title sm">Category performance</span></div>{loading ? <Skeleton h={220} /> : <DataGrid columns={catCols} rows={category} filename="ProductMix-Categories" defaultSort={{ key: srt.category, dir: "desc" }} rank={false} />}</div>),
    bestsellers: (<div className="card"><div className="card-head"><span className="card-title sm">Bestsellers</span></div>{bestsellers.length ? <DataGrid columns={bestCols} rows={bestsellers.slice(0, lim.bestsellers)} filename="ProductMix-Bestsellers" defaultSort={{ key: srt.bestsellers, dir: "desc" }} /> : <Skeleton h={220} />}</div>),
    sales_mix: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Category Sales Mix</span><span className="card-sub">Item Sales Mix % by month · click a category to drill to items</span></div>
        {catMonth.length ? (
          <div className="dt-wrap pm-heat-wrap"><table className="dt pm-heat">
            <thead><tr><th className="dt-th l">Category</th>{months.map((mo) => <th key={mo.key} className="dt-th r">{mo.label}</th>)}<th className="dt-th r">Total</th></tr></thead>
            <tbody>
              {catMonth.map((r) => (
                <React.Fragment key={r.label}>
                  <tr className="pm-heat-cat" onClick={() => toggleDrill(r.label)}>
                    <td className="l"><span className="pm-exp">{drill.cat === r.label ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>{r.label}</td>
                    {months.map((mo) => { const t = monthTotals[mo.key], v = t ? nn(r[mo.key]) / t : null; return <td key={mo.key} className="r num" style={{ background: heatBg(v), color: heatText(v) }}>{v == null ? "" : pct2(v)}</td>; })}
                    {(() => { const v = monthTotals.tot ? nn(r.tot) / monthTotals.tot : null; return <td className="r num" style={{ background: heatBg(v), color: heatText(v) }}>{pct2(v)}</td>; })()}
                  </tr>
                  {drill.cat === r.label && (drill.items || []).map((it) => (
                    <tr key={it.label} className="pm-heat-item">
                      <td className="l pm-heat-itemname">{it.label}</td>
                      {months.map((mo) => { const t = monthTotals[mo.key], v = t ? nn(it[mo.key]) / t : null; return <td key={mo.key} className="r num" style={{ background: heatBg(v), color: heatText(v) }}>{v ? pct2(v) : ""}</td>; })}
                      <td className="r num" style={{ background: heatBg(monthTotals.tot ? nn(it.tot) / monthTotals.tot : null), color: heatText(monthTotals.tot ? nn(it.tot) / monthTotals.tot : null) }}>{monthTotals.tot ? pct2(nn(it.tot) / monthTotals.tot) : ""}</td>
                    </tr>
                  ))}
                  {drill.cat === r.label && drill.loading && <tr><td colSpan={months.length + 2} className="dt-empty sm">Loading items…</td></tr>}
                </React.Fragment>
              ))}
              <tr className="dt-total"><td className="l">Total</td>{months.map((mo) => <td key={mo.key} className="r num">100.00%</td>)}<td className="r num">100.00%</td></tr>
            </tbody></table></div>
        ) : <Skeleton h={220} />}
      </div>
    ),
    cat_detail: (<div className="card pm-compact-mx">{detail.leaves.length ? <Matrix rows={detail.leaves} groupTotals={detail.groupTotals} grandTotalRow={detail.grand} groupKey="category" groupLabel="Category" childKey="item" childLabel="Item" measures={detailMeasures} filename="Category-Detail" /> : <Skeleton h={260} />}</div>),
    bucket: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Category × Order-Value Bucket</span><span className="card-sub">% of orders per NetSales bucket (column)</span></div>
        {bucketPivot.cats.length ? (
          <div className="dt-wrap pm-heat-wrap"><table className="dt pm-bucket">
            <thead><tr><th className="dt-th l">Category</th>{BUCKETS.map((b) => <th key={b} className="dt-th r">{b}</th>)}<th className="dt-th r">Total</th></tr></thead>
            <tbody>
              {bucketPivot.cats.map((row) => (<tr key={row.cat}><td className="l">{row.cat}</td>
                {BUCKETS.map((b) => { const ct = bucketPivot.colTot[b], v = ct ? (row.vals[b] || 0) / ct : null; return <td key={b} className="r num">{v ? pct2(v) : ""}</td>; })}
                <td className="r num">{bucketPivot.grandTot ? pct2(row.total / bucketPivot.grandTot) : ""}</td></tr>))}
              <tr className="dt-total"><td className="l">Total</td>{BUCKETS.map((b) => <td key={b} className="r num">{bucketPivot.colTot[b] ? "100.00%" : ""}</td>)}<td className="r num">100.00%</td></tr>
            </tbody></table></div>
        ) : <Skeleton h={220} />}
      </div>
    ),
    cat_mix_chart: (<div className="card"><div className="card-head"><span className="card-title sm">Category sales mix</span></div>{category.length ? <EChart height={200} option={catBar} /> : <Skeleton h={200} />}</div>),
    daypart: (<div className="card"><div className="card-head"><span className="card-title sm">Day-part split</span></div>{daypart.length ? <EChart height={200} option={daypartDonut} /> : <Skeleton h={200} />}</div>),
    hourly: (<div className="card"><div className="card-head"><span className="card-title sm">Hourly velocity</span></div>{hourly.length ? <EChart height={200} option={hourlyOpt} /> : <Skeleton h={200} />}</div>),
  };
  const widgets = [
    { id: "kpis", title: "KPIs", defaultW: 12, component: el.kpis, meta: { viz: "pm_kpis", measures: ["Net Sales", "QUANTITY", "Orders", "AOV = Net Sales/Orders", "Discount %"], dims: [] } },
    { id: "new_items", title: "New Item Launch", defaultW: 6, component: el.new_items, meta: { viz: "pm_launch_detail", measures: ["Item Sales", "Item Velocity", "Item Penetration %", "Is New Item (first sale in [start-30, end])"], dims: ["ProductName_Fixed_Option", "Category", "Brand"] } },
    { id: "hero", title: "Hero Items", defaultW: 6, component: el.hero, meta: { viz: "pm_hero", measures: ["Item Penetration %", "Item Velocity", "Item Sales", "Item Orders"], dims: ["ProductName_Fixed_Option", "Category"] } },
    { id: "fbt", title: "Frequently Bought Together", defaultW: 6, component: el.fbt, meta: { viz: "pm_together", measures: ["Penetration %", "Orders Together Filtered", "Selected Item Orders"], dims: ["ProductName_Fixed_Option (Product Selector)"] } },
    { id: "crossattach", title: "Cross-Sell & Attach", defaultW: 6, component: el.crossattach, meta: { viz: "pm_xa_cards", measures: ["Cross Sell Opportunity %", "Attach Opportunity %", "Add On Penetration %"], dims: ["ProductName_Fixed_Option", "MAIN_ITEM"] } },
    { id: "cat_perf", title: "Category Performance", defaultW: 6, component: el.cat_perf, meta: { viz: "pm_category", measures: ["Item Sales", "Item Sales Mix %", "Item Orders"], dims: ["Category"] } },
    { id: "bestsellers", title: "Bestsellers", defaultW: 6, component: el.bestsellers, meta: { viz: "pm_bestsellers", measures: ["Item Sales", "Item Sales Mix %", "Item Velocity"], dims: ["ProductName_Fixed_Option", "Category"] } },
    { id: "sales_mix", title: "Category Sales Mix", defaultW: 12, component: el.sales_mix, meta: { viz: "pm_cat_month", measures: ["Item Sales Mix % (SUM SaleAmount ÷ column)"], dims: ["Category", "Month (VoucherDate)"] } },
    { id: "cat_detail", title: "Category Detail", defaultW: 12, component: el.cat_detail, meta: { viz: "pm_cat_detail", measures: ["Item Sales Mix %", "Item Sales", "Qty (AdjustedQuantity)", "Cannibalisation %"], dims: ["Category", "ProductName_Fixed_Option"] } },
    { id: "bucket", title: "Category × Order-Value Bucket", defaultW: 12, component: el.bucket, meta: { viz: "pm_cat_bucket", measures: ["DISTINCTCOUNT(KEY) as % of column"], dims: ["Category", "NETSALES_BUCKET"] } },
    { id: "cat_mix_chart", title: "Category Mix (chart)", defaultW: 4, component: el.cat_mix_chart, meta: { viz: "pm_category", measures: ["Item Sales"], dims: ["Category"] } },
    { id: "daypart", title: "Day-part Split", defaultW: 4, component: el.daypart, meta: { viz: "pm_daypart", measures: ["SUM(Net)", "Orders"], dims: ["DAY_PART"] } },
    { id: "hourly", title: "Hourly Velocity", defaultW: 4, component: el.hourly, meta: { viz: "pm_hourly", measures: ["AVERAGE NET SALES", "ORDERS"], dims: ["HOUR"], note: "all-time (HOURLY SALES has no date relationship)" } },
  ];
  // Inspect: the filters currently applied to the visuals + the dims an admin can add
  return (
    <div className={cls("page pmix", loading)}>
      <UpdatingBar show={loading} brand={gbrand} />
      {/* filter bar (global control — always on top, not a widget) */}
      <div className="pm-filters stays-live">
        {/* all filters live inside this popover so the bar stays clean */}
        <div className="pm-filters-wrap" ref={pmfRef}>
          <button className={`pm-filters-btn ${anyFilter ? "on" : ""}`} onClick={() => setPmfOpen((o) => !o)} title="Filters">
            <SlidersHorizontal size={15} /> <span>Filters</span>
            {activeFilterCount > 0 && <span className="pm-filters-count">{activeFilterCount}</span>}
            <ChevronDown size={13} className={`pm-filters-caret ${pmfOpen ? "up" : ""}`} />
          </button>
          {pmfOpen && (
            <div className="pm-filters-pop">
              <div className="pm-filters-pop-h">Filters</div>
              <PmSelect label="Product" value={f.prod} options={lists.products} onChange={(v) => setF((x) => ({ ...x, prod: v }))} width={220} disabled={locked("prod")} />
              <PmSelect label="Category" value={f.cat} options={lists.cats} onChange={(v) => setF((x) => ({ ...x, cat: v }))} width={220} disabled={locked("cat")} />
              <PmSelect label="Order Source" value={f.src} options={lists.srcs} onChange={(v) => setF((x) => ({ ...x, src: v }))} width={220} disabled={locked("src")} />
              <PmSelect label="Location" value={f.loc} options={lists.locs} onChange={(v) => setF((x) => ({ ...x, loc: v }))} width={220} disabled={locked("loc")} />
              <PriceFilter pmin={f.pmin} pmax={f.pmax} onChange={(p) => setF((x) => ({ ...x, ...p }))} disabled={locked("price")} />
              {anyFilter && <button className="pm-clear" onClick={() => setF({ prod: locked("prod") ? f.prod : "", cat: locked("cat") ? f.cat : "", src: locked("src") ? f.src : "", loc: locked("loc") ? f.loc : "", pmin: locked("price") ? f.pmin : "", pmax: locked("price") ? f.pmax : "" })}><X size={12} /> Clear all</button>}
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {isAdmin && <button className="wg-btn admin" onClick={() => setVcOpen(true)} title="Admin: set visual defaults (filters, selections, Top-N, sort) for all users"><Settings size={13} /> Visual defaults</button>}
        {updated && <span className="upd-badge">Updated {agoLabel(updated)}</span>}
      </div>

      <WidgetGrid dash="productmix" widgets={widgets} isAdmin={isAdmin} role={role} />

      <AnimatePresence>
        {vcOpen && isAdmin && <VisualConfigDrawer lists={lists} vc={vc || {}} onClose={() => setVcOpen(false)} onSave={(next) => { setVc(next); api("/api/admin/layouts/productmix/visuals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visuals: next }) }); }} />}
      </AnimatePresence>
    </div>
  );
}

// ---- Phase 4: admin Visual Config editor (invisible to end users) ----------
function VisualConfigDrawer({ lists, vc, onClose, onSave }) {
  const [c, setC] = useState(() => ({
    filters: { cat: "", src: "", loc: "", prod: "", ...(vc.filters || {}) },
    locked: { cat: false, src: false, loc: false, prod: false, ...(vc.locked || {}) },
    sel: { product: "", main: "", ...(vc.sel || {}) },
    limits: { new_items: 6, hero: 6, bestsellers: 20, ...(vc.limits || {}) },
    sort: { bestsellers: "sales", category: "sales", ...(vc.sort || {}) },
  }));
  const upd = (grp, k, v) => setC((p) => ({ ...p, [grp]: { ...p[grp], [k]: v } }));
  const [saved, setSaved] = useState(false);
  const doSave = () => { onSave(c); setSaved(true); setTimeout(() => { setSaved(false); onClose(); }, 900); };
  const FilterRow = ({ dim, label, options, width }) => (
    <div className="vc-frow">
      <PmSelect label={label} value={c.filters[dim]} options={options} onChange={(v) => upd("filters", dim, v)} width={width || 190} />
      <label className="wg-chk"><input type="checkbox" checked={!!c.locked[dim]} onChange={(e) => upd("locked", dim, e.target.checked)} /> Lock</label>
    </div>
  );
  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="wg-drawer" initial={{ x: 460 }} animate={{ x: 0 }} exit={{ x: 460 }} transition={{ type: "spring", stiffness: 380, damping: 40 }}>
        <div className="wg-drawer-head"><div><b>Visual defaults</b><span>Applied for all users · they cannot see this</span></div><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="wg-drawer-body">
          <div className="vc-sec">Default filters <small>(pre-applied; lock to prevent users changing)</small></div>
          <FilterRow dim="prod" label="Product" options={lists.products} width={210} />
          <FilterRow dim="cat" label="Category" options={lists.cats} />
          <FilterRow dim="src" label="Order Source" options={lists.srcs} />
          <FilterRow dim="loc" label="Location" options={lists.locs} />

          <div className="vc-sec">Default selections</div>
          <div className="vc-frow"><PmSelect label="Frequently-bought product" value={c.sel.product} options={lists.products} onChange={(v) => upd("sel", "product", v)} width={230} allText="None" /></div>
          <div className="vc-frow"><PmSelect label="Cross-sell main item" value={c.sel.main} options={lists.mains} onChange={(v) => upd("sel", "main", v)} width={230} allText="None" /></div>

          <div className="vc-sec">Row limits (Top-N)</div>
          <div className="vc-grid3">
            <label className="mfield"><span>New items</span><input type="number" min="1" max="24" value={c.limits.new_items} onChange={(e) => upd("limits", "new_items", e.target.value)} /></label>
            <label className="mfield"><span>Hero items</span><input type="number" min="1" max="12" value={c.limits.hero} onChange={(e) => upd("limits", "hero", e.target.value)} /></label>
            <label className="mfield"><span>Bestsellers</span><input type="number" min="1" max="50" value={c.limits.bestsellers} onChange={(e) => upd("limits", "bestsellers", e.target.value)} /></label>
          </div>

          <div className="vc-sec">Default sort</div>
          <div className="vc-grid3">
            <label className="mfield"><span>Bestsellers</span><select value={c.sort.bestsellers} onChange={(e) => upd("sort", "bestsellers", e.target.value)}><option value="sales">Net Sales</option><option value="qty">Quantity</option><option value="mix">Mix %</option><option value="vel">Velocity</option></select></label>
            <label className="mfield"><span>Category perf.</span><select value={c.sort.category} onChange={(e) => upd("sort", "category", e.target.value)}><option value="sales">Net Sales</option><option value="qty">Quantity</option><option value="mix">Mix %</option></select></label>
          </div>
        </div>
        <div className="wg-drawer-foot"><div style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={doSave}>{saved ? "Saved ✓" : "Save & apply"}</button></div>
      </motion.div>
    </>
  );
}

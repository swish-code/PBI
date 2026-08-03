import React, { useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, X, SlidersHorizontal, Rocket, Star, TrendingUp, TrendingDown, EyeOff } from "lucide-react";
import { EChart, barOption, donutOption, multiLineOption, heatOption, DeltaPill, Skeleton, DataGrid, Matrix } from "./ui.jsx";
import { selQuery, activeComparisons } from "./dates.js";
import { cls, UpdatingBar } from "./Updating.jsx";
import WidgetGrid from "./widgets/WidgetGrid.jsx";

const RED = "#E9052A";
const CRIT = ["yp_kpis", "yp_hero", "yp_launch_detail", "yp_menucat"];
const REST = ["yp_products", "yp_cat_month", "yp_size", "yp_pizzatype", "yp_flavours"];
const PIZZA = ["yp_pz_flavour", "yp_pz_size", "yp_pz_dough", "yp_pz_fsd", "yp_pz_grid", "yp_pz_halfhalf", "yp_pz_flav_trend", "yp_pz_flav_crust"];
// pizza drilldown dimensions the user can reorder
const PZ_DIMS = { flavour: "Flavour", size: "Size", crust: "Crust / Pizza Type", item: "Pizza Item" };
const SINGLES = new Set(["yp_kpis", "yp_selected", "yp_xa_cards"]);

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
// Menu Item Category = CategoryDescription, else OPTION_PARENT_CATEGORY_NAME when blank
const micOf = (r) => { const c = String(r.catdesc || "").trim(); return c || r.optparent || "—"; };
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

function PmSelect({ label, value, options, onChange, width = 172, allText = "All" }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(""); const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const filtered = useMemo(() => { const s = q.toLowerCase(); return (options || []).filter((o) => !s || String(o).toLowerCase().includes(s)).slice(0, 300); }, [options, q]);
  return (
    <div className="pm-sel" ref={ref} style={{ width }}>
      <button className={`pm-sel-btn ${value ? "set" : ""}`} onClick={() => setOpen((o) => !o)}>
        <span className="pm-sel-lbl">{label}</span><span className="pm-sel-val">{value || allText}</span>
        {value ? <X size={13} onClick={(e) => { e.stopPropagation(); onChange(""); }} /> : <ChevronDown size={13} />}
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

export default function YeloProductMix({ sel, isAdmin = false, role = "" }) {
  const [d, setD] = useState({});
  const [loading, setLoading] = useState(true);
  const [lists, setLists] = useState({});
  const [f, setF] = useState({ prod: "", size: "", crust: "", flav: "", src: "", type: "", loc: "", grp: "", menu: "" });
  const [range, setRange] = useState(null);
  const [item, setItem] = useState(""); const [main, setMain] = useState("");
  const [sd, setSd] = useState(null); const [md, setMd] = useState(null);
  const [drill, setDrill] = useState({ cat: null, mains: [], mainsLoading: false, main: null, items: [], itemsLoading: false });
  const [excl, setExcl] = useState([]);
  const [drillMode, setDrillMode] = useState("main");   // "main" = Category›Main Product›Item, "item" = Category›Item
  const [pzOrder, setPzOrder] = useState(["flavour", "size", "crust"]);   // reorderable pizza drilldown (3 levels)
  const [pzTrendMetric, setPzTrendMetric] = useState("qty");              // flavour daily trend metric
  const [mainCatMap, setMainCatMap] = useState({});   // MAIN_PRODUCT_NAME → header category

  const fq = useMemo(() => {
    const m = { ypprod: f.prod, ypsize: f.size, ypcrust: f.crust, ypflav: f.flav, ypsrc: f.src, yptype: f.type, yploc: f.loc, ypgrp: f.grp, ypmenucat: f.menu };
    return Object.entries(m).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
  }, [f]);
  const anyFilter = Object.values(f).some(Boolean);

  useEffect(() => { fetch(`/api/range?${selQuery(sel)}`, { credentials: "include" }).then((r) => r.json()).then(setRange).catch(() => {}); }, [sel]);
  useEffect(() => {
    const L = ["yp_l_products", "yp_l_sizes", "yp_l_crusts", "yp_l_flavours", "yp_l_sources", "yp_l_types", "yp_l_locations", "yp_l_groups", "yp_l_menucats", "yp_mainitems"];
    Promise.all(L.map((n) => fetchViz(n, "").then((rows) => rows.map((r) => r.v != null ? r.v : r.item).filter(Boolean)).catch(() => [])))
      .then(([products, sizes, crusts, flavours, sources, types, locations, groups, menucats, mains]) => setLists({ products, sizes, crusts, flavours, sources, types, locations, groups, menucats, mains }));
    if (isAdmin) api("/api/admin/yp-exclusions").then((x) => setExcl(x.hero || [])).catch(() => {});
    fetchViz("yp_main_cats", "").then((rows) => { const m = {}; for (const r of rows) if (r.main && !m[r.main]) m[r.main] = micOf(r); setMainCatMap(m); }).catch(() => {});
  }, [isAdmin]);
  useEffect(() => {
    let live = true; setLoading(true);
    fetchBatch(CRIT, selQuery(sel) + fq).then((m) => { if (live) { setD((p) => ({ ...p, ...m })); setLoading(false); } });
    fetchBatch(REST, selQuery(sel) + fq).then((m) => live && setD((p) => ({ ...p, ...m })));
    fetchBatch(PIZZA, selQuery(sel) + fq).then((m) => live && setD((p) => ({ ...p, ...m })));
    return () => { live = false; };
  }, [sel, fq]);
  // FBT — fetch when a product is picked
  useEffect(() => { if (!item) { setSd(null); return; } let live = true; fetchBatch(["yp_selected", "yp_together"], selQuery(sel) + fq + "&ypitem=" + encodeURIComponent(item)).then((m) => live && setSd(m)); return () => { live = false; }; }, [item, sel, fq]);
  // Cross-Sell/Attach — fetch when a main item is picked (default overall)
  useEffect(() => { if (!main) { setMd({}); return; } let live = true; fetchBatch(["yp_xa_cards", "yp_crosssell_items", "yp_attach_items"], selQuery(sel) + fq + "&ypxamain=" + encodeURIComponent(main)).then((m) => live && setMd(m)); return () => { live = false; }; }, [main, sel, fq]);

  const cmps = useMemo(() => activeComparisons(range || {}), [range && range.start, range && range.end]);
  const months = useMemo(() => monthList(range), [range && range.start, range && range.end]);
  const k = d.yp_kpis || {};
  const hero = useMemo(() => (d.yp_hero || []).map((r) => ({ ...r, category: micOf(r) })), [d.yp_hero]);
  const launches = useMemo(() => (d.yp_launch_detail || []).map((r) => ({ ...r, category: micOf(r) })), [d.yp_launch_detail]);
  const products = d.yp_products || [];
  const size = d.yp_size || [], pizzatype = d.yp_pizzatype || [], flavours = d.yp_flavours || [];
  const catMonth = useMemo(() => {
    const byMic = {};
    for (const r of (d.yp_cat_month || [])) { const c = micOf(r); const t = byMic[c] = byMic[c] || { label: c, tot: 0 }; t.tot += nn(r.tot); for (let i = 0; i < 12; i++) { const kk = `m${i}`; if (r[kk] != null) t[kk] = nn(t[kk]) + nn(r[kk]); } }
    return Object.values(byMic).sort((a, b) => nn(b.tot) - nn(a.tot));
  }, [d.yp_cat_month]);
  const menucatRaw = d.yp_menucat || [];
  const menucat = useMemo(() => { const t = menucatRaw.reduce((s, r) => s + nn(r.sales), 0) || 1; return menucatRaw.map((r) => ({ ...r, mix: nn(r.sales) / t })); }, [menucatRaw]);
  const selOrders = sd && sd.yp_selected && sd.yp_selected.orders;
  const together = (sd && sd.yp_together) || [];
  const xa = (md && md.yp_xa_cards) || {}, crossItems = (md && md.yp_crosssell_items) || [], attachItems = (md && md.yp_attach_items) || [];

  async function excludeHero(itemName) {
    const next = [...new Set([...excl, itemName])]; setExcl(next);
    await api("/api/admin/yp-exclusions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hero: next }) });
    fetchBatch(["yp_hero"], selQuery(sel) + fq).then((m) => setD((p) => ({ ...p, ...m })));
  }
  const toggleCat = (cat) => {
    if (drill.cat === cat) { setDrill({ cat: null, mains: [], main: null, items: [] }); return; }
    setDrill({ cat, mains: [], mainsLoading: true, main: null, items: [] });
    fetchViz("yp_cat_month_mains", selQuery(sel) + fq + "&ypdrillcat=" + encodeURIComponent(cat)).then((rows) => setDrill((dd) => ({ ...dd, mains: rows, mainsLoading: false })));
  };
  const toggleMain = (cat, mainName) => {
    if (drill.main === mainName) { setDrill((dd) => ({ ...dd, main: null, items: [] })); return; }
    setDrill((dd) => ({ ...dd, main: mainName, items: [], itemsLoading: true }));
    fetchViz("yp_cat_month_items", selQuery(sel) + fq + "&ypdrillcat=" + encodeURIComponent(cat) + "&ypdrillmain=" + encodeURIComponent(mainName)).then((rows) => setDrill((dd) => ({ ...dd, items: rows, itemsLoading: false })));
  };

  const kpis = [
    { label: "Quantity", base: "qty", value: num(k.qty), cmp: true },
    { label: "Net Sales", base: "sales", value: money(k.sales), cmp: true },
    { label: "Orders", base: "orders", value: num(k.orders), cmp: true },
    { label: "Pizza Qty", base: null, value: num(k.pizzaqty) },
    { label: "AOV", base: null, value: money2(k.aov) },
  ];
  const catCols = [
    { key: "label", label: "Menu Item Category", align: "l" },
    { key: "sales", label: "Net Sales", align: "r", render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) },
    { key: "mix", label: "Mix %", align: "r", render: (r) => pct2(r.mix) },
  ];
  const bestCols = [
    { key: "item", label: "Item", align: "l" }, { key: "category", label: "Category", align: "l" },
    { key: "sales", label: "Net Sales", align: "r", render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) },
    { key: "pen", label: "Pen %", align: "r", render: (r) => pct2(r.pen) },
    { key: "vel", label: "Vel", align: "r", render: (r) => num(r.vel) },
  ];
  const detailMeasures = [
    { key: "mix", label: "Mix %", align: "r", total: true, render: (r) => pct2(r.mix) },
    { key: "sales", label: "Amount", align: "r", total: true, render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", total: true, render: (r) => num(r.qty) },
    ...cmps.map((c) => ({ key: "d" + c.key, label: c.short, align: "r", tip: `Qty ${c.label} — vs ${c.rangeText}`, render: (r) => <DeltaPill value={r["d" + c.key]} /> })),
    { key: "pen", label: "Pen %", align: "r", render: (r) => pct2(r.pen) },
    { key: "vel", label: "Velocity", align: "r", render: (r) => num(r.vel) },
  ];
  const detail = useMemo(() => {
    const grpT = {}; let gq = 0, gs = 0, gw = 0, gm = 0, gy = 0;
    // category = the main product's header category (so all of a combo's items sit together), else the item's own
    const leaves = products.map((r) => ({ ...r, category: (r.main && mainCatMap[r.main]) || micOf(r), main: r.main || "—" }));
    for (const r of leaves) {
      const c = r.category; const t = grpT[c] = grpT[c] || { category: c, qty: 0, sales: 0, qty_w: 0, qty_m: 0, qty_y: 0 };
      t.qty += nn(r.qty); t.sales += nn(r.sales); t.qty_w += nn(r.qty_w); t.qty_m += nn(r.qty_m); t.qty_y += nn(r.qty_y);
      gq += nn(r.qty); gs += nn(r.sales); gw += nn(r.qty_w); gm += nn(r.qty_m); gy += nn(r.qty_y);
    }
    // precompute WoW/MoM/YoY deltas at every level so Matrix's null-guard renders them
    const withDeltas = (r) => { for (const c of cmps) r["d" + c.key] = deltaOf(nn(r.qty), nn(r["qty" + DKEY[c.key]])); };
    for (const c in grpT) { grpT[c].mix = gs ? grpT[c].sales / gs : null; withDeltas(grpT[c]); }
    for (const r of leaves) { r.mix = gs ? nn(r.sales) / gs : null; withDeltas(r); }
    const grand = { category: "Total", qty: gq, sales: gs, mix: gs ? 1 : null, qty_w: gw, qty_m: gm, qty_y: gy };
    withDeltas(grand);
    return { leaves, groupTotals: grpT, grand };
  }, [products, mainCatMap, cmps]);
  const monthTotals = useMemo(() => { const t = {}; for (const r of catMonth) for (const mo of months) t[mo.key] = (t[mo.key] || 0) + nn(r[mo.key]); t.tot = catMonth.reduce((s, r) => s + nn(r.tot), 0); return t; }, [catMonth, months]);

  const penBar = (rows) => { const o = barOption({ data: rows.slice(0, 14).map((r) => ({ label: r.item, value: nn(r.pen) })), horizontal: true, inverse: true, color: RED }); if (o.xAxis) o.xAxis.axisLabel = { ...(o.xAxis.axisLabel || {}), formatter: (v) => Math.round(nn(v) * 100) + "%" }; o.tooltip = { ...(o.tooltip || {}), valueFormatter: (v) => (nn(v) * 100).toFixed(1) + "%" }; return o; };
  const sizeDonut = useMemo(() => donutOption({ data: size.map((r) => ({ label: r.label, value: nn(r.qty) })), fmt: num, colors: COLORS }), [size]);
  const typeDonut = useMemo(() => donutOption({ data: pizzatype.map((r) => ({ label: r.label, value: nn(r.qty) })), fmt: num, colors: COLORS }), [pizzatype]);
  const flavBar = useMemo(() => barOption({ data: flavours.slice(0, 12).map((r) => ({ label: r.label, value: nn(r.qty) })), horizontal: true, inverse: true, fmt: num, color: "#7A5AF8" }), [flavours]);

  // ---- Pizza analysis (flavour / size / dough) ----
  const pzFlavour = d.yp_pz_flavour || [], pzSize = d.yp_pz_size || [], pzDough = d.yp_pz_dough || [];
  const pzFlavSize = d.yp_pz_flav_size || [], pzFsd = d.yp_pz_fsd || [];
  const pzGrid = d.yp_pz_grid || [];
  const pzHalf = d.yp_pz_halfhalf || [];
  const pzTrend = d.yp_pz_flav_trend || [];
  const pzHeat = d.yp_pz_flav_crust || [];
  // flavour-wise daily trend — top 6 flavours as lines over the period
  const pzTrendOpt = useMemo(() => {
    if (!pzTrend.length) return null;
    const m = pzTrendMetric;
    const dates = [...new Set(pzTrend.map((r) => String(r.x).slice(0, 10)))].sort();
    const totals = {}, byFD = {};
    // sum per (flavour, day) — VoucherDate may carry a time, so multiple rows can
    // share a day; overwriting (instead of summing) was dropping data → wrong trend.
    for (const r of pzTrend) { totals[r.flavour] = (totals[r.flavour] || 0) + nn(r[m]); const day = String(r.x).slice(0, 10); const f = (byFD[r.flavour] ||= {}); f[day] = (f[day] || 0) + nn(r[m]); }
    const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]);
    const series = top.map((fl, i) => ({ name: fl, data: dates.map((dt) => byFD[fl]?.[dt] || 0), color: COLORS[i % COLORS.length] }));
    return multiLineOption({ x: dates.map((dt) => dt.slice(5)), series, fmt: m === "sales" ? money : num });
  }, [pzTrend, pzTrendMetric]);
  // crust × flavour heatmap (rows = flavour, cols = crust, shaded by qty)
  const pzHeatOpt = useMemo(() => {
    if (!pzHeat.length) return null;
    return heatOption({ data: pzHeat.map((r) => ({ row: r.flavour, col: r.crust, value: nn(r.qty) })), fmt: num, xRotate: 40 });
  }, [pzHeat]);
  const pzHalfCols = [
    { key: "label", label: "Chosen flavour (half)", align: "l", type: "text" },
    { key: "sales", label: "Sales", align: "r", render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) },
  ];
  const pzFlavBar = useMemo(() => barOption({ data: pzFlavour.slice(0, 14).map((r) => ({ label: r.label, value: nn(r.sales) })), horizontal: true, inverse: true, fmt: money, color: RED }), [pzFlavour]);
  const pzSizeDonut = useMemo(() => donutOption({ data: pzSize.map((r) => ({ label: r.label, value: nn(r.sales) })), fmt: money, colors: COLORS }), [pzSize]);
  const pzDoughDonut = useMemo(() => donutOption({ data: pzDough.map((r) => ({ label: r.label, value: nn(r.sales) })), fmt: money, colors: COLORS }), [pzDough]);
  // Flavour × Size pivot — sizes as columns, one row per flavour, cells shaded by share of row
  const flavSizePivot = useMemo(() => {
    const sizes = [...new Set(pzFlavSize.map((r) => r.size))];
    const byFlav = {};
    for (const r of pzFlavSize) { const o = (byFlav[r.flavour] ||= { flavour: r.flavour, _tot: 0 }); o[r.size] = nn(o[r.size]) + nn(r.qty); o._tot += nn(r.qty); }
    const rows = Object.values(byFlav).sort((a, b) => b._tot - a._tot);
    const max = Math.max(1, ...rows.flatMap((rw) => sizes.map((s) => nn(rw[s]))));
    return { sizes, rows, max };
  }, [pzFlavSize]);
  const pzFlavCols = [
    { key: "label", label: "Flavour", align: "l" },
    { key: "sales", label: "Sales", align: "r", render: (r) => <span className="num">{money(r.sales)}</span> },
    { key: "qty", label: "Pizzas sold", tip: "Number of pizzas of this flavour sold in the period", align: "r", render: (r) => <span className="num">{num(r.qty)}</span> },
    { key: "inc", label: "Order share %", term: "penetration", tip: "Share of pizza orders that included this flavour", align: "r", render: (r) => <span className="num">{(nn(r.inc) * 100).toFixed(1)}%</span> },
  ];
  const pzFsdMeasures = [
    { key: "sales", label: "Sales", align: "r", type: "kd", total: true },
    { key: "qty", label: "Qty", align: "r", type: "num", total: true },
  ];
  const menuBar = useMemo(() => barOption({ data: menucat.slice(0, 12).map((r) => ({ label: r.label, value: nn(r.qty) })), horizontal: true, inverse: true, fmt: num, color: "#2E90FA" }), [menucat]);

  // reorderable pizza drilldown → Matrix group/sub/child keys from the chosen order
  const pzLevels = pzOrder.filter((v, i, a) => v && a.indexOf(v) === i);
  const pzMx = (() => {
    const [g, s, c] = pzLevels;
    if (pzLevels.length >= 3) return { groupKey: g, groupLabel: PZ_DIMS[g], subKey: s, subLabel: PZ_DIMS[s], childKey: c, childLabel: PZ_DIMS[c] };
    if (pzLevels.length === 2) return { groupKey: g, groupLabel: PZ_DIMS[g], childKey: s, childLabel: PZ_DIMS[s] };
    return null;
  })();
  // flat "all pizzas" list — one row per pizza item, aggregated
  const pzItems = useMemo(() => {
    const m = {};
    for (const r of pzGrid) { const o = (m[r.item] ||= { item: r.item, flavour: r.flavour, size: r.size, crust: r.crust, qty: 0, sales: 0 }); o.qty += nn(r.qty); o.sales += nn(r.sales); }
    return Object.values(m).sort((a, b) => nn(b.sales) - nn(a.sales));
  }, [pzGrid]);
  // single-level pick → a flat aggregated list of that one dimension
  const pzOne = useMemo(() => {
    const dim = pzLevels.length === 1 ? pzLevels[0] : null;
    if (!dim) return null;
    const m = {};
    for (const r of pzGrid) { const key = r[dim] ?? "—"; const o = (m[key] ||= { label: key, qty: 0, sales: 0 }); o.qty += nn(r.qty); o.sales += nn(r.sales); }
    return Object.values(m).sort((a, b) => nn(b.sales) - nn(a.sales));
  }, [pzGrid, pzLevels.length === 1 ? pzLevels[0] : ""]);
  const pzOneCols = [
    { key: "label", label: pzLevels[0] ? PZ_DIMS[pzLevels[0]] : "", align: "l", type: "text" },
    { key: "sales", label: "Sales", align: "r", render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) },
  ];
  const pzItemCols = [
    { key: "item", label: "Pizza Item", align: "l", type: "text" },
    { key: "flavour", label: "Flavour", align: "l", type: "text" },
    { key: "size", label: "Size", align: "l", type: "text" },
    { key: "crust", label: "Crust / Type", align: "l", type: "text" },
    { key: "sales", label: "Sales", align: "r", render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) },
  ];

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
        <div className="card-head"><span className="card-title sm"><Rocket size={14} style={{ color: RED, verticalAlign: "-2px", marginRight: 5 }} />New Item Launch</span><span className="card-sub">{launches.length ? launches.length + " new items" : ""} · first sale in [period − 30d]</span></div>
        {launches.length ? (
          <div className="pm-mini-list">{launches.slice(0, 8).map((it) => { const gr = deltaOf(it.sales, it.salesprev); return (
            <div key={it.item} className="pm-mini">
              <span className="pm-mini-av" style={{ background: COLORS[initials(it.item).charCodeAt(0) % COLORS.length] }}>{initials(it.item)}</span>
              <div className="pm-mini-hd"><b title={it.item}>{it.item}</b><span>{it.category || "—"} · {shortDate(it.launch)}</span></div>
              <div className="pm-mini-kpis"><div><span>Rev</span><b>{money(it.sales)}</b></div><div><span>Qty</span><b>{num(it.qty)}</b></div><div><span>Vel</span><b>{num(it.vel)}</b></div></div>
              {gr != null && <span className={`pm-mini-g ${gr >= 0 ? "up" : "down"}`}>{gr >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{signPct(gr)}</span>}
            </div>); })}</div>
        ) : (loading ? <Skeleton h={140} /> : <div className="dt-empty sm">No new items in this period.</div>)}
      </div>
    ),
    hero: (
      <div className="card">
        <div className="card-head"><span className="card-title sm"><Star size={14} style={{ color: "#F5B301", verticalAlign: "-2px", marginRight: 5 }} />Hero Items</span><span className="card-sub">top penetration &amp; velocity{excl.length ? ` · ${excl.length} excluded` : ""}</span></div>
        {hero.length ? (
          <div className="pm-mini-list">{hero.slice(0, 8).map((h, i) => (
            <div key={h.item + i} className="pm-mini">
              <span className="pm-mini-av rank" style={{ background: COLORS[i % COLORS.length] }}>{i + 1}</span>
              <div className="pm-mini-hd"><b title={h.item}>{h.item}</b><span>{h.category || "—"}</span></div>
              <div className="pm-mini-kpis"><div><span>Rev</span><b>{money(h.sales)}</b></div><div><span>Pen</span><b>{pct(h.pen)}</b></div><div><span>Vel</span><b>{num(h.vel)}</b></div></div>
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
    cat_perf: (<div className="card"><div className="card-head"><span className="card-title sm">Category Performance</span><span className="card-sub">Menu Item Category</span></div>{loading ? <Skeleton h={220} /> : <DataGrid columns={catCols} rows={menucat} filename="Yelo-Categories" defaultSort={{ key: "sales", dir: "desc" }} rank={false} />}</div>),
    bestsellers: (<div className="card"><div className="card-head"><span className="card-title sm">Bestsellers</span></div>{hero.length ? <DataGrid columns={bestCols} rows={hero} filename="Yelo-Bestsellers" defaultSort={{ key: "qty", dir: "desc" }} /> : <Skeleton h={220} />}</div>),
    sales_mix: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Category Sales Mix</span><span className="card-sub">Sales Mix % by month · Category → Main Product → Item</span></div>
        {catMonth.length ? (
          <div className="dt-wrap pm-heat-wrap"><table className="dt pm-heat">
            <thead><tr><th className="dt-th l">Category → Main Product → Item</th>{months.map((mo) => <th key={mo.key} className="dt-th r">{mo.label}</th>)}<th className="dt-th r">Total</th></tr></thead>
            <tbody>
              {catMonth.map((r) => (
                <React.Fragment key={r.label}>
                  <tr className="pm-heat-cat" onClick={() => toggleCat(r.label)}>
                    <td className="l"><span className="pm-exp">{drill.cat === r.label ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>{r.label}</td>
                    {months.map((mo) => { const t = monthTotals[mo.key], v = t ? nn(r[mo.key]) / t : null; return <td key={mo.key} className="r num" style={{ background: heatBg(v), color: heatText(v) }}>{v == null ? "" : pct2(v)}</td>; })}
                    {(() => { const v = monthTotals.tot ? nn(r.tot) / monthTotals.tot : null; return <td className="r num" style={{ background: heatBg(v), color: heatText(v) }}>{pct2(v)}</td>; })()}
                  </tr>
                  {drill.cat === r.label && drill.mainsLoading && <tr><td colSpan={months.length + 2} className="dt-empty sm">Loading main products…</td></tr>}
                  {drill.cat === r.label && (drill.mains || []).map((mn) => (
                    <React.Fragment key={mn.label}>
                      <tr className="pm-heat-main" onClick={() => toggleMain(r.label, mn.label)}>
                        <td className="l" style={{ paddingLeft: 26 }}><span className="pm-exp">{drill.main === mn.label ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>{mn.label || "—"}</td>
                        {months.map((mo) => { const t = monthTotals[mo.key], v = t ? nn(mn[mo.key]) / t : null; return <td key={mo.key} className="r num" style={{ background: heatBg(v), color: heatText(v) }}>{v ? pct2(v) : ""}</td>; })}
                        <td className="r num" style={{ background: heatBg(monthTotals.tot ? nn(mn.tot) / monthTotals.tot : null), color: heatText(monthTotals.tot ? nn(mn.tot) / monthTotals.tot : null) }}>{monthTotals.tot ? pct2(nn(mn.tot) / monthTotals.tot) : ""}</td>
                      </tr>
                      {drill.main === mn.label && drill.itemsLoading && <tr><td colSpan={months.length + 2} className="dt-empty sm">Loading items…</td></tr>}
                      {drill.main === mn.label && (drill.items || []).map((it) => (
                        <tr key={it.label} className="pm-heat-item">
                          <td className="l pm-heat-itemname" style={{ paddingLeft: 48 }}>{it.label}</td>
                          {months.map((mo) => { const t = monthTotals[mo.key], v = t ? nn(it[mo.key]) / t : null; return <td key={mo.key} className="r num" style={{ background: heatBg(v), color: heatText(v) }}>{v ? pct2(v) : ""}</td>; })}
                          <td className="r num" style={{ background: heatBg(monthTotals.tot ? nn(it.tot) / monthTotals.tot : null), color: heatText(monthTotals.tot ? nn(it.tot) / monthTotals.tot : null) }}>{monthTotals.tot ? pct2(nn(it.tot) / monthTotals.tot) : ""}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </React.Fragment>
              ))}
              <tr className="dt-total"><td className="l">Total</td>{months.map((mo) => <td key={mo.key} className="r num">100.00%</td>)}<td className="r num">100.00%</td></tr>
            </tbody></table></div>
        ) : <Skeleton h={220} />}
      </div>
    ),
    cat_detail: (<div className="card pm-compact-mx">
      <div className="pm-drill-toggle" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, opacity: 0.65 }}>Drill order</span>
        <div className="seg">
          <button className={"seg-btn" + (drillMode === "main" ? " on" : "")} onClick={() => setDrillMode("main")}>Category › Main Product › Item{drillMode === "main" && <span className="seg-pill" />}</button>
          <button className={"seg-btn" + (drillMode === "item" ? " on" : "")} onClick={() => setDrillMode("item")}>Category › Item{drillMode === "item" && <span className="seg-pill" />}</button>
        </div>
      </div>
      {detail.leaves.length ? <Matrix rows={detail.leaves} groupTotals={detail.groupTotals} grandTotalRow={detail.grand} groupKey="category" groupLabel="Menu Item Category" subKey={drillMode === "main" ? "main" : undefined} subLabel={drillMode === "main" ? "Main Product" : undefined} childKey="item" childLabel="Item" measures={detailMeasures} extraTotals={["qty_w", "qty_m", "qty_y"]} filename="Yelo-Product-Detail" /> : <Skeleton h={260} />}</div>),
    menucat: (<div className="card"><div className="card-head"><span className="card-title sm">Menu Item Category</span><span className="card-sub">Category Description → Option Parent (blank) · by qty</span></div>{menucat.length ? <EChart height={260} option={menuBar} /> : <Skeleton h={220} />}</div>),
    size: (<div className="card"><div className="card-head"><span className="card-title sm">Size Category</span></div>{size.length ? <EChart height={220} option={sizeDonut} /> : <Skeleton h={200} />}</div>),
    pizzatype: (<div className="card"><div className="card-head"><span className="card-title sm">Pizza Type</span><span className="card-sub">crust mix</span></div>{pizzatype.length ? <EChart height={220} option={typeDonut} /> : <Skeleton h={200} />}</div>),
    flavours: (<div className="card"><div className="card-head"><span className="card-title sm">Top Flavours</span></div>{flavours.length ? <EChart height={220} option={flavBar} /> : <Skeleton h={200} />}</div>),

    // ---- pizza analysis ----
    pz_flavour: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Flavour analysis</span><span className="card-sub">pizzas sold · sales · order share</span></div>
        {pzFlavour.length ? <DataGrid filename="Yelo-Flavours" columns={pzFlavCols} rows={pzFlavour} defaultSort={{ key: "sales", dir: "desc" }} rank /> : <Skeleton h={240} />}
      </div>
    ),
    pz_size: (<div className="card"><div className="card-head"><span className="card-title sm">Size mix</span><span className="card-sub">by net sales</span></div>{pzSize.length ? <EChart height={240} option={pzSizeDonut} /> : <Skeleton h={200} />}</div>),
    pz_dough: (<div className="card"><div className="card-head"><span className="card-title sm">Dough / crust mix</span><span className="card-sub">by net sales</span></div>{pzDough.length ? <EChart height={240} option={pzDoughDonut} /> : <Skeleton h={200} />}</div>),
    pz_flav_size: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Flavour × Size</span><span className="card-sub">quantity · shaded by row share</span></div>
        {flavSizePivot.rows.length ? (
          <div className="dt-wrap">
            <table className="dt pz-pivot">
              <thead><tr><th className="dt-th l">Flavour</th>{flavSizePivot.sizes.map((s) => <th key={s} className="dt-th r">{s.replace(/ Pizza$/, "")}</th>)}<th className="dt-th r">Total</th></tr></thead>
              <tbody>
                {flavSizePivot.rows.map((rw) => (
                  <tr key={rw.flavour}>
                    <td className="l">{rw.flavour}</td>
                    {flavSizePivot.sizes.map((s) => { const v = nn(rw[s]); const t = v / flavSizePivot.max; return (
                      <td key={s} className="r num" style={{ background: v ? `color-mix(in srgb, var(--accent) ${Math.round(t * 70) + 6}%, transparent)` : "transparent" }}>{v ? num(v) : "·"}</td>
                    ); })}
                    <td className="r num" style={{ fontWeight: 800 }}>{num(rw._tot)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Skeleton h={220} />}
      </div>
    ),
    pz_fsd: (
      <div className="card pm-compact-mx">
        <div className="card-head"><span className="card-title sm">Pizza drilldown</span><span className="card-sub">choose the order — flavour, size, crust (pizza type) in any combination</span></div>
        <div className="pz-order">
          <span className="pz-order-lbl">Drill order</span>
          {[0, 1, 2].map((i) => {
            const chosenElsewhere = pzOrder.filter((v, j) => v && j !== i);
            return (
              <select key={i} className="pz-sel" value={pzOrder[i] || ""}
                onChange={(e) => setPzOrder((o) => { const val = e.target.value; return o.map((v, j) => (j === i ? val : v === val ? "" : v)); })}>
                {i > 0 && <option value="">— none —</option>}
                {Object.entries(PZ_DIMS).filter(([v]) => v === pzOrder[i] || !chosenElsewhere.includes(v)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            );
          })}
        </div>
        {!pzGrid.length ? <Skeleton h={260} />
          : pzMx ? <Matrix rows={pzGrid} {...pzMx} measures={pzFsdMeasures} filename="Yelo-Pizza-Drilldown" />
          : pzOne ? <DataGrid columns={pzOneCols} rows={pzOne} filename="Yelo-Pizza-Level" defaultSort={{ key: "sales", dir: "desc" }} />
          : <div className="ops-empty-note">Pick at least one level.</div>}
      </div>
    ),
    pz_trend: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Flavour daily trend <span className="card-sub">top 6 · last 30 days</span></span>
          <div className="seg">
            <button className={"seg-btn" + (pzTrendMetric === "qty" ? " on" : "")} onClick={() => setPzTrendMetric("qty")}>Qty{pzTrendMetric === "qty" && <span className="seg-pill" />}</button>
            <button className={"seg-btn" + (pzTrendMetric === "sales" ? " on" : "")} onClick={() => setPzTrendMetric("sales")}>Sales{pzTrendMetric === "sales" && <span className="seg-pill" />}</button>
          </div>
        </div>
        {pzTrendOpt ? <EChart height={280} option={pzTrendOpt} /> : <Skeleton h={240} />}
      </div>
    ),
    pz_heat: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Crust × Flavour heatmap</span><span className="card-sub">pizzas sold — flavour (rows) × crust / pizza type (cols)</span></div>
        {pzHeatOpt ? <EChart height={Math.max(260, Math.min(520, (new Set(pzHeat.map((r) => r.flavour)).size) * 26 + 60))} option={pzHeatOpt} /> : <Skeleton h={260} />}
      </div>
    ),
    pz_halfhalf: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Half &amp; Half combinations</span><span className="card-sub">which flavours customers pick for each half</span></div>
        {pzHalf.length ? <DataGrid columns={pzHalfCols} rows={pzHalf} filename="Yelo-HalfHalf" defaultSort={{ key: "qty", dir: "desc" }} /> : <div className="ops-empty-note">No half-and-half flavour choices recorded for this selection.</div>}
      </div>
    ),
  };

  const widgets = [
    { id: "kpis", title: "KPIs", defaultW: 12, component: el.kpis, meta: { viz: "yp_kpis", measures: ["Quantity", "Net Sales", "Orders", "Pizza Qty", "AOV"], dims: [] } },
    { id: "new_items", title: "New Item Launch", defaultW: 6, component: el.new_items, meta: { viz: "yp_launch_detail", measures: ["Sales", "Qty", "Velocity", "Penetration %", "Is New Item (first sale in [start-30, end])"], dims: ["NewItemName", "Category"] } },
    { id: "hero", title: "Hero Items", defaultW: 6, component: el.hero, meta: { viz: "yp_hero", measures: ["Penetration %", "Velocity", "Sales", "Orders"], dims: ["NewItemName", "Category"] } },
    { id: "fbt", title: "Frequently Bought Together", defaultW: 6, component: el.fbt, meta: { viz: "yp_together", measures: ["Penetration % (co-purchase)", "Orders Together", "Selected Item Orders"], dims: ["NewItemName"] } },
    { id: "crossattach", title: "Cross-Sell & Attach", defaultW: 6, component: el.crossattach, meta: { viz: "yp_xa_cards", measures: ["Cross Sell Opportunity %", "Attach Opportunity %", "Add On Penetration %"], dims: ["NewItemName", "MAIN_ITEM", "ITEM_ROLE"] } },
    { id: "cat_perf", title: "Category Performance", defaultW: 6, component: el.cat_perf, meta: { viz: "yp_menucat", measures: ["Qty", "Sales", "Mix %"], dims: ["Menu Item Category"] } },
    { id: "bestsellers", title: "Bestsellers", defaultW: 6, component: el.bestsellers, meta: { viz: "yp_hero", measures: ["Sales", "Qty", "Penetration %", "Velocity"], dims: ["NewItemName", "Category"] } },
    { id: "sales_mix", title: "Category Sales Mix", defaultW: 12, component: el.sales_mix, meta: { viz: "yp_cat_month", measures: ["Sales Mix % by month"], dims: ["CategoryDescription", "Month"] } },
    { id: "cat_detail", title: "Product Mix Detail", defaultW: 12, component: el.cat_detail, meta: { viz: "yp_products", measures: ["Mix %", "Amount", "Qty (+WoW/MoM/YoY)", "Penetration %", "Velocity"], dims: ["Category", "NewItemName"] } },
    { id: "menucat", title: "Menu Item Category", defaultW: 6, component: el.menucat, meta: { viz: "yp_menucat", measures: ["Qty", "Sales"], dims: ["Menu Item Category"] } },
    { id: "pizzatype", title: "Pizza Type (crust)", defaultW: 6, component: el.pizzatype, meta: { viz: "yp_pizzatype", measures: ["Qty"], dims: ["PizzaCategory"] } },
    { id: "pz_size", title: "Pizza · Size mix", defaultW: 6, component: el.pz_size, meta: { viz: "yp_pz_size", measures: ["Sales"], dims: ["Category (size)"] } },
    { id: "pz_flavour", title: "Pizza · Flavour analysis", defaultW: 12, component: el.pz_flavour, meta: { viz: "yp_pz_flavour", measures: ["Sales", "Qty", "Incidence %"], dims: ["PizzaFlavour"] } },
    { id: "pz_fsd", title: "Pizza · Drilldown (reorderable)", defaultW: 12, component: el.pz_fsd, meta: { viz: "yp_pz_grid", measures: ["Sales", "Qty"], dims: ["PizzaFlavour", "Category", "PizzaCategory", "NewItemName"] } },
    { id: "pz_heat", title: "Pizza · Crust × Flavour heatmap", defaultW: 6, component: el.pz_heat, meta: { viz: "yp_pz_flav_crust", measures: ["Qty"], dims: ["PizzaFlavour", "PizzaCategory"] } },
    { id: "pz_trend", title: "Pizza · Flavour daily trend", defaultW: 6, component: el.pz_trend, meta: { viz: "yp_pz_flav_trend", measures: ["Qty", "Sales"], dims: ["VoucherDate", "PizzaFlavour"] } },
  ];

  return (
    <div className={cls("page pmix", loading)}>
      <UpdatingBar show={loading} brand="Yelo Pizza" />
      <div className="pm-filters stays-live">
        <span className="pm-filters-ic"><SlidersHorizontal size={15} /></span>
        <PmSelect label="Product" value={f.prod} options={lists.products} onChange={(v) => setF((x) => ({ ...x, prod: v }))} width={200} />
        <PmSelect label="Menu Category" value={f.menu} options={lists.menucats} onChange={(v) => setF((x) => ({ ...x, menu: v }))} width={170} />
        <PmSelect label="Size" value={f.size} options={lists.sizes} onChange={(v) => setF((x) => ({ ...x, size: v }))} width={140} />
        <PmSelect label="Pizza Type" value={f.crust} options={lists.crusts} onChange={(v) => setF((x) => ({ ...x, crust: v }))} width={140} />
        <PmSelect label="Flavour" value={f.flav} options={lists.flavours} onChange={(v) => setF((x) => ({ ...x, flav: v }))} />
        <PmSelect label="Source" value={f.src} options={lists.sources} onChange={(v) => setF((x) => ({ ...x, src: v }))} width={150} />
        <PmSelect label="Order Type" value={f.type} options={lists.types} onChange={(v) => setF((x) => ({ ...x, type: v }))} width={140} />
        <PmSelect label="Location" value={f.loc} options={lists.locations} onChange={(v) => setF((x) => ({ ...x, loc: v }))} width={140} />
        <PmSelect label="Combo Group" value={f.grp} options={lists.groups} onChange={(v) => setF((x) => ({ ...x, grp: v }))} width={160} />
        {anyFilter && <button className="pm-clear" onClick={() => setF({ prod: "", size: "", crust: "", flav: "", src: "", type: "", loc: "", grp: "", menu: "" })}><X size={12} /> Clear</button>}
      </div>

      <WidgetGrid dash="yelomix" widgets={widgets} isAdmin={isAdmin} role={role} />
    </div>
  );
}

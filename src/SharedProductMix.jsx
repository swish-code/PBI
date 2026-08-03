import React, { useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, X, SlidersHorizontal, Rocket, Star } from "lucide-react";
import { EChart, barOption, donutOption, lineOption, DeltaPill, Skeleton, DataGrid, Matrix } from "./ui.jsx";
import { selQuery, activeComparisons } from "./dates.js";
import { cls, UpdatingBar } from "./Updating.jsx";
import WidgetGrid from "./widgets/WidgetGrid.jsx";

const CRIT = ["sh_kpis", "sh_hero", "sh_launch_detail", "sh_menucat"];
const REST = ["sh_products", "sh_cat_month", "sh_cat_bucket", "sh_daypart", "sh_hourly"];
const SINGLES = new Set(["sh_kpis"]);

async function fetchBatch(names, q) {
  const res = await fetch(`/api/viz-batch?names=${names.join(",")}&${q}`, { credentials: "include" });
  const j = res.ok ? await res.json() : { results: {} };
  const out = {};
  for (const n of names) { const r = j.results ? j.results[n] : null; out[n] = r && r.row !== undefined ? r.row : r && r.rows !== undefined ? r.rows : (SINGLES.has(n) ? {} : []); }
  return out;
}
const fetchViz = (name, q) => fetch(`/api/viz/${name}?${q}`, { credentials: "include" }).then((r) => r.json()).then((j) => (j.row != null ? j.row : j.rows || [])).catch(() => []);

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
const RED = "#E9052A";
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

export default function SharedProductMix({ sel, chain, isAdmin = false, role = "" }) {
  const [d, setD] = useState({});
  const [loading, setLoading] = useState(true);
  const [lists, setLists] = useState({});
  const [f, setF] = useState({ prod: "", cat: "", src: "", type: "", loc: "", dp: "", bucket: "" });
  const [range, setRange] = useState(null);
  const [item, setItem] = useState("");
  const [sd, setSd] = useState(null);
  const [drill, setDrill] = useState({ cat: null, mains: [], mainsLoading: false, main: null, items: [], itemsLoading: false });
  const [mainCatMap, setMainCatMap] = useState({});

  const bq = `&shchain=${encodeURIComponent(chain || "")}`;
  const fq = useMemo(() => {
    const m = { shprod: f.prod, shcat: f.cat, shsrc: f.src, shtype: f.type, shloc: f.loc, shdp: f.dp, shbucket: f.bucket };
    return bq + Object.entries(m).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
  }, [f, chain]);
  const anyFilter = Object.values(f).some(Boolean);

  useEffect(() => { fetch(`/api/range?${selQuery(sel)}`, { credentials: "include" }).then((r) => r.json()).then(setRange).catch(() => {}); }, [sel]);
  useEffect(() => {
    const L = ["sh_l_products", "sh_l_cats", "sh_l_sources", "sh_l_types", "sh_l_locations", "sh_l_dayparts", "sh_l_buckets"];
    Promise.all(L.map((n) => fetchViz(n, `preset=today${bq}`).then((rows) => rows.map((r) => r.v).filter(Boolean)).catch(() => [])))
      .then(([products, cats, sources, types, locations, dayparts, buckets]) => setLists({ products, cats, sources, types, locations, dayparts, buckets }));
    fetchViz("sh_main_cats", "preset=today").then((rows) => { const m = {}; for (const r of rows) if (r.main && !m[r.main]) m[r.main] = r.category || "—"; setMainCatMap(m); }).catch(() => {});
  }, [chain]);
  useEffect(() => {
    let live = true; setLoading(true);
    fetchBatch(CRIT, selQuery(sel) + fq).then((m) => { if (live) { setD((p) => ({ ...p, ...m })); setLoading(false); } });
    fetchBatch(REST, selQuery(sel) + fq).then((m) => live && setD((p) => ({ ...p, ...m })));
    return () => { live = false; };
  }, [sel, fq]);
  useEffect(() => { if (!item) { setSd(null); return; } let live = true; fetchBatch(["sh_selected", "sh_together"], selQuery(sel) + fq + "&shitem=" + encodeURIComponent(item)).then((m) => live && setSd(m)); return () => { live = false; }; }, [item, sel, fq]);

  const cmps = useMemo(() => activeComparisons(range || {}), [range && range.start, range && range.end]);
  const months = useMemo(() => monthList(range), [range && range.start, range && range.end]);
  const k = d.sh_kpis || {};
  const hero = d.sh_hero || [], launches = d.sh_launch_detail || [], products = d.sh_products || [];
  const catMonth = d.sh_cat_month || [], daypart = d.sh_daypart || [], buckets = d.sh_buckets || [], hourly = d.sh_hourly || [];
  const menucatRaw = d.sh_menucat || [];
  const menucat = useMemo(() => { const t = menucatRaw.reduce((s, r) => s + nn(r.sales), 0) || 1; return menucatRaw.map((r) => ({ ...r, mix: nn(r.sales) / t })); }, [menucatRaw]);
  const selOrders = sd && sd.sh_selected && sd.sh_selected.orders;
  const together = (sd && sd.sh_together) || [];

  const toggleCat = (cat) => {
    if (drill.cat === cat) { setDrill({ cat: null, mains: [], main: null, items: [] }); return; }
    setDrill({ cat, mains: [], mainsLoading: true, main: null, items: [] });
    fetchViz("sh_cat_month_mains", selQuery(sel) + fq + "&shdrillcat=" + encodeURIComponent(cat)).then((rows) => setDrill((dd) => ({ ...dd, mains: rows, mainsLoading: false })));
  };
  const toggleMain = (cat, mainName) => {
    if (drill.main === mainName) { setDrill((dd) => ({ ...dd, main: null, items: [] })); return; }
    setDrill((dd) => ({ ...dd, main: mainName, items: [], itemsLoading: true }));
    fetchViz("sh_cat_month_items", selQuery(sel) + fq + "&shdrillcat=" + encodeURIComponent(cat) + "&shdrillmain=" + encodeURIComponent(mainName)).then((rows) => setDrill((dd) => ({ ...dd, items: rows, itemsLoading: false })));
  };

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
    { key: "mix", label: "Mix %", align: "r", render: (r) => pct2(r.mix) },
    ...cmps.map((c) => ({ key: "d" + c.key, label: c.short, align: "r", always: true, tip: `Net Sales ${c.label} — vs ${c.rangeText}`, render: (r) => <DeltaPill value={deltaOf(r.sales, r["sales" + DKEY[c.key]])} /> })),
  ];
  const bestCols = [
    { key: "item", label: "Item", align: "l" }, { key: "category", label: "Category", align: "l" },
    { key: "sales", label: "Net Sales", align: "r", render: (r) => money(r.sales) },
    { key: "qty", label: "Qty", align: "r", render: (r) => num(r.qty) },
    { key: "mix", label: "Mix %", align: "r", render: (r) => pct2(r.mix) },
  ];
  const detailMeasures = [
    { key: "mix", label: "Mix %", align: "r", total: true, render: (r) => pct2(r.mix) },
    { key: "amt", label: "Amount", align: "r", total: true, render: (r) => money(r.amt) },
    ...cmps.map((c) => ({ key: "d" + c.key, label: c.short, align: "r", always: true, tip: `Amount ${c.label} — vs ${c.rangeText}`, render: (r) => <DeltaPill value={deltaOf(r.amt, r["amt" + DKEY[c.key]])} /> })),
    { key: "qty", label: "Qty", align: "r", total: true, render: (r) => num(r.qty) },
    { key: "qtymix", label: "Qty Mix", align: "r", total: true, render: (r) => pct2(r.qtymix) },
  ];
  // leaves already carry server-side mix/amt/qty/qtymix; Matrix aggregates total-flagged measures for subtotals
  const detail = useMemo(() => ({ leaves: products.map((r) => ({ ...r, category: (r.main && mainCatMap[r.main]) || r.category || "—", main: r.main || "—" })) }), [products, mainCatMap]);
  const monthTotals = useMemo(() => { const t = {}; for (const r of catMonth) for (const mo of months) t[mo.key] = (t[mo.key] || 0) + nn(r[mo.key]); t.tot = catMonth.reduce((s, r) => s + nn(r.tot), 0); return t; }, [catMonth, months]);
  const bucketPivot = useMemo(() => {
    const rows = d.sh_cat_bucket || [];
    const byCat = {}, colTot = {}, bset = new Set();
    for (const r of rows) { bset.add(r.bucket); (byCat[r.category] = byCat[r.category] || {})[r.bucket] = nn(r.cnt); colTot[r.bucket] = (colTot[r.bucket] || 0) + nn(r.cnt); }
    const bkts = [...bset].sort((a, b) => { const na = parseFloat(a), nb = parseFloat(b); return (isFinite(na) ? na : 1e9) - (isFinite(nb) ? nb : 1e9); });
    const cats = Object.entries(byCat).map(([c, m]) => ({ cat: c, vals: m, total: bkts.reduce((s, b) => s + (m[b] || 0), 0) })).sort((a, b) => b.total - a.total);
    return { cats, colTot, bkts, grandTot: bkts.reduce((s, b) => s + (colTot[b] || 0), 0) };
  }, [d.sh_cat_bucket]);

  const penBar = (rows) => { const o = barOption({ data: rows.slice(0, 14).map((r) => ({ label: r.item, value: nn(r.pen) })), horizontal: true, inverse: true, color: RED }); if (o.xAxis) o.xAxis.axisLabel = { ...(o.xAxis.axisLabel || {}), formatter: (v) => Math.round(nn(v) * 100) + "%" }; o.tooltip = { ...(o.tooltip || {}), valueFormatter: (v) => (nn(v) * 100).toFixed(1) + "%" }; return o; };
  const menuBar = useMemo(() => barOption({ data: menucat.slice(0, 12).map((r) => ({ label: r.label, value: nn(r.qty) })), horizontal: true, inverse: true, fmt: num, color: "#2E90FA" }), [menucat]);
  const daypartDonut = useMemo(() => donutOption({ data: daypart.map((r) => ({ label: r.label || "—", value: nn(r.sales) })), fmt: money, colors: COLORS }), [daypart]);
  const bucketBar = useMemo(() => barOption({ data: buckets.map((r) => ({ label: r.label, value: nn(r.orders) })), horizontal: false, fmt: num, color: "#7A5AF8" }), [buckets]);
  const hourlyOpt = useMemo(() => lineOption({ data: hourly.map((r) => ({ x: nn(r.hour) + "h", value: nn(r.orders) })), fmt: num, color: "#2E90FA" }), [hourly]);

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
              {gr != null && <span className={`pm-mini-g ${gr >= 0 ? "up" : "down"}`}>{signPct(gr)}</span>}
            </div>); })}</div>
        ) : (loading ? <Skeleton h={140} /> : <div className="dt-empty sm">No new items in this period.</div>)}
      </div>
    ),
    hero: (
      <div className="card">
        <div className="card-head"><span className="card-title sm"><Star size={14} style={{ color: "#F5B301", verticalAlign: "-2px", marginRight: 5 }} />Hero Items</span><span className="card-sub">top penetration &amp; velocity</span></div>
        {hero.length ? (
          <div className="pm-mini-list">{hero.slice(0, 8).map((h, i) => (
            <div key={h.item + i} className="pm-mini">
              <span className="pm-mini-av rank" style={{ background: COLORS[i % COLORS.length] }}>{i + 1}</span>
              <div className="pm-mini-hd"><b title={h.item}>{h.item}</b><span>{h.category || "—"}</span></div>
              <div className="pm-mini-kpis"><div><span>Rev</span><b>{money(h.sales)}</b></div><div><span>Pen</span><b>{pct(h.pen)}</b></div><div><span>Vel</span><b>{num(h.vel)}</b></div></div>
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
    cat_perf: (<div className="card"><div className="card-head"><span className="card-title sm">Category Performance</span></div>{loading ? <Skeleton h={220} /> : <DataGrid columns={catCols} rows={menucat} filename="Categories" defaultSort={{ key: "sales", dir: "desc" }} rank={false} />}</div>),
    bestsellers: (<div className="card"><div className="card-head"><span className="card-title sm">Bestsellers</span></div>{hero.length ? <DataGrid columns={bestCols} rows={hero} filename="Bestsellers" defaultSort={{ key: "qty", dir: "desc" }} /> : <Skeleton h={220} />}</div>),
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
    cat_detail: (<div className="card pm-compact-mx">{detail.leaves.length ? <Matrix rows={detail.leaves} groupKey="category" groupLabel="Category" subKey="main" subLabel="Main Product" childKey="item" childLabel="Item" measures={detailMeasures} filename="Category-Detail" /> : <Skeleton h={260} />}</div>),
    cat_bucket: (
      <div className="card">
        <div className="card-head"><span className="card-title sm">Category × Order-Value Bucket</span><span className="card-sub">% of orders per net-sales bucket (column)</span></div>
        {bucketPivot.cats.length ? (
          <div className="dt-wrap pm-heat-wrap"><table className="dt pm-bucket">
            <thead><tr><th className="dt-th l">Category</th>{bucketPivot.bkts.map((b) => <th key={b} className="dt-th r">{b}</th>)}<th className="dt-th r">Total</th></tr></thead>
            <tbody>
              {bucketPivot.cats.map((row) => (<tr key={row.cat}><td className="l">{row.cat}</td>
                {bucketPivot.bkts.map((b) => { const ct = bucketPivot.colTot[b], v = ct ? (row.vals[b] || 0) / ct : null; return <td key={b} className="r num">{v ? pct2(v) : ""}</td>; })}
                <td className="r num">{bucketPivot.grandTot ? pct2(row.total / bucketPivot.grandTot) : ""}</td></tr>))}
              <tr className="dt-total"><td className="l">Total</td>{bucketPivot.bkts.map((b) => <td key={b} className="r num">{bucketPivot.colTot[b] ? "100.00%" : ""}</td>)}<td className="r num">100.00%</td></tr>
            </tbody></table></div>
        ) : <Skeleton h={220} />}
      </div>
    ),
    menucat: (<div className="card"><div className="card-head"><span className="card-title sm">Category</span><span className="card-sub">by quantity</span></div>{menucat.length ? <EChart height={260} option={menuBar} /> : <Skeleton h={220} />}</div>),
    daypart: (<div className="card"><div className="card-head"><span className="card-title sm">Day-part Split</span></div>{daypart.length ? <EChart height={220} option={daypartDonut} /> : <Skeleton h={200} />}</div>),
    buckets: (<div className="card"><div className="card-head"><span className="card-title sm">Order-Value Buckets</span><span className="card-sub">orders per net-sales bucket</span></div>{buckets.length ? <EChart height={220} option={bucketBar} /> : <Skeleton h={200} />}</div>),
    hourly: (<div className="card"><div className="card-head"><span className="card-title sm">Hourly Orders</span></div>{hourly.length ? <EChart height={220} option={hourlyOpt} /> : <Skeleton h={200} />}</div>),
  };

  const widgets = [
    { id: "kpis", title: "KPIs", defaultW: 12, component: el.kpis, meta: { viz: "sh_kpis", measures: ["Quantity", "Net Sales", "Orders", "AOV"], dims: [] } },
    { id: "new_items", title: "New Item Launch", defaultW: 6, component: el.new_items, meta: { viz: "sh_launch_detail", measures: ["Sales", "Qty", "Velocity", "Is New (first sale in [start-30, end])"], dims: ["ProductName_Fixed_Option", "Category"] } },
    { id: "hero", title: "Hero Items", defaultW: 6, component: el.hero, meta: { viz: "sh_hero", measures: ["Penetration %", "Velocity", "Sales", "Orders"], dims: ["ProductName_Fixed_Option", "Category"] } },
    { id: "fbt", title: "Frequently Bought Together", defaultW: 6, component: el.fbt, meta: { viz: "sh_together", measures: ["Co-purchase penetration", "Orders together"], dims: ["ProductName_Fixed_Option"] } },
    { id: "cat_perf", title: "Category Performance", defaultW: 6, component: el.cat_perf, meta: { viz: "sh_menucat", measures: ["Qty", "Sales", "Mix %"], dims: ["Category"] } },
    { id: "bestsellers", title: "Bestsellers", defaultW: 6, component: el.bestsellers, meta: { viz: "sh_hero", measures: ["Sales", "Qty", "Penetration %", "Velocity"], dims: ["ProductName_Fixed_Option", "Category"] } },
    { id: "sales_mix", title: "Category Sales Mix", defaultW: 12, component: el.sales_mix, meta: { viz: "sh_cat_month", measures: ["Sales Mix % by month"], dims: ["Category", "Main Product", "Item", "Month"] } },
    { id: "cat_detail", title: "Category Detail", defaultW: 12, component: el.cat_detail, meta: { viz: "sh_products", measures: ["Mix %", "Amount (+WoW/MoM/YoY)", "Qty", "Qty Mix"], dims: ["Category", "Main Product", "Item"] } },
    { id: "cat_bucket", title: "Category × Order-Value Bucket", defaultW: 12, component: el.cat_bucket, meta: { viz: "sh_cat_bucket", measures: ["DISTINCTCOUNT(KEY) as % of column"], dims: ["Category", "NETSALES_BUCKET"] } },
    { id: "menucat", title: "Category Sales Mix (chart)", defaultW: 4, component: el.menucat, meta: { viz: "sh_menucat", measures: ["Qty"], dims: ["Category"] } },
    { id: "daypart", title: "Day-part Split", defaultW: 4, component: el.daypart, meta: { viz: "sh_daypart", measures: ["Sales", "Orders"], dims: ["DAY_PART"] } },
    { id: "hourly", title: "Hourly Velocity", defaultW: 4, component: el.hourly, meta: { viz: "sh_hourly", measures: ["Orders", "Sales"], dims: ["HOUR"] } },
  ];

  return (
    <div className={cls("page pmix", loading)}>
      <UpdatingBar show={loading} brand={chain || "all"} />
      <div className="pm-filters stays-live">
        <span className="pm-filters-ic"><SlidersHorizontal size={15} /></span>
        <PmSelect label="Product" value={f.prod} options={lists.products} onChange={(v) => setF((x) => ({ ...x, prod: v }))} width={200} />
        <PmSelect label="Category" value={f.cat} options={lists.cats} onChange={(v) => setF((x) => ({ ...x, cat: v }))} width={160} />
        <PmSelect label="Source" value={f.src} options={lists.sources} onChange={(v) => setF((x) => ({ ...x, src: v }))} width={150} />
        <PmSelect label="Order Type" value={f.type} options={lists.types} onChange={(v) => setF((x) => ({ ...x, type: v }))} width={140} />
        <PmSelect label="Location" value={f.loc} options={lists.locations} onChange={(v) => setF((x) => ({ ...x, loc: v }))} width={140} />
        <PmSelect label="Day-part" value={f.dp} options={lists.dayparts} onChange={(v) => setF((x) => ({ ...x, dp: v }))} width={140} />
        <PmSelect label="Value Bucket" value={f.bucket} options={lists.buckets} onChange={(v) => setF((x) => ({ ...x, bucket: v }))} width={140} />
        {anyFilter && <button className="pm-clear" onClick={() => setF({ prod: "", cat: "", src: "", type: "", loc: "", dp: "", bucket: "" })}><X size={12} /> Clear</button>}
      </div>

      <WidgetGrid dash={`shared-${chain}`} widgets={widgets} isAdmin={isAdmin} role={role} />
    </div>
  );
}

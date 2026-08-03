// ============================================================================
//  HOME WIDGET CATALOG — self-contained widgets for the customizable "Home"
//  screen. Each fetches its own data from the viz API given the active
//  {sel, brand} filters, so it can be dropped into any WidgetGrid slot.
// ============================================================================
import React, { useState, useEffect, useMemo } from "react";
import { selQuery } from "../dates.js";
import { EChart, Skeleton } from "../ui.jsx";
import { kd, num, kdc, T, tooltipBase, kk } from "../theme.js";

const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const has = (v) => v !== null && v !== undefined && v !== "";

// fetch a viz for the current filters
function useViz(name, sel, brand, extra) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true; setData(null);
    const qs = selQuery(sel) + (brand && brand !== "all" ? `&brand=${encodeURIComponent(brand)}` : "") + (extra || "");
    fetch(`/api/viz/${name}?${qs}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setData(j ? (j.row != null ? j.row : (j.rows || [])) : null); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [name, sel, brand, extra]);
  return data;
}

const Loading = ({ h = 120 }) => <div style={{ padding: 12 }}><Skeleton h={h} /></div>;
const Empty = ({ msg = "No data for this selection." }) => <div className="wgw-empty">{msg}</div>;

// ---- KPI summary (Net Sales / Orders / AOV / Gap) --------------------------
function KpiStrip({ sel, brand }) {
  const d = useViz("landing_head", sel, brand);
  if (!d) return <Loading h={70} />;
  const cards = [
    { l: "Net Sales", v: kd(d.netSales) },
    { l: "Orders", v: num(d.orders) },
    { l: "Avg Ticket", v: kdc(d.aov) },
    { l: "Gap to Target", v: kd(d.gapKD) },
  ];
  return <div className="wgw-kpis">{cards.map((c) => (
    <div key={c.l} className="wgw-kpi"><span className="wgw-kpi-l">{c.l}</span><b className="wgw-kpi-v">{c.v}</b></div>
  ))}</div>;
}

// ---- Hourly sales bar chart -------------------------------------------------
function HourlySales({ sel, brand }) {
  const rows = useViz("landing_hourly", sel, brand);
  const option = useMemo(() => {
    const r = [...(rows || [])].sort((a, b) => Number(a.x) - Number(b.x));
    const fmtHour = (h) => { const n = Number(h) % 24; return `${n % 12 || 12}${n < 12 ? "am" : "pm"}`; };
    const data = r.map((x) => {
      const v = nn(x.value), avg = nn(x.last4);
      let color = "var(--line-2)";
      if (avg > 0) { if (v >= avg * 1.05) color = T.pos; else if (v <= avg * 0.95) color = T.red; }
      return { value: v, itemStyle: { color, borderRadius: [4, 4, 0, 0] } };
    });
    return {
      grid: { left: 4, right: 6, top: 10, bottom: 16, containLabel: true },
      tooltip: { ...tooltipBase, trigger: "axis" },
      xAxis: { type: "category", data: r.map((x) => fmtHour(x.x)), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 9.5, interval: 2 } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: T.line, type: "dashed" } }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 9.5, formatter: kk } },
      series: [{ type: "bar", data, barWidth: "58%" }],
    };
  }, [rows]);
  if (!rows) return <Loading h={160} />;
  if (!rows.length) return <Empty />;
  return <EChart height={180} option={option} />;
}

// ---- Prep & delivery by branch (ops) ---------------------------------------
function OpsByBranch({ sel, brand }) {
  const rows = useViz("ops_by_location", sel, brand);
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty msg="Select a brand to see branches." />;
  const top = [...rows].sort((a, b) => nn(b.net) - nn(a.net)).slice(0, 8);
  return (
    <table className="wgw-table">
      <thead><tr><th>Branch</th><th className="r">Prep</th><th className="r">Delivery</th><th className="r">Orders</th></tr></thead>
      <tbody>{top.map((r, i) => (
        <tr key={i}><td>{r.label}</td><td className="r">{has(r.prep) ? nn(r.prep).toFixed(1) + "m" : "—"}</td>
          <td className="r">{has(r.delivery) ? nn(r.delivery).toFixed(1) + "m" : "—"}</td><td className="r">{num(r.orders)}</td></tr>
      ))}</tbody>
    </table>
  );
}

// ---- Top branches by net sales ---------------------------------------------
function TopBranches({ sel, brand }) {
  const rows = useViz("ops_by_location", sel, brand);
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty msg="Select a brand to see branches." />;
  const top = [...rows].sort((a, b) => nn(b.net) - nn(a.net)).slice(0, 8);
  const max = nn(top[0]?.net) || 1;
  return (
    <div className="wgw-bars">{top.map((r, i) => (
      <div key={i} className="wgw-bar">
        <span className="wgw-bar-n">{r.label}</span>
        <span className="wgw-bar-track"><span className="wgw-bar-fill" style={{ width: `${(nn(r.net) / max) * 100}%` }} /></span>
        <span className="wgw-bar-v">{kd(r.net)}</span>
      </div>
    ))}</div>
  );
}

// ---- Yesterday story --------------------------------------------------------
function StoryCard({ sel, brand }) {
  const d = useViz("landing_story", sel, brand);
  if (!d) return <Loading h={70} />;
  const lines = [d.headline, d.brand, d.outlook].filter(Boolean);
  if (!lines.length) return <Empty msg="No story for this selection." />;
  return <div className="wgw-story">{lines.map((t, i) => <p key={i}>{t}</p>)}</div>;
}

// The catalog. `Comp` receives {sel, brand}. HomeScreen wraps each into WidgetGrid's shape.
export const HOME_WIDGETS = [
  { id: "home_kpis", title: "KPI Summary", defaultW: 12, sizes: [6, 8, 12], page: "Dashboard", viz: "landing_head", Comp: KpiStrip, defaultHidden: false },
  { id: "home_hourly", title: "Hourly Sales", defaultW: 8, sizes: [6, 8, 12], page: "Dashboard", viz: "landing_hourly", Comp: HourlySales, defaultHidden: false },
  { id: "home_story", title: "Yesterday Insight", defaultW: 4, sizes: [4, 6], page: "Dashboard", viz: "landing_story", Comp: StoryCard, defaultHidden: false },
  { id: "home_topbranches", title: "Top Branches", defaultW: 6, sizes: [4, 6, 8], page: "Operations", viz: "ops_by_location", Comp: TopBranches, defaultHidden: true },
  { id: "home_opsbranch", title: "Prep & Delivery by Branch", defaultW: 6, sizes: [6, 8, 12], page: "Operations", viz: "ops_by_location", Comp: OpsByBranch, defaultHidden: true },
];

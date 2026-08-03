// ============================================================================
//  STORE LANDING — a dedicated home for Store Users (single store).
//  Every query is scope-filtered server-side to the user's assigned brand+store,
//  so these standard viz endpoints already return store-only data.
// ============================================================================
import React, { useState, useEffect, useMemo } from "react";
import { EChart, Skeleton, DeltaPill, gaugeOption } from "./ui.jsx";
import { kd, kdc, num, T, tooltipBase } from "./theme.js";
import { selQuery, presetLabel, activeComparisons } from "./dates.js";

const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const has = (v) => v !== null && v !== undefined && v !== "";
const minF = (v) => (has(v) ? nn(v).toFixed(1) + "m" : "—");
const pctF = (v) => (has(v) ? (nn(v) * 100).toFixed(1) + "%" : "—");
const rateF = (v) => (has(v) ? nn(v).toFixed(2) : "—");

async function viz(name, qs) {
  const r = await fetch(`/api/viz/${name}?${qs}`, { credentials: "include" });
  if (!r.ok) return null;
  const j = await r.json();
  return j.row != null ? j.row : (j.rows != null ? j.rows : j.data);
}

const OPS = [
  { key: "prep", label: "Avg Prep Time", fmt: minF, lower: true, unit: "min" },
  { key: "delivery", label: "Avg Delivery", fmt: minF, lower: true, unit: "min" },
  { key: "complaint", label: "Complaint Ratio", fmt: pctF, lower: true, unit: "pct" },
  { key: "offline", label: "Offline Rate", fmt: pctF, lower: true, unit: "pct" },
  { key: "rating", label: "Rating", fmt: rateF, lower: false, unit: "num" },
];

export default function StoreLanding({ sel, resolved, brand, userName = "", store = "" }) {
  const [head, setHead] = useState(null);
  const [ops, setOps] = useState(null);
  const [today, setToday] = useState(null);
  const [mtd, setMtd] = useState(null);
  const [trend, setTrend] = useState([]);
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(true);

  const bq = brand && brand !== "all" ? "&brand=" + encodeURIComponent(brand) : "";
  const comps = activeComparisons(resolved || {});
  const primary = comps[0] || { key: "w", label: "vs last week" };

  useEffect(() => {
    let live = true; setLoading(true);
    const q = selQuery(sel) + bq;
    Promise.all([
      viz("landing_head", q), viz("landing_ops", q), viz("ov_daily", q),
      viz("landing_head", "preset=today" + bq), viz("landing_head", "preset=this_month" + bq),
      fetch("/api/ops-targets", { credentials: "include" }).then((r) => r.json()).catch(() => ({ targets: {} })),
    ]).then(([h, o, d, t, m, tg]) => {
      if (!live) return;
      setHead(h || {}); setOps(o || {}); setTrend(Array.isArray(d) ? d : []);
      setToday(t || {}); setMtd(m || {}); setTargets((tg && tg.targets) || {});
      setLoading(false);
    }).catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [sel, brand]);

  const achievement = head && head.target > 0 ? (nn(head.netSales) / nn(head.target)) * 100 : 0;
  const storeTargets = targets[store] || {};

  // derived alerts
  const alerts = useMemo(() => {
    const a = [];
    if (head && head.target > 0 && nn(head.netSales) < nn(head.target)) a.push({ tone: "bad", t: "Below sales target", d: `${kd(nn(head.target) - nn(head.netSales))} short of ${kd(head.target)}` });
    OPS.forEach((k) => {
      const act = ops ? ops[k.key] : null; const tg = storeTargets[k.key];
      if (has(act) && tg != null) { const miss = k.lower ? nn(act) - tg : tg - nn(act); if (miss > 0.0001) a.push({ tone: "bad", t: `${k.label} off target`, d: `${k.fmt(act)} vs target ${k.fmt(tg)}` }); }
    });
    if (ops && has(ops.complaint) && nn(ops.complaint) > 0.02) a.push({ tone: "bad", t: "High complaint rate", d: pctF(ops.complaint) });
    return a.slice(0, 5);
  }, [head, ops, storeTargets]);

  const trendOpt = useMemo(() => {
    const rows = [...(trend || [])];
    return {
      grid: { left: 6, right: 10, top: 14, bottom: 20, containLabel: true },
      tooltip: { ...tooltipBase, trigger: "axis" },
      xAxis: { type: "category", data: rows.map((r) => String(r.x || "").slice(5)), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 10 } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: T.line, type: "dashed" } }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 10, formatter: (v) => (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v) } },
      series: [
        { name: "Net Sales", type: "line", smooth: true, showSymbol: false, data: rows.map((r) => nn(r.net)), lineStyle: { width: 2.5, color: T.accent }, areaStyle: { color: "rgba(18,183,106,.12)" } },
        { name: "Target", type: "line", smooth: true, showSymbol: false, data: rows.map((r) => nn(r.target)), lineStyle: { width: 1.5, color: T.muted, type: "dashed" } },
      ],
    };
  }, [trend]);

  const kpi = (label, value, delta, sub) => (
    <div className="card sl-kpi">
      <span className="uplabel">{label}</span>
      {loading ? <Skeleton w="60%" h={24} /> : <span className="sl-kpi-v">{value}</span>}
      {!loading && delta !== undefined && <span className="sl-kpi-d"><DeltaPill value={delta} /><small>{sub || primary.label}</small></span>}
      {!loading && sub && delta === undefined && <span className="sl-kpi-sub">{sub}</span>}
    </div>
  );

  return (
    <div className="page store-land">
      <div className="sl-head">
        <div><h2>{store || "Your Store"}{brand && brand !== "all" ? ` · ${brand}` : ""}</h2><p>Store performance · {presetLabel(sel)}</p></div>
      </div>

      {/* KPI hero */}
      <div className="sl-kpis">
        <div className="card sl-kpi sl-hero">
          <span className="uplabel">Net Sales · {presetLabel(sel)}</span>
          {loading ? <Skeleton w="60%" h={28} /> : <span className="sl-kpi-v">{kd(head?.netSales)}</span>}
          {!loading && <span className="sl-kpi-d"><DeltaPill value={delta(head?.netSales, head?.[`netSales_${primary.key}`])} /><small>{primary.label}</small></span>}
        </div>
        {kpi("Daily Sales (today)", loading ? "" : kd(today?.netSales))}
        {kpi("MTD Sales", loading ? "" : kd(mtd?.netSales))}
        {kpi("Orders", loading ? "" : num(head?.orders), delta(head?.orders, head?.[`orders_${primary.key}`]))}
        {kpi("Avg Ticket", loading ? "" : kdc(head?.aov), delta(head?.aov, head?.[`aov_${primary.key}`]))}
        <div className="card sl-kpi sl-gauge">
          <span className="uplabel">Target Achievement</span>
          {loading ? <Skeleton w={70} h={70} style={{ borderRadius: "50%", margin: "2px auto" }} /> : <EChart height={110} option={gaugeOption({ value: achievement })} />}
        </div>
      </div>

      <div className="sl-grid">
        {/* Sales trend */}
        <div className="card sl-trend">
          <div className="sl-card-h"><b>Sales Trend</b><span>Net sales vs daily target</span></div>
          {loading ? <Skeleton h={220} /> : trend.length ? <EChart height={240} option={trendOpt} /> : <div className="sl-empty">No trend for this period.</div>}
        </div>

        {/* AI insight + alerts */}
        <div className="sl-side">
          <div className="card sl-ai">
            <div className="sl-card-h"><b>AI Insight</b></div>
            {loading ? <Skeleton h={60} /> : <p className="sl-ai-txt">{head?.insight || "No notable movements for this period."}</p>}
            {!loading && head?.gapText && <div className="sl-ai-tag">Forecast: {head.forecastClosing ? kd(head.forecastClosing) : "—"} · {head.gapText} vs target</div>}
          </div>
          <div className="card sl-alerts">
            <div className="sl-card-h"><b>Alerts</b><span>{alerts.length} needing action</span></div>
            {loading ? <Skeleton h={80} /> : alerts.length ? alerts.map((a, i) => (
              <div key={i} className="sl-alert"><span className="sl-alert-t">{a.t}</span><span className="sl-alert-d">{a.d}</span></div>
            )) : <div className="sl-empty">✓ All metrics on track.</div>}
          </div>
        </div>
      </div>

      {/* Operational metrics vs targets */}
      <div className="card sl-ops">
        <div className="sl-card-h"><b>Operational Metrics</b><span>actual vs your targets</span></div>
        <div className="sl-ops-grid">
          {OPS.map((k) => {
            const act = ops ? ops[k.key] : null; const tg = storeTargets[k.key];
            let tone = "", miss = null;
            if (has(act) && tg != null) { miss = k.lower ? nn(act) - tg : tg - nn(act); tone = miss > 0.0001 ? "bad" : "ok"; }
            return (
              <div key={k.key} className={`sl-op ${tone}`}>
                <span className="uplabel">{k.label}</span>
                {loading ? <Skeleton w="50%" h={20} /> : <span className="sl-op-v">{k.fmt(act)}</span>}
                {!loading && (tg != null
                  ? <span className={`sl-op-t ${tone}`}>{tone === "bad" ? `▲ ${k.unit === "pct" ? (Math.abs(miss) * 100).toFixed(1) + "pp" : Math.abs(miss).toFixed(k.unit === "num" ? 2 : 1)} ${k.lower ? "over" : "under"}` : "✓ on target"} · tgt {k.fmt(tg)}</span>
                  : <span className="sl-op-t">no target set</span>)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function delta(cur, prev) { const c = Number(cur), p = Number(prev); if (!isFinite(c) || !isFinite(p) || p === 0) return null; return (c - p) / Math.abs(p); }

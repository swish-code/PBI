import React, { useState, useEffect, useMemo } from "react";
import { Card, Kpi, Hero, EChart, barOption, DataGrid, Pill, Logo, Rise, Skeleton } from "./ui.jsx";
import { kd, kdc, num, T } from "./theme.js";
import { brandColorOf } from "./logos.js";
import { selBody, presetLabel } from "./dates.js";
import { cls, UpdatingBar } from "./Updating.jsx";

async function fetchScorecard(role, sel, brand) {
  const res = await fetch("/api/dax", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template: "brandScorecard", role, brand, ...selBody(sel) }),
  });
  if (!res.ok) throw new Error("failed");
  return res.json();
}

const parsePct = (t) => { const n = parseFloat(String(t).replace(/[^\d.\-]/g, "")); return isNaN(n) ? 0 : n / 100; };

export default function ScorecardPage({ role, sel, brand: gbrand = "all" }) {
  const [data, setData] = useState({ brands: [], total: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchScorecard(role, sel, gbrand).then((d) => { if (live) { setData({ brands: (d.brands || []).map((b) => ({ ...b, _k: b.brand })), total: d.total }); setLoading(false); } })
      .catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [role, sel, gbrand]);

  const total = data.total;
  const chart = useMemo(() => [...data.brands].sort((a, b) => b.netSales - a.netSales).slice(0, 15)
    .map((b) => ({ label: b.brand, value: b.netSales })), [data.brands]);

  const columns = [
    { key: "brand", label: "Brand", align: "l", type: "text", total: true, render: (r) => <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Logo name={r.brand} /><span style={{ fontWeight: 700 }}>{r.brand}</span></div> },
    { key: "netSales", label: "Net Sales", align: "r", type: "kd", total: true },
    { key: "dailyTarget", label: "Daily Target", align: "r", type: "kd", total: true },
    { key: "varianceText", label: "Variance", align: "r", type: "pct", total: true },
    { key: "runrate", label: "Runrate", align: "r", type: "kd", total: true },
    { key: "aov", label: "AOV", align: "r", type: "kdc", total: true },
    { key: "growthWoWText", label: "Growth WoW", align: "r", type: "pct", total: true },
    { key: "growthYoYText", label: "Growth YoY", align: "r", type: "pct", total: true },
  ];

  return (
    <div className={cls("page", loading)}>
      <UpdatingBar show={loading} brand={gbrand} />
      <div className="grid" style={{ gridTemplateColumns: "1.5fr 1fr 1fr", marginBottom: 16 }}>
        <Hero index={0} dark label="Total Net Sales" value={total?.netSales || 0} format={kd}
          deltaValue={total ? parsePct(total.varianceText) : 0} sub="vs daily target" />
        <Kpi index={1} label="Transactions" value={total?.orders || 0} format={num} live loading={loading && !total} sub="orders today" />
        <Kpi index={2} label="Avg Ticket (AOV)" value={total?.aov || 0} format={kdc} loading={loading && !total} sub="per order" />
      </div>

      <Card index={3} style={{ marginBottom: 16 }}>
        <div className="card-head"><span className="card-title">Net sales by brand</span><span className="uplabel">{presetLabel(sel)}</span></div>
        {loading && !chart.length ? <Skeleton h={280} /> : <EChart height={Math.max(220, chart.length * 30 + 30)} option={barOption({ data: chart, horizontal: true, fmt: kd, colors: chart.map((c) => brandColorOf(c.label)) })} />}
      </Card>

      <Card index={4}>
        <DataGrid columns={columns} rows={data.brands} totalRow={total} filename="brand-scorecard" defaultSort={{ key: "netSales", dir: "desc" }} />
      </Card>
    </div>
  );
}

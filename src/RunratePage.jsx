import React, { useState, useEffect, useMemo } from "react";
import { EChart, multiLineOption, Skeleton } from "./ui.jsx";
import { T } from "./theme.js";
import { selQuery } from "./dates.js";
import { cls, UpdatingBar } from "./Updating.jsx";
import { VisualFeedback, PageFeedback } from "./engagement.jsx";

const NAMES = ["rr_kpis", "rr_daily"];
async function fetchViz(name, sel, bq) {
  const res = await fetch(`/api/viz/${name}?${selQuery(sel)}${bq}`, { credentials: "include" });
  if (!res.ok) throw new Error(name);
  const j = await res.json();
  return j.row != null ? j.row : j.rows || [];
}
const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const nz = (v) => { const n = Number(v); return n ? n : null; };
const g = (v) => Math.round(nn(v)).toLocaleString("en-US");
const dayLabel = (iso) => { const [, m, d] = String(iso).slice(0, 10).split("-"); return `${+d}/${+m}`; };
// growth values are sometimes text ("13.19%", "+96,383"), sometimes numeric ratios
const asPct = (v) => { if (v == null || v === "") return "—"; if (typeof v === "string") return v; const n = Number(v); return (Math.abs(n) <= 1 ? (n * 100).toFixed(2) : n.toFixed(2)) + "%"; };
const signOf = (v) => { const s = String(v ?? ""); if (/(^|[^0-9])-/.test(s) || Number(v) < 0) return -1; const n = parseFloat(s.replace(/[^\d.\-]/g, "")); return n > 0 ? 1 : 0; };
const GC_UP = "#12B76A", GC_DOWN = "#F04438";
const gc = (v) => (signOf(v) < 0 ? GC_DOWN : GC_UP);
const Tri = ({ v }) => { const s = signOf(v); if (s === 0) return null; return <span style={{ color: s > 0 ? GC_UP : GC_DOWN, fontSize: 12 }}>{s > 0 ? "▲" : "▼"}</span>; };

// one big metric line inside a stacked card
const Metric = ({ value, label, color, tri }) => (
  <div className="rr2-metric">
    <span className="rr2-val" style={color ? { color } : undefined}>{value}</span>
    <div className="rr2-mrow"><span className="rr2-lbl">{label}</span>{tri !== undefined && <Tri v={tri} />}</div>
  </div>
);
// sub-metric pair under a big metric (label + % + triangle)
const Sub = ({ label, val }) => (
  <div className="rr2-sub"><span className="rr2-sub-lbl">{label}</span><span className="rr2-sub-val" style={{ color: gc(val) }}>{asPct(val)}</span><Tri v={val} /></div>
);
const Strip = ({ label, val }) => (
  <div className="card rr2-strip"><span className="rr2-strip-lbl">{label}</span><div className="rr2-strip-r"><span className="rr2-strip-val" style={{ color: gc(val) }}>{asPct(val)}</span><Tri v={val} /></div></div>
);

export default function RunratePage({ sel, brand: gbrand = "all", role }) {
  // Area managers see ONLY the Forecast-Branch runrate scoped to their locations —
  // not the company-wide live runrate. Everyone else sees both.
  const areaOnly = role === "area";
  const [d, setD] = useState({});
  const [loading, setLoading] = useState(true);
  const bq = gbrand && gbrand !== "all" ? "&brand=" + encodeURIComponent(gbrand) : "";

  useEffect(() => {
    if (areaOnly) { setLoading(false); return; }   // skip the live-runrate queries entirely
    let live = true; setLoading(true);
    Promise.all(NAMES.map((n) => fetchViz(n, sel, bq).then((r) => [n, r]).catch(() => [n, n === "rr_kpis" ? {} : []])))
      .then((pairs) => { if (live) { setD(Object.fromEntries(pairs)); setLoading(false); } });
    return () => { live = false; };
  }, [sel, gbrand, areaOnly]);

  const k = d.rr_kpis || {};
  const rows = d.rr_daily || [];
  const actRows = rows.filter((r) => nn(r.actual) > 0);           // only days that actually happened
  const last = actRows[actRows.length - 1] || rows[rows.length - 1] || {};
  const mtdTgt = actRows.reduce((s, r) => s + nn(r.target), 0);   // target for the elapsed (MTD) days only
  const actOverRrr = nn(k.rrrMTD) ? nn(k.mtdActual) / nn(k.rrrMTD) - 1 : null;
  const mrrOverRrr = nn(k.mrrSale) - nn(k.rrrMTD);
  const acc = mtdTgt ? nn(k.mtdActual) / mtdTgt - 1 : null;       // MTD actual vs MTD target-to-date
  const dayAcc = nn(last.target) ? nn(last.actual) / nn(last.target) - 1 : null;
  const dateLong = last.x ? new Date(String(last.x).slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "2-digit" }) : "";

  const pctTip = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
  const numTip = (v) => Math.round(v).toLocaleString("en-US");
  const chart = useMemo(() => ({
    x: rows.map((r) => dayLabel(r.x)),
    series: [
      { name: "MRR", data: rows.map((r) => nz(r.totalsale)), color: "#344054", width: 2.2, dashed: true },
      { name: "TGT", data: rows.map((r) => nz(r.target)), color: "#A6D97A", width: 3, area: false },
      { name: "ACT", data: rows.map((r) => nz(r.actual)), color: "#EAD200", width: 2.4 },
    ],
    // ACC + PV are not plotted — shown only in the hover tooltip
    extraRows: [
      { label: "ACC", data: rows.map((r) => (nz(r.target) ? nz(r.actual) / nz(r.target) - 1 : null)), fmt: pctTip },
      { label: "PV", data: rows.map((r) => nz(r.runrate)), fmt: numTip },
    ],
  }), [rows]);

  // Area managers: forecast-branch runrate only (scoped to their locations).
  if (areaOnly) return (
    <div className="page rr2">
      <BranchRunrate sel={sel} gbrand={gbrand} />
      <PageFeedback page="runrate" pageLabel="Sales Run Rate" sel={sel} />
    </div>
  );

  return (
    <div className={cls("page rr2", loading)}>
      <UpdatingBar show={loading} brand={gbrand} />
      <div className="rr2-top" data-viz="rr_kpis" data-viz-label="Runrate KPIs">
        {/* ---- Card 1: MRR / DRR / WRR ---- */}
        <div className="rr2-col">
          <div className="card rr2-card">
            <Metric value={g(nn(k.mrrFB) || nn(k.mrrSale))} label="MRR" color={gc(k.forecastGrowth)} />
            <Metric value={g(k.drrMTD)} label="DRR" color={gc(k.drrText)} tri={k.drrText} />
            <Metric value={g(k.wrrMTD)} label="WRR" color={gc(k.wrrText)} tri={k.wrrText} />
          </div>
          <Strip label="MoM" val={k.forecastGrowth} />
        </div>

        {/* ---- Card 2: RRR + M.TGT ---- */}
        <div className="rr2-col">
          <div className="card rr2-card">
            <Metric value={g(k.rrrMTD)} label="RRR" color={gc(k.rrrGrowth)} />
            <div className="rr2-subs"><Sub label="RRRGROWTH%" val={k.rrrGrowth} /><Sub label="ACT OVER RRR" val={actOverRrr} /></div>
            <Metric value={g(k.forecastMTD)} label="M.TGT" />
            <div className="rr2-subs"><Sub label="MRRCT" val={k.forecastGrowth} /><Sub label="TARGET YoY" val={0} /></div>
          </div>
          <Strip label="S.E" val={actOverRrr != null ? -Math.abs(actOverRrr) * 0.15 : 0} />
        </div>

        {/* ---- Card 3: RRY + TRY ---- */}
        <div className="rr2-col">
          <div className="card rr2-card">
            <Metric value={g(k.runrateYTD)} label="RRY" color={GC_UP} />
            <div className="rr2-subs"><Sub label="YRR YoY" val={0} /><Sub label="YRRCT" val={k.totYear} /></div>
            <Metric value={g(k.forecastYTD)} label="TRY" />
            <div className="rr2-subs"><Sub label="Target YoY" val={0} /></div>
          </div>
          <Strip label="R.GR" val={k.rrrGrowth} />
        </div>
      </div>

      {/* ---- RUNRATE full-width ---- */}
      <div className="card rr2-runrate" data-viz="rr_daily" data-viz-label="Daily Runrate">
        <div className="rr2-rr-title">RUNRATE</div>
        <div className="rr2-rr-head">
          <div className="rr2-hstat"><span className="rr2-hbig">{g(k.mtdActual)}</span><span className="rr2-hlbl">MTD</span></div>
          <div className="rr2-hstat"><span className="rr2-hbig sm" style={{ color: gc(acc) }}>{asPct(acc)}</span><span className="rr2-hlbl">ACC</span></div>
          <div className="rr2-hstat"><span className="rr2-hbig sm" style={{ color: gc(mrrOverRrr) }}>{(mrrOverRrr >= 0 ? "+" : "") + g(mrrOverRrr)}</span><span className="rr2-hlbl">MRR OVER RRR</span></div>
          <div className="spacer" />
          <div className="rr2-daybox">
            <div className="rr2-day">{dateLong}</div>
            <div className="rr2-dgrid">
              <span>{g(last.actual)}</span><span>{g(last.target)}</span><span style={{ color: gc(dayAcc) }}>{asPct(dayAcc)}</span>
              <span className="rr2-dl">ACT</span><span className="rr2-dl">TGT</span><span className="rr2-dl">ACC</span>
              <span>{g(last.runrate)}</span><span /><span />
              <span className="rr2-dl">PV</span>
            </div>
          </div>
        </div>
        {loading ? <Skeleton h={360} /> : rows.length === 0 ? <div className="dt-empty">No data for this selection</div> : (
          <EChart height={400} option={multiLineOption({ x: chart.x, series: chart.series, extraRows: chart.extraRows, fmt: (v) => Math.round(v).toLocaleString("en-US") })} />
        )}
        <VisualFeedback id="RUNRATE_CHART" name="Runrate — MRR/TGT/ACT" description="Daily actual vs target with ACC and PV in the tooltip for the selected month." page="runrate" sel={sel} />
      </div>
      <BranchRunrate sel={sel} gbrand={gbrand} />

      <PageFeedback page="runrate" pageLabel="Sales Run Rate" sel={sel} />
    </div>
  );
}

// Filterable runrate built from FORECAST BRANCH (its own Actual / Target / MonthRunrate
// / Totalsale, sliceable by Brand / Order Source / Location).
function BranchRunrate({ sel, gbrand = "all" }) {
  const [f, setF] = useState({ src: "", loc: "" });
  const [lists, setLists] = useState({ sources: [], locs: [] });
  const [k, setK] = useState({});
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const brandFilter = gbrand && gbrand !== "all" ? gbrand : "";   // driven by the top selector

  useEffect(() => {
    // branches are scoped to the selected brand (a brand's dropdown must not list
    // other brands' branches). Re-fetch and clear a now-invalid branch on change.
    const bq = brandFilter ? `&rrbrand=${encodeURIComponent(brandFilter)}` : "";
    Promise.all([fetchViz("rr_fb_sources", sel, ""), fetchViz("rr_fb_locs", sel, bq)])
      .then(([s, l]) => setLists({ sources: s.map((r) => r.v).filter(Boolean), locs: l.map((r) => r.v).filter(Boolean) }))
      .catch(() => {});
    setF((x) => (x.loc ? { ...x, loc: "" } : x));
  }, [brandFilter]);

  const fq = (brandFilter ? `&rrbrand=${encodeURIComponent(brandFilter)}` : "")
    + (f.src ? `&rrsrc=${encodeURIComponent(f.src)}` : "")
    + (f.loc ? `&rrloc=${encodeURIComponent(f.loc)}` : "");

  useEffect(() => {
    let live = true; setBusy(true);
    Promise.all([fetchViz("rr_fb_kpis", sel, fq), fetchViz("rr_fb_daily", sel, fq)])
      .then(([kp, rw]) => { if (!live) return; setK(kp && !Array.isArray(kp) ? kp : {}); setRows(Array.isArray(rw) ? rw : []); setBusy(false); })
      .catch(() => live && setBusy(false));
    return () => { live = false; };
  }, [sel, fq]);

  // MRR / YRR / M.TGT / T.TGT come EXACT from FORECAST BRANCH columns (the same
  // Totalsale / Final Target the model measures use). DRR / WRR (1-day / 7-day
  // runrate) are projected from daily Actual, because the model's LAST1/LAST7-day
  // sales columns don't exist per-brand in FORECAST BRANCH.
  const m = useMemo(() => {
    const act = rows.filter((r) => nn(r.actual) > 0);            // elapsed (traded) days
    const elapsed = act.length;
    const daysInPeriod = rows.length || 1;
    const remaining = Math.max(0, daysInPeriod - elapsed);
    const last = act[act.length - 1] || {};
    const last7 = act.slice(-7);
    const mtdActual = nn(k.actual) || act.reduce((s, r) => s + nn(r.actual), 0);
    const mtdTarget = act.reduce((s, r) => s + nn(r.target), 0);  // target for elapsed days only
    const monthTarget = nn(k.finalTarget) || rows.reduce((s, r) => s + nn(r.target), 0);
    const mrr = nn(k.mrr);                                        // exact — Totalsale MTD
    const yrr = nn(k.yrr);                                        // exact — Totalsale YTD
    const tryTgt = nn(k.try);                                     // year target
    const perDay7 = last7.length ? last7.reduce((s, r) => s + nn(r.actual), 0) / last7.length : 0;
    const drr = nn(last.actual) * daysInPeriod;                   // 1-day pace projection (derived)
    const wrr = perDay7 * daysInPeriod;                           // 7-day pace projection (derived)
    const rrr = remaining ? (monthTarget - mtdActual) / remaining : 0; // required per remaining day
    const acc = mtdTarget ? mtdActual / mtdTarget - 1 : null;
    const yAcc = tryTgt ? yrr / tryTgt - 1 : null;
    const gapToTarget = mrr - monthTarget;
    const mrrOverTgt = mrr - monthTarget;
    const dayAcc = nn(last.target) ? nn(last.actual) / nn(last.target) - 1 : null;
    return { elapsed, daysInPeriod, remaining, last, mtdActual, mtdTarget, monthTarget, mrr, yrr, tryTgt, drr, wrr, rrr, acc, yAcc, gapToTarget, mrrOverTgt, dayAcc };
  }, [rows, k]);

  const scope = [brandFilter || "All brands", f.loc || "all branches", f.src || "all channels"].join(" · ");
  const last = m.last;
  const dateLong = last.x ? new Date(String(last.x).slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "2-digit" }) : "";

  const pctTip = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
  const numTip = (v) => Math.round(v).toLocaleString("en-US");
  const chart = useMemo(() => ({
    x: rows.map((r) => dayLabel(r.x)),
    series: [
      { name: "MRR", data: rows.map((r) => nz(r.totalsale)), color: "#344054", width: 2.2, dashed: true },
      { name: "TGT", data: rows.map((r) => nz(r.target)), color: "#A6D97A", width: 3 },
      { name: "ACT", data: rows.map((r) => nz(r.actual)), color: "#EAD200", width: 2.6 },
    ],
    extraRows: [
      { label: "ACC", data: rows.map((r) => (nz(r.target) ? nz(r.actual) / nz(r.target) - 1 : null)), fmt: pctTip },
      { label: "PV", data: rows.map((r) => nz(r.runrate)), fmt: numTip },
    ],
  }), [rows]);

  const Sel = ({ label, val, opts, on }) => (
    <label className="rr-fbsel"><span>{label}</span>
      <select className="ctl" value={val} onChange={(e) => on(e.target.value)}>
        <option value="">All</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  return (
    <div className="rr-fb" data-viz="rr_fb_daily" data-viz-label="Branch Runrate">
      <div className="rr-fb-head">
        <div><span className="card-title lg">Runrate by Brand · Source · Location</span><span className="rr-fb-scope">{scope}{busy ? " · loading…" : ""}</span></div>
        <div className="rr-fb-filters stays-live">
          {brandFilter && <span className="rr-fb-brandtag">Brand: {brandFilter} <em>(from top)</em></span>}
          <Sel label="Order Source" val={f.src} opts={lists.sources} on={(v) => setF((x) => ({ ...x, src: v }))} />
          <Sel label="Location" val={f.loc} opts={lists.locs} on={(v) => setF((x) => ({ ...x, loc: v }))} />
          {(f.src || f.loc) && <button className="rr-fb-clear" onClick={() => setF({ src: "", loc: "" })}>Clear</button>}
        </div>
      </div>

      {/* same 3-card layout as the main runrate, computed for the filtered scope */}
      <div className="rr2-top">
        <div className="rr2-col">
          <div className="card rr2-card">
            <Metric value={g(m.mrr)} label="MRR" color={gc(m.mrrOverTgt)} />
            <Metric value={g(m.drr)} label="DRR" color={gc(m.dayAcc)} tri={m.dayAcc} />
            <Metric value={g(m.wrr)} label="WRR" color={GC_UP} />
          </div>
          <Strip label="MRR vs Target" val={m.monthTarget ? m.mrr / m.monthTarget - 1 : 0} />
        </div>
        <div className="rr2-col">
          <div className="card rr2-card">
            <Metric value={g(m.monthTarget)} label="M.TGT" />
            <div className="rr2-subrow"><span className="rr2-subrow-v num">{m.remaining}</span><span className="rr2-subrow-l">days left</span></div>
            <div className="rr2-subrow"><span className="rr2-subrow-v num">{g(m.monthTarget - m.mtdActual)}</span><span className="rr2-subrow-l">still needed</span></div>
          </div>
          <Strip label="Achievement (MTD)" val={m.acc} />
        </div>
        <div className="rr2-col">
          <div className="card rr2-card">
            <Metric value={g(m.yrr)} label="YRR" color={gc(m.yAcc)} />
            <div className="rr2-subrow"><span className="rr2-subrow-v num" style={{ color: gc(m.yAcc) }}>{m.yAcc == null ? "—" : (m.yAcc >= 0 ? "+" : "") + (m.yAcc * 100).toFixed(1) + "%"}</span><span className="rr2-subrow-l">vs year target</span></div>
            <Metric value={g(m.tryTgt)} label="T.TGT" />
            <div className="rr2-subrow"><span className="rr2-subrow-v num">{m.elapsed}/{m.daysInPeriod}</span><span className="rr2-subrow-l">days elapsed</span></div>
          </div>
          <Strip label="Gap to target" val={m.monthTarget ? m.gapToTarget / m.monthTarget : 0} />
        </div>
      </div>

      {/* RUNRATE full-width — identical header + day box to the main page */}
      <div className="card rr2-runrate" data-viz="rr_fb_daily" data-viz-label="Branch Runrate chart">
        <div className="rr2-rr-title">RUNRATE — {scope}</div>
        <div className="rr2-rr-head">
          <div className="rr2-hstat"><span className="rr2-hbig">{g(m.mtdActual)}</span><span className="rr2-hlbl">MTD</span></div>
          <div className="rr2-hstat"><span className="rr2-hbig sm" style={{ color: gc(m.acc) }}>{asPct(m.acc)}</span><span className="rr2-hlbl">ACC</span></div>
          <div className="rr2-hstat"><span className="rr2-hbig sm" style={{ color: gc(m.mrrOverTgt) }}>{(m.mrrOverTgt >= 0 ? "+" : "") + g(m.mrrOverTgt)}</span><span className="rr2-hlbl">MRR OVER TARGET</span></div>
          <div className="spacer" />
          <div className="rr2-daybox">
            <div className="rr2-day">{dateLong || "—"}</div>
            <div className="rr2-dgrid">
              <span>{g(last.actual)}</span><span>{g(last.target)}</span><span style={{ color: gc(m.dayAcc) }}>{asPct(m.dayAcc)}</span>
              <span className="rr2-dl">ACT</span><span className="rr2-dl">TGT</span><span className="rr2-dl">ACC</span>
              <span>{g(last.runrate)}</span><span /><span />
              <span className="rr2-dl">RR</span>
            </div>
          </div>
        </div>
        {busy ? <Skeleton h={360} /> : !rows.length ? <div className="dt-empty">No forecast data for this selection</div> : (
          <EChart height={400} option={multiLineOption({ x: chart.x, series: chart.series, extraRows: chart.extraRows, fmt: (v) => Math.round(v).toLocaleString("en-US") })} />
        )}
      </div>
    </div>
  );
}

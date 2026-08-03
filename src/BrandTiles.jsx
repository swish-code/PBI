import React, { useState, useEffect } from "react";
import { selQuery } from "./dates.js";
import { Skeleton, BrandMark } from "./ui.jsx";
import { brandColorOf } from "./logos.js";
import { ChevronRight, Package } from "lucide-react";

const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
// a text-readable version of a brand colour: darken very light brands (e.g. Yelo
// amber) so the big number stays legible on a white card.
function readable(hex) {
  if (typeof hex !== "string" || hex[0] !== "#" || hex.length < 7) return hex;
  const n = parseInt(hex.slice(1, 7), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum <= 0.6) return hex;
  const f = 0.52; const d = (v) => Math.round(v * f).toString(16).padStart(2, "0");
  return `#${d(r)}${d(g)}${d(b)}`;
}
const money = (v) => "KD " + Math.round(nn(v)).toLocaleString("en-US");
const num = (v) => Math.round(nn(v)).toLocaleString("en-US");
const fetchViz = (name, q) => fetch(`/api/viz/${name}?${q}`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((j) => (j ? (j.row != null ? j.row : j.rows || []) : null)).catch(() => null);

// every brand that has a Product Mix, with its model's KPI + top-items visuals
const BRAND_TILES = [
  { name: "BBT", kpi: "pm_kpis", top: "pm_bestsellers", p: "brand=BBT" },
  { name: "Mishmash", kpi: "pm_kpis", top: "pm_bestsellers", p: "brand=Mishmash" },
  { name: "Tabel", kpi: "pm_kpis", top: "pm_bestsellers", p: "brand=Tabel" },
  { name: "Shawarma Shakir", kpi: "pm_kpis", top: "pm_bestsellers", p: "brand=Shawarma Shakir" },
  { name: "Yelo Pizza", kpi: "yp_kpis", top: "yp_hero", p: "" },
  { name: "Chilli Pepper", kpi: "sh_kpis", top: "sh_hero", p: "shchain=CHP" },
  { name: "Just C", kpi: "sh_kpis", top: "sh_hero", p: "shchain=BUR" },
  { name: "Pattie Pattie", kpi: "sh_kpis", top: "sh_hero", p: "shchain=PAT" },
  { name: "Slice", kpi: "sh_kpis", top: "sh_hero", p: "shchain=SLC" },
];

export default function BrandTiles({ sel, onPick }) {
  const [data, setData] = useState({});
  useEffect(() => {
    let live = true; setData({});
    BRAND_TILES.forEach((b) => {
      const q = selQuery(sel) + (b.p ? "&" + b.p : "");
      Promise.all([fetchViz(b.kpi, q), fetchViz(b.top, q)]).then(([kpi, top]) => {
        if (!live) return;
        const items = (Array.isArray(top) ? top : []).slice().sort((a, c) => nn(c.qty) - nn(a.qty)).slice(0, 5);
        setData((d) => ({ ...d, [b.name]: { kpi: kpi || {}, items } }));
      });
    });
    return () => { live = false; };
  }, [sel]);

  return (
    <div className="page">
      <div className="bt-head"><b>Product Mix — All Brands</b><span>Top-selling items per brand · click a brand to open its Product Mix</span></div>
      <div className="bt-grid">
        {BRAND_TILES.map((b, bi) => {
          const d = data[b.name];
          const color = brandColorOf(b.name);
          const maxQty = d && d.items.length ? nn(d.items[0].qty) || 1 : 1;
          const empty = d && !d.items.length;
          // distinguish "genuinely no sales" from "this model hasn't refreshed the
          // selected date yet" (nearby periods have data) — avoids a misleading "0".
          const k = d && d.kpi;
          const notRefreshed = empty && k && !nn(k.sales) && (nn(k.sales_w) > 0 || nn(k.sales_m) > 0);
          return (
            <button key={b.name} className={`bt-tile${empty ? " bt-tile-empty" : ""}`} style={{ "--bc": color, "--bc-ink": readable(color) }} onClick={() => onPick(b.name)}>
              <div className="bt-tile-head">
                <span className="bt-tile-name"><span className="bt-logo"><BrandMark name={b.name} size={30} /></span>{b.name}</span>
                <span className="bt-go"><ChevronRight size={15} /></span>
              </div>
              <div className="bt-tile-kpis">
                {d ? <><b>{money(d.kpi.sales)}</b><div className="bt-stats"><span>{num(d.kpi.qty)} qty</span><i /><span>{num(d.kpi.orders)} orders</span></div></> : <Skeleton w={150} h={22} />}
              </div>
              <div className="bt-items">
                {d ? (d.items.length ? d.items.map((it, i) => (
                  <div key={i} className="bt-item">
                    <span className="bt-item-bar" style={{ width: `${Math.max(8, (nn(it.qty) / maxQty) * 100)}%` }} />
                    <span className="bt-item-rank">{i + 1}</span>
                    <span className="bt-item-name" title={it.item}>{it.item}</span>
                    <span className="bt-item-qty">{num(it.qty)}</span>
                  </div>
                )) : <div className="bt-empty"><Package size={22} /><span>{notRefreshed ? "Product Mix not refreshed for this date yet" : "No sales in this period"}</span></div>) : <Skeleton h={130} />}
              </div>
              <span className="bt-open">Open Product Mix <ChevronRight size={13} /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

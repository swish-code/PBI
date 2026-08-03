import React, { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { brandMeta } from "./logos.js";
import { Skeleton } from "./ui.jsx";
import { selQuery } from "./dates.js";
import { kd, num } from "./theme.js";

// Store map — brand pins OR sales-sized bubbles, from imported Branches Data
// (resolved Google-Maps coords). Free OpenStreetMap tiles. Sales/orders/AOV for
// the selected period are matched to each store server-side. Hover shows the KPIs.
export default function LocationsPage({ brand = "all", sel }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layer = useRef(null);
  const [stores, setStores] = useState(null);
  const [mode, setMode] = useState("pins");   // pins | bubbles

  useEffect(() => {
    setStores(null);
    const q = (sel ? selQuery(sel) : "") + (brand && brand !== "all" ? "&brand=" + encodeURIComponent(brand) : "");
    fetch("/api/store-locations?" + q, { credentials: "include" }).then((r) => r.json()).then((j) => setStores(j.stores || [])).catch(() => setStores([]));
  }, [sel, brand]);

  const shown = useMemo(() => (stores || []).filter((s) => s.lat != null && (brand === "all" || s.brand === brand)), [stores, brand]);
  const totals = useMemo(() => {
    const ws = shown.filter((s) => s.net != null);
    const net = ws.reduce((a, s) => a + s.net, 0), ord = ws.reduce((a, s) => a + (s.orders || 0), 0);
    return { count: shown.length, net, ord, aov: ord ? net / ord : 0, hasSales: ws.length > 0 };
  }, [shown]);

  useEffect(() => {
    if (!stores || !elRef.current) return;
    if (!mapRef.current) {
      mapRef.current = L.map(elRef.current, { scrollWheelZoom: true }).setView([29.32, 47.98], 11);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(mapRef.current);
    }
    const map = mapRef.current;
    if (layer.current) { map.removeLayer(layer.current); layer.current = null; }
    const esc = (s) => String(s || "").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const money = (v) => "KD " + Math.round(v).toLocaleString("en-US");
    const mn = (v) => (v > 0 ? v.toFixed(1) + "m" : "—");
    const salesRow = (s) => s.net != null
      ? `<div class="store-pop-kpis"><div><span>Sales</span><b>${money(s.net)}</b></div><div><span>Orders</span><b>${num(s.orders || 0)}</b></div><div><span>AOV</span><b>${money(s.aov || 0)}</b></div></div>`
      : `<div class="store-pop-r" style="opacity:.7">No sales for this period</div>`;
    const opsRow = (s) => (s.prep != null || s.delivery != null)
      ? `<div class="store-pop-kpis"><div><span>Prep</span><b>${mn(s.prep)}</b></div><div><span>Delivery</span><b class="${s.slowDelivery ? "warn" : ""}">${mn(s.delivery)}</b></div><div><span>Rating</span><b>${s.rating > 0 ? s.rating.toFixed(2) : "—"}</b></div></div>`
      : "";
    const warnRow = (s) => s.slowDelivery ? `<div class="store-tip-warn">⚠ High delivery — ${mn(s.delivery)} vs brand avg ${s.brandAvgDelivery}m</div>` : "";
    const detail = (s, m) => `<div class="store-tip-h" style="color:${m.c}">${esc(s.brand)}</div><b>${esc(s.branch)}</b>${salesRow(s)}${opsRow(s)}${warnRow(s)}`;
    const tipHtml = (s, m) => `<div class="store-tip-in">${detail(s, m)}</div>`;
    const popHtml = (s, m) => `<div class="store-pop">${detail(s, m)}` +
      (s.hours ? `<div class="store-pop-r">🕒 ${esc(s.hours)}${s.hoursPerDay != null ? ` · ${s.hoursPerDay}h/day` : ""}</div>` : "") +
      (s.address ? `<div class="store-pop-r">📍 ${esc(s.address)}</div>` : "") +
      (s.mapUrl ? `<a href="${esc(s.mapUrl)}" target="_blank" rel="noopener">Open in Google Maps →</a>` : "") + `</div>`;

    const group = L.layerGroup();
    const bounds = [];
    const maxNet = Math.max(1, ...shown.map((s) => s.net || 0));
    for (const s of shown) {
      const m = brandMeta(s.brand);
      let mk;
      if (mode === "bubbles") {
        const r = s.net != null ? 8 + 30 * Math.sqrt((s.net || 0) / maxNet) : 6;
        mk = L.circleMarker([s.lat, s.lng], { radius: r, color: "#fff", weight: 1.5, fillColor: m.c, fillOpacity: 0.8 });
      } else {
        const html = `<div class="store-pin" style="background:${m.c}"><img src="${esc(m.f || "")}" alt="" onerror="this.style.display='none'"/></div>`;
        mk = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "store-pin-wrap", html, iconSize: [46, 46], iconAnchor: [23, 46], popupAnchor: [0, -42] }) });
      }
      mk.bindTooltip(tipHtml(s, m), { direction: "top", offset: [0, mode === "bubbles" ? -6 : -40], className: "store-tip", sticky: mode === "bubbles", opacity: 1 });
      mk.bindPopup(popHtml(s, m));
      group.addLayer(mk); bounds.push([s.lat, s.lng]);
      // blinking warning badge for slow-delivery stores (non-interactive so it never blocks hover)
      if (s.slowDelivery) {
        group.addLayer(L.marker([s.lat, s.lng], { interactive: false, zIndexOffset: 1000,
          icon: L.divIcon({ className: "store-warn-wrap", html: '<span class="store-warn">!</span>', iconSize: [18, 18], iconAnchor: mode === "bubbles" ? [-7, 16] : [-9, 44] }) }));
      }
    }
    group.addTo(map); layer.current = group;
    const fit = () => { map.invalidateSize(); if (bounds.length) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 13 }); };
    requestAnimationFrame(fit);
    [120, 400, 900].forEach((t) => setTimeout(fit, t));   // recalc once the flex/layout settles
  }, [stores, brand, mode, shown]);

  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);

  // NOTE: the map container must never unmount (Leaflet keeps a live instance bound
  // to this exact node), so we always render it and overlay a loading state instead.
  const loading = stores == null;
  return (
    <div className="page loc-page">
      <div className="loc-kpis">
        <div className="loc-kpi"><span>Stores</span><b>{loading ? "…" : num(totals.count)}</b></div>
        <div className="loc-kpi"><span>Sales</span><b>{!loading && totals.hasSales ? kd(totals.net) : "—"}</b></div>
        <div className="loc-kpi"><span>Orders</span><b>{!loading && totals.hasSales ? num(totals.ord) : "—"}</b></div>
        <div className="loc-kpi"><span>AOV</span><b>{!loading && totals.hasSales ? kd(totals.aov) : "—"}</b></div>
        <div className="loc-toggle">
          <button className={mode === "pins" ? "on" : ""} onClick={() => setMode("pins")}>Pins</button>
          <button className={mode === "bubbles" ? "on" : ""} onClick={() => setMode("bubbles")}>Bubbles by sales</button>
        </div>
      </div>
      <div className="loc-map-wrap">
        <div ref={elRef} className="loc-map" />
        {loading && <div className="loc-loading">Loading stores…</div>}
      </div>
    </div>
  );
}

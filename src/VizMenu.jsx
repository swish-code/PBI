// ============================================================================
//  Universal per-visual ⋮ menu — appears on hover over any [data-viz] card on
//  any page. Actions: Focus (blur the rest + enlarge), Export data (CSV),
//  Add to Home, Suggest a change (feedback → admin triage).
// ============================================================================
import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactECharts from "echarts-for-react";
import * as echarts from "echarts";
import { MoreVertical, Maximize2, Sparkles, Download, Home, MessageSquarePlus, X, ThumbsUp, ThumbsDown, Lightbulb, Volume2, VolumeX } from "lucide-react";
import { selQuery, presetLabel } from "./dates.js";
import { buildInsights } from "./vizInsights.js";
import { speak, stopSpeaking, ttsSupported } from "./voice.js";

// stitch a visual's insights into one spoken paragraph
function spokenInsights(f, periodLabel) {
  if (!f) return "";
  const head = `${f.label}${periodLabel ? ", " + periodLabel : ""}. `;
  const parts = (f.insights || []).map((i) => i.text);
  return head + (parts.length ? parts.join(". ") + "." : "No clear pattern to call out for this selection.");
}

const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(csv, name) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VizMenu({ sel, brand, page }) {
  const [hot, setHot] = useState(null);       // {name,label,rect,el}
  const [menu, setMenu] = useState(null);     // {name,label,x,y,el}
  const [focus, setFocus] = useState(null);   // {label,html}
  const [suggest, setSuggest] = useState(null); // {name,label}
  const [toast, setToast] = useState("");
  const [readAloud, setReadAloud] = useState(() => { try { return localStorage.getItem("vizmReadAloud") !== "0"; } catch { return true; } });
  const toastT = useRef(null);
  const flash = useCallback((m) => { setToast(m); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(""), 2400); }, []);
  useEffect(() => { try { localStorage.setItem("vizmReadAloud", readAloud ? "1" : "0"); } catch { /* ignore */ } }, [readAloud]);
  const closeFocus = useCallback(() => { stopSpeaking(); setFocus(null); }, []);

  // follow the hovered visual (skip while a menu/overlay is open)
  useEffect(() => {
    const onMove = (e) => {
      if (menu || focus || suggest) return;
      if (e.target.closest && e.target.closest(".vzm-badge")) return;   // keep the button reachable
      const el = e.target.closest && e.target.closest("[data-viz]");
      if (!el || el.getAttribute("data-viz-nomenu") === "1") { setHot((h) => (h ? null : h)); return; }
      const r = el.getBoundingClientRect();
      if (r.width < 90 || r.height < 60) { setHot(null); return; }
      setHot({ name: el.getAttribute("data-viz"), label: el.getAttribute("data-viz-label") || el.getAttribute("data-viz"), rect: r, el });
    };
    document.addEventListener("mousemove", onMove, true);
    return () => document.removeEventListener("mousemove", onMove, true);
  }, [menu, focus, suggest]);

  useEffect(() => {
    const onDown = (e) => { if (!e.target.closest || !e.target.closest(".vzm-menu")) setMenu(null); };
    const onEsc = (e) => { if (e.key === "Escape") { setMenu(null); stopSpeaking(); setFocus(null); setSuggest(null); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onEsc); };
  }, []);

  const qs = () => selQuery(sel) + (brand && brand !== "all" ? `&brand=${encodeURIComponent(brand)}` : "");

  function rowsToCsv(rows, m) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
    downloadCsv(csv, `${(m.label || m.name).replace(/[^\w -]+/g, "")}.csv`);
  }
  async function exportData(m) {
    setMenu(null);
    try {
      const j = await fetch(`/api/viz/${m.name}?${qs()}`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null));
      const rows = j ? (Array.isArray(j.rows) ? j.rows : (j.row ? [j.row] : [])) : [];
      if (!rows.length) return flash("No data to export");
      rowsToCsv(rows, m); flash("Exported CSV");
    } catch { flash("Export failed"); }
  }
  // Focus export reuses the rows already fetched for the insight panel (no 2nd call).
  function exportFocus() {
    if (!focus) return;
    if (focus.rows && focus.rows.length) { rowsToCsv(focus.rows, focus); flash("Exported CSV"); }
    else exportData(focus);
  }

  // Focus: for a CHART, lift the live ECharts option off the source card and
  // re-render a real chart (so hover tooltips work) — a static innerHTML clone is
  // a dead SVG with no interactivity. For tables/other visuals, fall back to the
  // clone. Then fetch rows for the insight panel + export.
  function openFocus(m, autoRead = false) {
    let echartsOption = null;
    try {
      const node = m.el.querySelector("[_echarts_instance_]");
      const inst = node && echarts.getInstanceByDom(node);
      if (inst) echartsOption = inst.getOption();
    } catch { /* not a chart — fall back to the clone */ }
    stopSpeaking();
    setFocus({ label: m.label, name: m.name, el: m.el, echartsOption, html: echartsOption ? null : m.el.innerHTML, rows: null, insights: null, loading: true, autoRead });
    setMenu(null);
    fetch(`/api/viz/${m.name}?${qs()}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const rows = j ? (Array.isArray(j.rows) ? j.rows : j.row ? [j.row] : []) : [];
        const insights = buildInsights(rows);
        setFocus((f) => (f && f.name === m.name ? { ...f, rows, insights, loading: false } : f));
        // SWiSH AI Analyse reads its analysis aloud; plain Focus stays silent
        if (autoRead && readAloud && ttsSupported) speak(spokenInsights({ label: m.label, insights }, presetLabel(sel)));
      })
      .catch(() => setFocus((f) => (f && f.name === m.name ? { ...f, rows: [], insights: [], loading: false } : f)));
  }

  async function addToHome(m) {
    setMenu(null);
    try {
      const w = m.el.getBoundingClientRect().width;
      const col = w > 900 ? 12 : w > 620 ? 8 : w > 380 ? 6 : 4;
      const html = (m.el.innerHTML || "").slice(0, 220000);   // exact look
      await fetch("/api/home/pins", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ viz: m.name, label: m.label, page, col, html, brand: brand || "all" }) });
      window.dispatchEvent(new CustomEvent("home-pins-changed"));
      flash("Added to Home");
    } catch { flash("Couldn't add to Home"); }
  }

  async function sendSuggest(m, vote, comment) {
    try {
      await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ scope: "visual", visualId: m.name, visualName: m.label, page, vote: vote || undefined, comment, dateRange: qs() }) });
      setSuggest(null); flash("Thanks — sent to the team");
    } catch { flash("Couldn't send feedback"); }
  }

  // ⋮ button that floats at the hovered card's top-right
  const badge = hot && !menu && !focus && (
    <button className="vzm-badge" style={{ top: hot.rect.top + 6, left: hot.rect.right - 40 }}
      onClick={(e) => { e.stopPropagation(); setMenu({ name: hot.name, label: hot.label, el: hot.el, x: hot.rect.right, y: hot.rect.top + 40 }); }}
      title="Visual options"><MoreVertical size={18} /></button>
  );

  return (
    <>
      {badge}
      {menu && (
        <div className="vzm-menu" style={{ top: menu.y, left: Math.min(menu.x - 200, window.innerWidth - 220) }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="vzm-menu-h">{menu.label}</div>
          <button className="vzm-ai-item" onClick={() => openFocus(menu, true)}><Sparkles size={14} /> SWiSH AI Analyse</button>
          <button onClick={() => openFocus(menu, false)}><Maximize2 size={14} /> Focus</button>
          <button onClick={() => exportData(menu)}><Download size={14} /> Export data</button>
          <button onClick={() => addToHome(menu)}><Home size={14} /> Add to Home</button>
          <button onClick={() => { setSuggest({ name: menu.name, label: menu.label }); setMenu(null); }}><MessageSquarePlus size={14} /> Suggest a change</button>
        </div>
      )}

      <AnimatePresence>
        {focus && (
          <motion.div className="vzm-focus-ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeFocus}>
            <motion.div className="vzm-focus" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.97, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
              <div className="vzm-focus-h">
                <b><Sparkles size={15} style={{ verticalAlign: "-2px", marginRight: 6, color: "#7A5AF8" }} />SWiSH AI Analysis <span className="beta-badge">BETA</span> · {focus.label}</b>
                <div className="vzm-focus-tools">
                  {ttsSupported && <button className="vzm-focus-exp" onClick={() => { if (readAloud) { stopSpeaking(); setReadAloud(false); } else { setReadAloud(true); speak(spokenInsights(focus, presetLabel(sel))); } }} title={readAloud ? "Mute voice" : "Read aloud"}>{readAloud ? <Volume2 size={15} /> : <VolumeX size={15} />} {readAloud ? "Reading" : "Read"}</button>}
                  <button className="vzm-focus-exp" onClick={exportFocus} title="Export data as CSV"><Download size={15} /> Export</button>
                  <button className="vzm-focus-exp" onClick={() => addToHome(focus)} title="Add to Home"><Home size={15} /></button>
                  <button className="vzm-focus-exp" onClick={() => { setSuggest({ name: focus.name, label: focus.label }); closeFocus(); }} title="Suggest a change"><MessageSquarePlus size={15} /></button>
                  <button className="ic" onClick={closeFocus}><X size={16} /></button>
                </div>
              </div>
              <div className="vzm-focus-grid">
                {focus.echartsOption ? (
                  // live re-render — full tooltips on hover
                  <div className="vzm-focus-body card">
                    <ReactECharts option={focus.echartsOption} style={{ width: "100%", height: "min(62vh, 540px)" }} opts={{ renderer: "svg" }} notMerge lazyUpdate />
                  </div>
                ) : (
                  <div className="vzm-focus-body card" dangerouslySetInnerHTML={{ __html: focus.html }} />
                )}
                <aside className="vzm-focus-side card">
                  <div className="vzm-side-h"><Lightbulb size={13} /> SWiSH AI says{focus.autoRead && readAloud && !focus.loading && <span className="vzm-reading">🔊 reading…</span>}</div>
                  {focus.loading ? (
                    <div className="vzm-side-load"><span /><span /><span /></div>
                  ) : focus.insights && focus.insights.length ? (
                    <ul className="vzm-side-list">
                      {focus.insights.map((it, i) => (
                        <li key={i} className={`vzm-ins ${it.tone}`}><span className="vzm-ins-dot" />{it.text}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="vzm-side-empty">No insight for this selection — the data doesn't show a clear pattern worth calling out.</p>
                  )}
                  <div className="vzm-side-foot">Derived from this visual's own data for the selected period.</div>
                </aside>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {suggest && <SuggestModal m={suggest} onClose={() => setSuggest(null)} onSend={sendSuggest} />}
      </AnimatePresence>

      <AnimatePresence>
        {toast && <motion.div className="vzm-toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>{toast}</motion.div>}
      </AnimatePresence>
    </>
  );
}

function SuggestModal({ m, onClose, onSend }) {
  const [vote, setVote] = useState(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => { if (!comment.trim() && !vote) return; setBusy(true); await onSend(m, vote, comment.trim()); setBusy(false); };
  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal" style={{ width: "min(460px,94vw)" }} initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.16 }}>
        <div className="modal-head"><b>Suggest a change · {m.label}</b><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">
          <div className="vzm-votes">
            <button className={`vzm-vote ${vote === "up" ? "up" : ""}`} onClick={() => setVote(vote === "up" ? null : "up")}><ThumbsUp size={15} /> Useful</button>
            <button className={`vzm-vote ${vote === "down" ? "down" : ""}`} onClick={() => setVote(vote === "down" ? null : "down")}><ThumbsDown size={15} /> Needs work</button>
          </div>
          <label className="mfield" style={{ marginTop: 12 }}>
            <span>What would you change about this visual?</span>
            <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. add last-year comparison, show as %, different chart type…" style={{ fontFamily: "inherit", fontSize: 13.5, padding: "10px 12px", border: "1px solid var(--line-2)", borderRadius: 9, outline: "none", resize: "vertical" }} />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={send} disabled={busy || (!comment.trim() && !vote)}>{busy ? "Sending…" : "Send suggestion"}</button>
        </div>
      </motion.div>
    </>
  );
}

import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Calendar as CalIcon, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { PRESETS, presetLabel, fmt, isoOf } from "./dates.js";

export default function DateControl({ sel, resolved, onChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // position with `fixed` from the button rect so no overflow parent can clip it; flip up if no room below
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const b = btnRef.current; if (!b) return;
      const r = b.getBoundingClientRect();
      const estH = 400;
      const spaceBelow = window.innerHeight - r.bottom - 12;
      const openUp = spaceBelow < estH && r.top - 12 > spaceBelow;
      const right = Math.max(8, Math.round(window.innerWidth - r.right));
      setPos(openUp
        ? { position: "fixed", right, bottom: Math.round(window.innerHeight - r.top + 8), top: "auto", left: "auto", maxHeight: Math.round(r.top - 16), zIndex: 3000, transformOrigin: "bottom right" }
        : { position: "fixed", right, top: Math.round(r.bottom + 8), bottom: "auto", left: "auto", maxHeight: Math.round(window.innerHeight - r.bottom - 16), zIndex: 3000, transformOrigin: "top right" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  return (
    <div className="datectl" ref={ref}>
      <motion.button ref={btnRef} className="datepill" whileTap={{ scale: 0.97 }} onClick={() => setOpen((o) => !o)}>
        <CalIcon size={14} />
        <span className="datepill-main">{presetLabel(sel)}</span>
        {resolved && <span className="datepill-sub">{fmt(resolved.start)}{resolved.end !== resolved.start ? " – " + fmt(resolved.end) : ""}</span>}
        <ChevronDown size={13} style={{ opacity: 0.5 }} />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div className="datepop"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -6 }}
            transition={{ type: "spring", stiffness: 470, damping: 30 }}
            style={{ transformOrigin: "top right", overflowY: "auto", ...(pos || {}) }}>
            <div className="datepop-quick">
              {PRESETS.map((p) => (
                <motion.button key={p.key} whileTap={{ scale: 0.95 }}
                  className={`qbtn ${sel.preset === p.key ? "on" : ""}`}
                  onClick={() => { onChange({ preset: p.key }); setOpen(false); }}>
                  {p.label}
                </motion.button>
              ))}
            </div>
            <RangeCalendar sel={sel} onPick={(s, e) => { onChange({ preset: "custom", start: s, end: e }); setOpen(false); }} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function RangeCalendar({ sel, onPick }) {
  const now = new Date();
  const base = sel.preset === "custom" ? sel.start.split("-") : [now.getFullYear(), now.getMonth() + 1];
  const [view, setView] = useState({ y: +base[0], m: +base[1] });
  const [anchor, setAnchor] = useState(null);

  const startDow = new Date(view.y, view.m - 1, 1).getDay();
  const dim = new Date(view.y, view.m, 0).getDate();
  const cells = [...Array(startDow).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  const dayIso = (d) => isoOf(view.y, view.m, d);
  const todayIso = isoOf(now.getFullYear(), now.getMonth() + 1, now.getDate());

  function clickDay(d) {
    const day = dayIso(d);
    if (!anchor) { setAnchor(day); return; }
    const [s, e] = anchor <= day ? [anchor, day] : [day, anchor];
    setAnchor(null);
    onPick(s, e);
  }
  const inSel = (d) => sel.preset === "custom" && dayIso(d) >= sel.start && dayIso(d) <= sel.end;
  const shift = (n) => setView((v) => { let m = v.m + n, y = v.y; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } return { y, m }; });
  const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="cal-nav" onClick={() => shift(-1)}><ChevronLeft size={15} /></button>
        <span>{MON[view.m - 1]} {view.y}</span>
        <button className="cal-nav" onClick={() => shift(1)}><ChevronRight size={15} /></button>
      </div>
      <div className="cal-grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => <span key={"h" + i} className="cal-dow">{w}</span>)}
        {cells.map((d, i) => d === null ? <span key={i} /> : (
          <button key={i}
            className={`cal-day ${inSel(d) ? "sel" : ""} ${anchor === dayIso(d) ? "anchor" : ""} ${dayIso(d) === todayIso ? "today" : ""}`}
            onClick={() => clickDay(d)}>{d}</button>
        ))}
      </div>
      <div className="cal-hint">{anchor ? "Pick end date…" : "Click a day, or a range"}</div>
    </div>
  );
}

import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useReducedMotion, animate, LayoutGroup } from "framer-motion";
import ReactECharts from "echarts-for-react";
import { ChevronUp, ChevronDown, ChevronRight, ChevronsUpDown, ChevronsDownUp, Download, Info } from "lucide-react";
import { T, axisBase, tooltipBase, kd, kdc, kk, num } from "./theme.js";
import { brandMeta, channelMeta, brandSrc, channelSrc, shade, COMPANY_LOGO } from "./logos.js";
import { glossaryLookup } from "./glossary.js";

/* ------------------------------------------------------------------ glossary
   <Term k="wow">WoW</Term> — a dotted-underline label that reveals a trilingual
   (English / العربية / हिन्दी) definition on hover or focus. `k` defaults to the
   child text, so <Term>AOV</Term> just works. Renders nothing special when the
   term is unknown, so it's safe to sprinkle anywhere. */
// Shared popover card — an accent header with the full term name, then one row
// per language with a labelled badge.
function GlossaryCard({ g }) {
  return (
    <>
      <span className="gcard-head"><span className="gcard-abbr">{g.term}</span>{g.full}</span>
      <span className="gcard-row"><span className="gcard-lang">EN</span><span className="gcard-def">{g.en}</span></span>
      <span className="gcard-row"><span className="gcard-lang">ع</span><span className="gcard-def" dir="rtl" lang="ar">{g.ar}</span></span>
    </>
  );
}

// Position a fixed card near an anchor rect, flipping above/below and clamping to
// the viewport. Portalled to <body> so table/card `overflow` can never clip it —
// that clipping was the "can't see the definition" and "tooltip overlaps" bug.
function anchorPos(rect) {
  const w = Math.min(340, window.innerWidth - 24);
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
  // Prefer BELOW; only flip above when below lacks room and above has more. This
  // avoids the top-of-card clipping when a row sits high on the page.
  const est = 180;
  const roomBelow = window.innerHeight - rect.bottom;
  const roomAbove = rect.top;
  const above = roomBelow < est && roomAbove > roomBelow;
  return { w, left, above, top: above ? rect.top - 9 : rect.bottom + 9, arrowX: rect.left + rect.width / 2 - left };
}
function GlossaryPop({ g, pos }) {
  return createPortal(
    <span className={`gpop ${pos.above ? "above" : "below"}`} role="tooltip"
      style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.w, transform: pos.above ? "translateY(-100%)" : "none" }}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <span className="gcard"><GlossaryCard g={g} /></span>
      <span className="gpop-arrow" style={{ left: pos.arrowX }} />
    </span>,
    document.body
  );
}

// Hover/focus term with a dotted underline + caret. Popover follows the element
// and is portalled, so it's never clipped.
export function Term({ k, children, className = "" }) {
  const g = glossaryLookup(k != null ? k : (typeof children === "string" ? children : ""));
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  if (!g) return <>{children}</>;
  const show = () => { const el = ref.current; if (el) setPos(anchorPos(el.getBoundingClientRect())); };
  const hide = () => setPos(null);
  return (
    <span ref={ref} className={`term ${className}`} tabIndex={0} role="note" aria-label={`${g.full}: ${g.en}`}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children != null ? children : g.term}
      <ChevronDown size={11} className="term-caret" aria-hidden="true" />
      {pos && <GlossaryPop g={g} pos={pos} />}
    </span>
  );
}

// Table-header variant: CLICK opens the definition (the click must not also sort
// the column). Portalled popover so `overflow:hidden` on the table can't hide it.
export function TermHead({ label, termKey }) {
  const g = glossaryLookup(termKey != null ? termKey : (typeof label === "string" ? label : ""));
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!pos) return;
    const reposition = () => { const el = ref.current; if (el) setPos(anchorPos(el.getBoundingClientRect())); };
    const onDoc = () => setPos(null);
    const onEsc = (e) => { if (e.key === "Escape") setPos(null); };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [pos]);
  if (!g) return <>{label}</>;
  const toggle = (e) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const el = ref.current; if (el) setPos(anchorPos(el.getBoundingClientRect()));
  };
  return (
    <button ref={ref} type="button" className="termhead" aria-label={`${g.full} — show definition`} aria-expanded={!!pos}
      onMouseDown={(e) => e.stopPropagation()} onClick={toggle}>
      {label}<ChevronDown size={11} className={`termhead-caret ${pos ? "up" : ""}`} />
      {pos && <GlossaryPop g={g} pos={pos} />}
    </button>
  );
}

/* ---------------------------------------------------------------- motion */
// staggered fade-and-rise entrance; children pass index for ~40ms stagger
// Editorial entrance: rises + fades on a long decelerating curve.
//   <Rise index={2}>…</Rise>          animates on mount (default)
//   <Rise inView index={2}>…</Rise>   animates when scrolled into view, once
// `once: true` matters — a dashboard you scroll all day would be unbearable if
// everything re-animated on every pass.
export function Rise({ index = 0, className = "", children, layout, inView = false, ...rest }) {
  const reduce = useReducedMotion();
  const shown = { opacity: 1, y: 0 };
  const scroll = { whileInView: shown, viewport: { once: true, margin: "0px 0px -12% 0px" } };
  return (
    <motion.div
      className={className}
      layout={layout}
      initial={reduce ? false : { opacity: 0, y: 18 }}
      {...(inView && !reduce ? scroll : { animate: shown })}
      transition={{ duration: 0.55, ease: [0.22, 0.61, 0.36, 1], delay: reduce ? 0 : Math.min(index, 6) * 0.06 }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

// card with entrance + hover-lift (transform only, 60fps)
export function Card({ index = 0, className = "", dark, children, hover = true, ...rest }) {
  const reduce = useReducedMotion();
  return (
    <Rise index={index} className={`card ${dark ? "dark" : ""} ${className}`}
      whileHover={hover && !reduce ? { y: -2 } : undefined}
      style={{ transition: "box-shadow .15s var(--ease)" }} {...rest}>
      {children}
    </Rise>
  );
}

// count-up number with a subtle green/red flash when the value changes
export function CountUp({ value, format = num, className = "" }) {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  const prev = useRef(null);
  const base = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (base.current == null) base.current = getComputedStyle(node).color;
    const to = Number(value) || 0;
    const from = prev.current == null ? to : prev.current;
    prev.current = to;
    node.textContent = format(to);   // show the final value immediately — no rolling "counting" animation
    if (reduce || from === to) return;
    const flash = animate(node, { color: [to >= from ? "#12B76A" : "#F04438", base.current] }, { duration: 0.9, ease: "easeOut" });
    return () => { flash.stop(); };
  }, [value]); // eslint-disable-line
  return <span ref={ref} className={className}>{format(Number(value) || 0)}</span>;
}

export function LiveDot({ beat = true }) {
  return <span className={`livedot ${beat ? "beat" : ""}`} />;
}

// coloured percentage/status pill; text like "+3.2%" or "-1.5%"
export function Pill({ text, value }) {
  const s = String(text ?? "").trim();
  const n = value != null ? value : parseFloat(s.replace(/[^\d.\-]/g, ""));
  const dir = isNaN(n) ? 0 : n > 0 ? 1 : n < 0 ? -1 : 0;
  const cls = dir > 0 ? "up" : dir < 0 ? "down" : "flat";
  const disp = value != null ? (value >= 0 ? "+" : "") + (value * 100).toFixed(1) + "%" : s || "—";
  return (
    <motion.span className={`pill ${cls}`} whileTap={{ scale: 0.94 }}>
      {dir > 0 && <ChevronUp size={12} />}{dir < 0 && <ChevronDown size={12} />}{disp}
    </motion.span>
  );
}

// signed period-delta pill: COLOR reflects good/bad (lowerBetter inverts the
// mapping), ARROW reflects the actual direction, number count-animates.
// A percentage on its own is not evidence. When `base`/`current` and the compared
// window are supplied, hovering shows the actual figures and the date being
// compared against, so the reader can check the maths rather than trust the pill.
export function DeltaPill({ value, lowerBetter = false, tag, base, current, baseLabel, curLabel, fmt = kd, termKey }) {
  const bad = value == null || !isFinite(value);
  const up = !bad && value > 0.0005, down = !bad && value < -0.0005;
  const good = lowerBetter ? down : up;
  const cls = bad ? "flat" : (!up && !down) ? "flat" : good ? "up" : "down";
  const g = termKey ? glossaryLookup(termKey) : null;
  const hasDetail = base != null || current != null;
  const delta = base != null && current != null ? Number(current) - Number(base) : null;
  const interactive = hasDetail || g;
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  // portal the popover so a table's overflow can never clip it
  const show = () => { const el = ref.current; if (el) setPos(anchorPos(el.getBoundingClientRect())); };
  const hide = () => setPos(null);
  return (
    <motion.span ref={ref} className={`pill dpill ${cls} ${interactive ? "dpill-x" : ""}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}
      tabIndex={interactive ? 0 : undefined}
      onMouseEnter={interactive ? show : undefined} onMouseLeave={interactive ? hide : undefined}
      onFocus={interactive ? show : undefined} onBlur={interactive ? hide : undefined}>
      {tag && <b className="dpill-tag">{tag}</b>}
      {up && <ChevronUp size={11} />}{down && <ChevronDown size={11} />}
      {bad ? "—" : <CountUp value={Math.abs(value) * 100} format={(v) => v.toFixed(1) + "%"} />}
      {interactive && pos && createPortal(
        <span className={`dpill-pop gpop ${pos.above ? "above" : "below"}`} role="tooltip"
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.w, transform: pos.above ? "translateY(-100%)" : "none" }}>
          <span className="dpill-pop-card">
            {g && <span className="dpill-pop-h">{g.full}</span>}
            {current != null && <span className="dpill-row"><em>{curLabel || "This period"}</em><b>{fmt(current)}</b></span>}
            {base != null && <span className="dpill-row"><em>{baseLabel || "Compared with"}</em><b>{fmt(base)}</b></span>}
            {delta != null && <span className="dpill-row delta"><em>Difference</em><b>{(delta >= 0 ? "+" : "−") + fmt(Math.abs(delta))}</b></span>}
            {g && <span className="dpill-def">{g.en}</span>}
          </span>
          <span className="gpop-arrow" style={{ left: pos.arrowX }} />
        </span>,
        document.body
      )}
    </motion.span>
  );
}

export function Skeleton({ w = "100%", h = 16, style }) {
  return <span className="sk" style={{ display: "block", width: w, height: h, ...style }} />;
}

// deterministic brand "logo" chip (initials on a colour from the name)
// remembers which logo files 404'd so we stop re-requesting them (quiet fallback)
const LOGO_MISSING = new Set();

// A brand/channel mark: tries the real logo file, falls back to a colour monogram.
export function LogoBadge({ src, color, ink = "#fff", label = "?", size = 24, round = 8, title }) {
  const [failed, setFailed] = useState(() => !src || LOGO_MISSING.has(src));
  const box = { width: size, height: size, borderRadius: round, flex: `0 0 ${size}px` };
  if (failed) {
    return (
      <span className="logomark mono" title={title} style={{ ...box, background: `linear-gradient(150deg, ${color}, ${shade(color, -22)})`, color: ink, fontSize: Math.max(8, Math.round(size * 0.38)) }}>
        {label}
      </span>
    );
  }
  return (
    <span className="logomark" title={title} style={box}>
      <img src={src} alt={title || label} loading="lazy" onError={() => { LOGO_MISSING.add(src); setFailed(true); }} />
    </span>
  );
}

export function Logo({ name = "", size = 34 }) {
  const m = brandMeta(name);
  return <LogoBadge src={brandSrc(name)} color={m.c} ink={m.ink} label={m.ab} size={size} round={Math.round(size * 0.29)} title={name} />;
}
export function BrandMark({ name = "", size = 22 }) {
  const m = brandMeta(name);
  return <LogoBadge src={brandSrc(name)} color={m.c} ink={m.ink} label={m.ab} size={size} round={Math.round(size * 0.3)} title={name} />;
}
export function ChannelMark({ name = "", size = 22 }) {
  const m = channelMeta(name);
  return <LogoBadge src={channelSrc(name)} color={m.c} ink={m.ink} label={m.ab} size={size} round={Math.round(size * 0.3)} title={name} />;
}
// company mark — used for the "All Brands" scope
export function CompanyMark({ size = 22 }) {
  return <LogoBadge src={COMPANY_LOGO} color="#12B76A" ink="#fff" label="SW" size={size} round={Math.round(size * 0.3)} title="SWiSH — All Brands" />;
}

// Custom brand slicer — native <select> can't show images, so this is a button +
// popover where the current brand AND every option shows its real logo.
export function BrandSelect({ value = "all", brands = [], onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", esc); };
  }, []);
  // single-brand users have no "All Brands" scope — they only ever see their brand
  const options = brands.length === 1 ? brands.map((b) => ({ v: b, label: b })) : [{ v: "all", label: "All Brands" }, ...brands.map((b) => ({ v: b, label: b }))];
  const curLabel = value === "all" ? "All Brands" : value;
  const markFor = (v, size) => (v === "all" ? <CompanyMark size={size} /> : <BrandMark name={v} size={size} />);
  const btnRef = useRef(null);
  const [pos, setPos] = useState(null);
  // fixed-position the menu from the button rect + portal to <body>, so no page
  // stacking context (sticky command bar, KPI cards) can ever cover it.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => { const b = btnRef.current; if (!b) return; const r = b.getBoundingClientRect();
      setPos({ position: "fixed", top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), zIndex: 3000 }); };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  return (
    <div className={`brandsel2 ${value !== "all" ? "on" : ""}`} ref={ref}>
      <button ref={btnRef} type="button" className="brandsel2-btn" onClick={() => setOpen((o) => !o)} title="Scope the whole platform to a brand">
        {markFor(value, 20)}
        <span className="brandsel2-name">{curLabel}</span>
        <ChevronDown size={14} className={`brandsel2-caret ${open ? "up" : ""}`} />
      </button>
      {open && pos && createPortal(
        <motion.div className="brandsel2-pop" style={pos} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14 }}
          onMouseDown={(e) => e.stopPropagation()}>
          {options.map((o) => (
            <button key={o.v} className={`brandsel2-opt ${o.v === value ? "sel" : ""}`} onClick={() => { onChange && onChange(o.v); setOpen(false); }}>
              {markFor(o.v, 18)}<span>{o.label}</span>
            </button>
          ))}
        </motion.div>,
        document.body
      )}
    </div>
  );
}

// Order-source slicer — same look as BrandSelect, with each channel's real logo.
// `sources` should already be filtered to channels with sales for the selection.
export function SourceSelect({ value = "all", sources = [], onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null), btnRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", esc); };
  }, []);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => { const b = btnRef.current; if (!b) return; const r = b.getBoundingClientRect();
      setPos({ position: "fixed", top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), zIndex: 3000 }); };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  const options = [{ v: "all", label: "All Sources" }, ...sources.map((s) => ({ v: s, label: s }))];
  const markFor = (v, size) => (v === "all" ? <CompanyMark size={size} /> : <ChannelMark name={v} size={size} />);
  const curLabel = value === "all" ? "All Sources" : value;
  return (
    <div className={`brandsel2 ${value !== "all" ? "on" : ""}`} ref={ref}>
      <button ref={btnRef} type="button" className="brandsel2-btn" onClick={() => setOpen((o) => !o)} title="Filter by order source">
        {markFor(value, 20)}
        <span className="brandsel2-name">{curLabel}</span>
        <ChevronDown size={14} className={`brandsel2-caret ${open ? "up" : ""}`} />
      </button>
      {open && pos && createPortal(
        <motion.div className="brandsel2-pop" style={pos} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14 }}
          onMouseDown={(e) => e.stopPropagation()}>
          {options.map((o) => (
            <button key={o.v} className={`brandsel2-opt ${o.v === value ? "sel" : ""}`} onClick={() => { onChange && onChange(o.v); setOpen(false); }}>
              {markFor(o.v, 18)}<span>{o.label}</span>
            </button>
          ))}
          {!sources.length && <div className="brandsel2-opt" style={{ opacity: .6, cursor: "default" }}>No sources with sales</div>}
        </motion.div>,
        document.body
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- KPI/hero */
export function Kpi({ index, label, value, format, foot, sub, live, loading }) {
  return (
    <Card index={index}>
      <div className="kpi-label"><span className="uplabel">{label}</span>{live && <LiveDot />}</div>
      {loading ? <Skeleton w="60%" h={30} /> : <CountUp className="kpi-val num" value={value} format={format} />}
      <div className="kpi-foot">{foot}{sub && <span className="kpi-sub">{sub}</span>}</div>
    </Card>
  );
}

export function Hero({ index, label, value, format, deltaText, deltaValue, sub, dark }) {
  return (
    <Card index={index} dark={dark}>
      <div className="kpi-label"><span className="uplabel">{label}</span><LiveDot /></div>
      <CountUp className="hero-val num" value={value} format={format} />
      <div className="hero-sub" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {(deltaText != null || deltaValue != null) && <Pill text={deltaText} value={deltaValue} />}
        {sub && <span>{sub}</span>}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- charts */
export function EChart({ option, height = 260, onEvents, ...rest }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const opt = useMemo(() => ({
    animation: !reduce, animationDuration: 700, animationEasing: "cubicOut",
    textStyle: { fontFamily: T.font },
    ...option,
  }), [option, reduce]);
  // Force the tooltip to hide when the pointer leaves the chart. Without this the
  // SVG-renderer tooltip can linger ("stuck") when the cursor exits quickly or the
  // chart lives in a scrollable modal.
  const hideTip = () => { try { ref.current?.getEchartsInstance()?.dispatchAction({ type: "hideTip" }); } catch { /* ignore */ } };
  const chart = <ReactECharts ref={ref} option={opt} style={{ height, width: "100%" }} notMerge lazyUpdate opts={{ renderer: "svg" }} onEvents={onEvents} />;
  // always wrap so we can catch mouseleave (and land any DOM props on a real node)
  return <div style={{ width: "100%" }} onMouseLeave={hideTip} {...rest}>{chart}</div>;
}

// pre-built option factories in the design-system style
export const barOption = ({ data, horizontal = true, fmt = kd, color = T.green, colors, inverse = false }) => {
  const cats = data.map((d) => d.label);
  const radius = horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0];
  const vals = data.map((d, i) => (colors ? { value: d.value, itemStyle: { color: colors[i], borderRadius: radius } } : d.value));
  return {
    grid: { left: horizontal ? 8 : 8, right: 16, top: 10, bottom: horizontal ? 8 : 24, containLabel: true },
    tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: fmt },
    xAxis: horizontal ? { type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } }
                       : { type: "category", data: cats, ...axisBase, splitLine: { show: false } },
    yAxis: horizontal ? { type: "category", data: cats, inverse, ...axisBase, splitLine: { show: false } }
                      : { type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } },
    series: [{ type: "bar", data: vals, itemStyle: { color, borderRadius: radius }, barMaxWidth: 26 }],
  };
};

export const lineOption = ({ data, fmt = kd, color = T.green, area = true }) => ({
  grid: { left: 8, right: 16, top: 12, bottom: 8, containLabel: true },
  tooltip: { ...tooltipBase, trigger: "axis", valueFormatter: fmt },
  xAxis: { type: "category", data: data.map((d) => d.x), boundaryGap: false, ...axisBase, splitLine: { show: false } },
  yAxis: { type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } },
  series: [{
    type: "line", data: data.map((d) => d.value), smooth: true, symbol: "circle", symbolSize: 6, showSymbol: false,
    lineStyle: { color, width: 2.4 }, itemStyle: { color },
    areaStyle: area ? { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: color + "33" }, { offset: 1, color: color + "00" }] } } : undefined,
  }],
});

// multiple lines sharing one x axis (actual vs target vs forecast, overlays, …)
export const multiLineOption = ({ x, series, fmt = kd, rightFmt, extraRows }) => {
  const hasRight = series.some((s) => s.yAxisIndex === 1);
  return {
    grid: { left: 8, right: hasRight ? 42 : 16, top: 26, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: "axis", formatter: (ps) => {
      const head = ps[0]?.axisValue ?? "";
      const body = ps.map((p) => { const v = p.value; const val = v == null ? "—" : /%/.test(p.seriesName) ? (Math.round(v * 10) / 10) + "%" : fmt(v);
        return `<div style="display:flex;justify-content:space-between;gap:18px"><span>${p.marker} ${p.seriesName}</span><b>${val}</b></div>`; }).join("");
      // non-plotted values (e.g. ACC / PV) shown for the hovered point only
      let extra = "";
      if (extraRows && extraRows.length && ps.length) {
        const i = ps[0].dataIndex;
        const lines = extraRows.map((er) => { const v = er.data ? er.data[i] : null; const val = v == null ? "—" : (er.fmt ? er.fmt(v) : fmt(v));
          return `<div style="display:flex;justify-content:space-between;gap:18px;opacity:.82"><span>${er.label}</span><b>${val}</b></div>`; }).join("");
        if (lines) extra = `<div style="border-top:1px solid rgba(140,150,170,.28);margin-top:4px;padding-top:3px">${lines}</div>`;
      }
      return `<div style="font-weight:700;margin-bottom:3px">${head}</div>${body}${extra}`;
    } },
    legend: { top: 0, right: 4, icon: "roundRect", itemWidth: 11, itemHeight: 4, itemGap: 14, textStyle: { color: T.muted, fontFamily: T.font, fontSize: 11 } },
    xAxis: { type: "category", data: x, boundaryGap: false, ...axisBase, splitLine: { show: false } },
    yAxis: hasRight
      ? [{ type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } },
         { type: "value", ...axisBase, position: "right", splitLine: { show: false }, axisLabel: { ...axisBase.axisLabel, formatter: rightFmt || ((v) => v + "%") } }]
      : { type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } },
    series: series.map((s) => ({
      name: s.name, type: "line", data: s.data, smooth: true, showSymbol: false, connectNulls: false,
      yAxisIndex: s.yAxisIndex || 0, stack: s.stack,
      lineStyle: { color: s.color, width: s.stack ? 0 : (s.width || 2.2), type: s.dashed ? "dashed" : "solid" },
      itemStyle: { color: s.color },
      areaStyle: (s.area || s.stack) ? { color: s.stack ? s.color + "cc" : { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: s.color + "2e" }, { offset: 1, color: s.color + "00" }] } } : undefined,
    })),
  };
};

// grouped/clustered columns — several series share the x categories (period comparisons)
export const groupedBarOption = ({ cats, series, fmt = kd, horizontal = false }) => ({
  grid: { left: 8, right: 16, top: 26, bottom: 8, containLabel: true },
  tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: fmt },
  legend: { top: 0, right: 4, icon: "roundRect", itemWidth: 11, itemHeight: 6, itemGap: 14, textStyle: { color: T.muted, fontFamily: T.font, fontSize: 11 } },
  xAxis: horizontal ? { type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } }
                    : { type: "category", data: cats, ...axisBase, splitLine: { show: false } },
  yAxis: horizontal ? { type: "category", data: cats, ...axisBase, splitLine: { show: false } }
                    : { type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } },
  series: series.map((s) => ({ name: s.name, type: "bar", data: s.data, itemStyle: { color: s.color, borderRadius: horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0] }, barMaxWidth: 22 })),
});

// clustered-column + line combo (today's bars vs comparison lines)
export const comboOption = ({ x, barName, bar, lines = [], fmt = kd }) => ({
  grid: { left: 8, right: 16, top: 26, bottom: 8, containLabel: true },
  tooltip: { ...tooltipBase, trigger: "axis", valueFormatter: fmt },
  legend: { top: 0, right: 4, icon: "roundRect", itemWidth: 11, itemHeight: 6, itemGap: 14, textStyle: { color: T.muted, fontFamily: T.font, fontSize: 11 } },
  xAxis: { type: "category", data: x, ...axisBase, splitLine: { show: false } },
  yAxis: { type: "value", ...axisBase, axisLabel: { ...axisBase.axisLabel, formatter: kk } },
  series: [
    { name: barName, type: "bar", data: bar, itemStyle: { color: T.green, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 18 },
    ...lines.map((l) => ({ name: l.name, type: "line", data: l.data, smooth: true, showSymbol: false, connectNulls: false,
      lineStyle: { color: l.color, width: 2, type: l.dashed ? "dashed" : "solid" }, itemStyle: { color: l.color } })),
  ],
});

// radial achievement gauge — value is a percentage, 100 = target met.
// progress arc + number both animate on mount / value change (respects reduced-motion via EChart).
export const gaugeOption = ({ value = 0, target = 100, big = false }) => {
  // iOS Fitness "activity ring" look — a bright two-stop gradient ring with a neon
  // glow. Fluorescent green on target, vivid amber mid, hot pink-red low.
  const p = target ? (value / target) * 100 : value;
  const stops = p >= 100 ? ["#30F27A", "#00E0A0"]        // fluorescent green → mint
    : p >= 85 ? ["#FFD426", "#FF7A00"]                    // vivid amber → orange
    : ["#FF2D74", "#FF6B9D"];                             // iOS hot pink-red
  const grad = { type: "linear", x: 0, y: 0, x2: 1, y2: 1, colorStops: [{ offset: 0, color: stops[0] }, { offset: 1, color: stops[1] }] };
  const w = big ? 15 : 12;
  return {
    series: [{
      // full-round ring: 360° track, rounded progress cap, % in centre
      type: "gauge", startAngle: 90, endAngle: -270, min: 0, max: 100,
      radius: big ? "94%" : "90%", center: ["50%", "50%"],
      progress: { show: true, width: w, roundCap: true, itemStyle: { color: grad, shadowColor: stops[1], shadowBlur: 5 } },
      axisLine: { lineStyle: { width: w, color: [[1, T.line]] } },
      pointer: { show: false }, anchor: { show: false },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      title: { show: false },
      detail: { valueAnimation: true, offsetCenter: [0, 0], formatter: () => Math.round(value) + "%", fontSize: big ? 26 : 21, fontWeight: 800, color: stops[0], fontFamily: T.font },
      data: [{ value: Math.min(value, 100) }],
    }],
  };
};

// treemap — proportional contribution (branch share of sales)
export const treemapOption = ({ data, fmt = kd, activeName }) => ({
  tooltip: { ...tooltipBase, trigger: "item", formatter: (p) => `${p.name}<br/>${fmt(p.value)} · ${((p.data.pct || 0) * 100).toFixed(1)}%` },
  series: [{
    type: "treemap", roam: false, nodeClick: false, breadcrumb: { show: false }, width: "100%", height: "100%",
    label: { show: true, formatter: (p) => ((p.data.pct || 0) > 0.03 ? `${p.name}\n${((p.data.pct || 0) * 100).toFixed(0)}%` : ""), color: "#fff", fontFamily: T.font, fontSize: 11, fontWeight: 600, lineHeight: 14 },
    itemStyle: { borderColor: "#fff", borderWidth: 2, gapWidth: 2, borderRadius: 4 },
    data: data.map((d, i) => ({
      name: d.name, value: d.value, pct: d.pct,
      itemStyle: { color: d.color || T.cat[i % T.cat.length], borderColor: activeName === d.name ? "#0B1220" : "#fff", borderWidth: activeName === d.name ? 3 : 2, opacity: activeName && activeName !== d.name ? 0.45 : 1 },
    })),
  }],
});

// bubble scatter — x vs y per entity, bubble-sized by a third measure
export const scatterOption = ({ points, xName = "Orders", yName = "AOV", xfmt = num, yfmt = kdc, sizefmt = kd, activeName }) => {
  const maxS = Math.max(1, ...points.map((p) => p.size || 0));
  const rad = (s) => 9 + 40 * Math.sqrt((s || 0) / maxS);
  return {
    grid: { left: 8, right: 18, top: 14, bottom: 30, containLabel: true },
    tooltip: { ...tooltipBase, trigger: "item", formatter: (p) => `<b>${p.data.name}</b><br/>${xName}: ${xfmt(p.data.value[0])}<br/>${yName}: ${yfmt(p.data.value[1])}<br/>Sales: ${sizefmt(p.data.sales)}` },
    xAxis: { type: "value", name: xName, nameLocation: "middle", nameGap: 24, nameTextStyle: { color: T.muted, fontSize: 11 }, ...axisBase, splitLine: { show: true, lineStyle: { color: T.line } }, axisLabel: { ...axisBase.axisLabel, formatter: kk } },
    yAxis: { type: "value", name: yName, nameLocation: "middle", nameGap: 34, nameTextStyle: { color: T.muted, fontSize: 11 }, ...axisBase, splitLine: { show: true, lineStyle: { color: T.line } } },
    series: [{
      type: "scatter",
      data: points.map((p) => ({
        name: p.name, value: [p.x || 0, p.y || 0], sales: p.size, symbolSize: rad(p.size),
        itemStyle: { color: p.color || T.green, opacity: activeName && activeName !== p.name ? 0.3 : 0.72, borderColor: activeName === p.name ? "#0B1220" : "#fff", borderWidth: activeName === p.name ? 2.5 : 1 },
      })),
    }],
  };
};

export const donutOption = ({ data, fmt = kd, colors }) => ({
  tooltip: { ...tooltipBase, trigger: "item", valueFormatter: fmt },
  legend: { bottom: 0, icon: "circle", textStyle: { color: T.muted, fontFamily: T.font, fontSize: 11 } },
  color: colors || T.cat,
  series: [{
    type: "pie", radius: ["52%", "74%"], center: ["50%", "44%"], avoidLabelOverlap: true,
    itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 6 },
    label: { show: false }, labelLine: { show: false },
    data: data.map((d, i) => ({ name: d.label, value: d.value, itemStyle: colors ? { color: colors[i] } : undefined })),
  }],
});

// hour heatmap (single column when one day) rendered as a horizontal bar strip is clearer;
// but we keep a compact heatmap for the hour×day matrices
// `labelFmt` keeps in-cell numbers compact (12.4k) while the tooltip shows the
// full figure. `cellNote` adds a second tooltip line, e.g. the compared value.
export const heatOption = ({ data, fmt = kd, labelFmt = kk, showLabels = true, cellNote, xRotate = 0 }) => {
  const rows = [...new Set(data.map((d) => String(d.row)))];
  const cols = [...new Set(data.map((d) => String(d.col)))];
  const vals = data.map((d) => Number(d.value) || 0);
  const max = Math.max(1, ...vals);
  const byKey = new Map(data.map((d) => [`${d.col}|${d.row}`, d]));
  return {
    grid: { left: 10, right: 12, top: xRotate ? 92 : 26, bottom: 26, containLabel: true },
    tooltip: {
      ...tooltipBase,
      formatter: (p) => {
        const [c, r, v] = p.value;
        const d = byKey.get(`${c}|${r}`) || {};
        const note = cellNote ? cellNote(d) : "";
        return `<b>${r} · ${c}</b><br/>${fmt(v)}${note ? `<br/>${note}` : ""}`;
      },
    },
    xAxis: { type: "category", data: cols, position: "top", axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: T.muted, fontSize: 11, fontFamily: T.font, fontWeight: 700, interval: 0, rotate: xRotate, hideOverlap: false }, splitLine: { show: false } },
    yAxis: { type: "category", data: rows, axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: T.muted, fontSize: 10.5, fontFamily: T.font }, splitLine: { show: false } },
    // ramp anchored to the live accent so it follows the brand AND the dark theme
    visualMap: { min: 0, max, show: false, inRange: { color: [T.accentSoft, T.accent, shade(T.accent, -34)] } },
    series: [{
      type: "heatmap",
      data: data.map((d) => [String(d.col), String(d.row), Number(d.value) || 0]),
      label: {
        show: showLabels,
        formatter: (p) => (p.value[2] ? labelFmt(p.value[2]) : ""),
        fontSize: 10, fontFamily: T.font, fontWeight: 600,
        // contrast has to flip on the dark end of the ramp; in dark mode the whole
        // ramp is dark, so light text is always correct there
        color: (p) => {
          const isDark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
          if (isDark) return T.ink;
          return (Number(p.value[2]) || 0) / max > 0.5 ? "#fff" : T.ink;
        },
        textBorderWidth: 0,
      },
      // a bigger gap (thicker card-coloured border) is what makes it read as tidy
      // tiles instead of a cramped grid
      itemStyle: { borderColor: T.card, borderWidth: 3, borderRadius: 6 },
      emphasis: { itemStyle: { borderColor: T.ink900, borderWidth: 2 } },
    }],
  };
};

/* ---------------------------------------------------------------- data grid */
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// columns: [{ key, label, align:'l'|'r', type:'text'|'num'|'kd'|'kdc'|'pct', render?, exportVal? }]
export function DataGrid({ columns, rows, totalRow, filename = "export", defaultSort, rank = true, rowClass, title, onRowClick, activeKey }) {
  const reduce = useReducedMotion();
  const [sort, setSort] = useState(defaultSort || { key: columns[1]?.key, dir: "desc" });
  const col = columns.find((c) => c.key === sort.key) || columns[0];
  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = sortVal(col, a), vb = sortVal(col, b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, sort, col]);

  function toggle(key) {
    const c = columns.find((x) => x.key === key);
    setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: c?.type === "text" ? "asc" : "desc" });
  }
  function exportCsv() {
    const lines = [columns.map((c) => csvCell(c.label)).join(",")];
    sorted.forEach((r) => lines.push(columns.map((c) => csvCell(c.exportVal ? c.exportVal(r) : r[c.key])).join(",")));
    const blob = new Blob([String.fromCharCode(0xfeff) + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `${filename}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="card-head">
        <span className="card-title">{title || filename.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())}</span>
        <motion.button className="btn" whileTap={{ scale: 0.96 }} onClick={exportCsv} disabled={!sorted.length}>
          <Download size={13} /> Export to Excel
        </motion.button>
      </div>
      <div className="dt-wrap">
        <table className="dt">
          <thead>
            <tr>
              {rank && <th className="dt-rank">#</th>}
              {columns.map((c) => (
                <th key={c.key} className={`dt-th ${c.align || "l"} ${sort.key === c.key ? "active" : ""}`} onClick={() => toggle(c.key)} title={c.tip}>
                  <span className="dt-thead"><TermHead label={c.label} termKey={c.term} />
                    {sort.key === c.key ? (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ChevronsUpDown size={12} className="dt-sortidle" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td className="dt-empty" colSpan={columns.length + (rank ? 1 : 0)}>No rows</td></tr>
            ) : sorted.map((r, i) => {
              // layout animation is a per-row spring — fine for small tables, but on large grids
              // it janks and leaves ghost rows stuck at the top when sorting. Use a plain <tr>
              // (no framer-motion) past a threshold so sorting just re-renders instantly.
              const animate = !reduce && sorted.length <= 50;
              const rowKey = r._k != null ? r._k : i;   // note: `|| i` mis-keys row whose _k === 0
              const cls = `${rowClass ? rowClass(r) : ""} ${onRowClick ? "dt-click" : ""} ${activeKey && r._k === activeKey ? "dt-active" : ""}`;
              const cells = (<>
                {rank && <td className="dt-rank num">{i + 1}</td>}
                {columns.map((c) => <td key={c.key} className={c.align || "l"}>{renderCell(c, r)}</td>)}
              </>);
              const onClick = onRowClick ? () => onRowClick(r) : undefined;
              return animate
                ? <motion.tr key={rowKey} layout initial={false} transition={{ type: "spring", stiffness: 600, damping: 46 }} onClick={onClick} className={cls}>{cells}</motion.tr>
                : <tr key={rowKey} onClick={onClick} className={cls}>{cells}</tr>;
            })}
            {totalRow && sorted.length > 0 && (
              <tr className="dt-total">
                {rank && <td></td>}
                {columns.map((c) => <td key={c.key} className={c.align || "l"}>{c.total ? renderCell(c, totalRow) : (c === columns[0] ? "Total" : "")}</td>)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
function sortVal(col, row) {
  const v = row[col.key];
  if (col.type === "text") return String(v ?? "").toLowerCase();
  if (col.type === "pct") { const n = parseFloat(String(v).replace(/[^\d.\-]/g, "")); return isNaN(n) ? -Infinity : n; }
  return Number(v) || 0;
}

/* ---------------------------------------------------------------- matrix */
// Power BI matrix: rows grouped by a parent field (with per-group subtotals),
// child rows nested + indented, collapsible, grand-total, CSV export.
// measures: [{ key, label, align:'r', type:'kd'|'kdc'|'num'|'pct', total?:bool }]
// groupTotals: optional map { [groupValue]: measureRow } of DAX-evaluated subtotals
// (matches Power BI matrix — text/ratio measures recomputed at group grain).
// grandTotalRow: optional DAX-evaluated grand-total measure row. When either is
// absent the component falls back to summing the leaf rows client-side.
export function Matrix({ rows, groupKey, groupLabel, childKey, childLabel, subKey, subLabel, measures, filename = "export", grandTotal = true, groupTotals, grandTotalRow, onGroupClick, activeGroup, groupMark, childMark, groupInsight, openGroup, extraTotals = [] }) {
  const defaultKey = useMemo(() => (measures.find((m) => m.total) || measures[0])?.key, [measures]);
  // click any measure header to sort the whole matrix by it (group, subgroup and
  // child rows all follow). First click = descending, click again = ascending.
  const [sort, setSort] = useState({ key: defaultKey, dir: "desc" });
  const sumKey = sort.key || defaultKey;
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  const three = !!subKey; // optional third drill-down level (group › sub › child)
  const groups = useMemo(() => {
    // sum measures flagged total, plus any extraTotals keys (e.g. qty_w/_m/_y that
    // back the WoW/MoM/YoY delta columns but aren't visible measures themselves)
    const agg = (items) => { const o = {}; const keys = [...measures.filter((mm) => mm.total).map((mm) => mm.key), ...extraTotals]; keys.forEach((k) => { o[k] = items.reduce((s, r) => s + (Number(r[k]) || 0), 0); }); return o; };
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r, k) => { const v = Number(r?.[k]); return isFinite(v) ? v : (r?.[k] ?? ""); };
    const cmp = (av, bv) => (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))) * dir;
    const bySort = (a, b) => cmp(val(a.sub, sumKey), val(b.sub, sumKey));
    const byRow = (a, b) => cmp(val(a, sumKey), val(b, sumKey));
    const m = new Map();
    for (const r of rows) { const g = r[groupKey] ?? "—"; (m.get(g) || m.set(g, []).get(g)).push(r); }
    const arr = [...m.entries()].map(([g, items]) => {
      const computed = { [groupKey]: g, ...agg(items) };
      const sub = groupTotals && groupTotals[g] ? groupTotals[g] : computed;
      let subgroups = null;
      if (three) {
        const sm = new Map();
        for (const r of items) { const s = r[subKey] ?? "—"; (sm.get(s) || sm.set(s, []).get(s)).push(r); }
        subgroups = [...sm.entries()].map(([sg, si]) => {
          si.sort(byRow);
          return { sg, items: si, sub: agg(si) };
        }).sort(bySort);
      }
      items.sort(byRow);
      return { g, items, subgroups, sub };
    });
    arr.sort(bySort);
    return arr;
  }, [rows, groupKey, subKey, three, measures, sumKey, sort.dir, groupTotals]);

  const [expandedSub, setExpandedSub] = useState({}); // "group||sub" -> expanded?
  const [expanded, setExpanded] = useState({}); // group -> expanded? (default: all collapsed)
  // auto-expand a group (e.g. the brand chosen in the global Brand filter)
  useEffect(() => { if (openGroup) setExpanded((o) => (o[openGroup] ? o : { ...o, [openGroup]: true })); }, [openGroup]);
  const allExpanded = groups.length > 0 && groups.every((g) => expanded[g.g]);
  const toggleAll = () => setExpanded(allExpanded ? {} : Object.fromEntries(groups.map((g) => [g.g, true])));
  const total = useMemo(() => {
    if (grandTotalRow) return grandTotalRow;
    const t = {};
    measures.forEach((mm) => { if (mm.total) t[mm.key] = rows.reduce((s, r) => s + (Number(r[mm.key]) || 0), 0); });
    return t;
  }, [rows, measures, grandTotalRow]);

  function exportCsv() {
    const cols = three ? [{ label: groupLabel }, { label: subLabel }, { label: childLabel }, ...measures] : [{ label: groupLabel }, { label: childLabel }, ...measures];
    const lines = [cols.map((c) => csvCell(c.label)).join(",")];
    const mv = (r) => measures.map((m) => csvCell(m.exportVal ? m.exportVal(r) : r[m.key]));
    if (three) groups.forEach((grp) => grp.subgroups.forEach((sg) => sg.items.forEach((r) =>
      lines.push([csvCell(grp.g), csvCell(sg.sg), csvCell(r[childKey]), ...mv(r)].join(",")))));
    else groups.forEach((grp) => grp.items.forEach((r) =>
      lines.push([csvCell(grp.g), csvCell(r[childKey]), ...mv(r)].join(","))));
    const blob = new Blob([String.fromCharCode(0xfeff) + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `${filename}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  const measCells = (row) => measures.map((c) => <td key={c.key} className={c.align || "r"}>{(c.always || row[c.key] != null) ? renderCell(c, row) : ""}</td>);

  return (
    <>
      <div className="card-head">
        <span className="card-title">{filename.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <motion.button className="btn" whileTap={{ scale: 0.96 }} onClick={toggleAll} disabled={!groups.length}>
            {allExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
            {allExpanded ? "Collapse all" : "Expand all"}
          </motion.button>
          <motion.button className="btn" whileTap={{ scale: 0.96 }} onClick={exportCsv} disabled={!rows.length}>
            <Download size={13} /> Export to Excel
          </motion.button>
        </div>
      </div>
      <div className="dt-wrap">
        <table className="dt mx">
          <thead>
            <tr>
              <th className="dt-th l">{groupLabel} <span className="mx-sub">/ {three ? `${subLabel} / ${childLabel}` : childLabel}</span></th>
              {measures.map((c) => (
                <th key={c.key} className={`dt-th ${c.align || "r"} ${sumKey === c.key ? "active" : ""}`} title={c.tip} onClick={() => toggleSort(c.key)} style={{ cursor: "pointer" }}>
                  <span className="dt-thead"><TermHead label={c.label} termKey={c.term} />
                    {sumKey === c.key ? (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ChevronsUpDown size={12} className="dt-sortidle" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr><td className="dt-empty" colSpan={measures.length + 1}>No rows</td></tr>
            ) : groups.map((grp) => {
              const isOpen = expanded[grp.g];
              const toggleOne = (e) => { e.stopPropagation(); setExpanded((o) => ({ ...o, [grp.g]: !o[grp.g] })); };
              return (
                <React.Fragment key={grp.g}>
                  <tr className={`mx-group ${onGroupClick ? "mx-click" : ""} ${activeGroup === grp.g ? "mx-active" : ""}`}
                    onClick={() => (onGroupClick ? onGroupClick(grp.g) : setExpanded((o) => ({ ...o, [grp.g]: !o[grp.g] })))}>
                    <td className="l mx-gname">
                      <button className="mx-exp" onClick={toggleOne} aria-label="expand">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                      {groupMark && groupMark(grp.g)}<span className="mx-gtext">{grp.g}</span><span className="mx-count">{grp.items.length}</span>
                    </td>
                    {measCells(grp.sub)}
                  </tr>
                  {isOpen && groupInsight && groupInsight(grp.g) && (
                    <tr className="mx-insight-row">
                      <td className="mx-insight" colSpan={measures.length + 1}>
                        <span className="mx-insight-badge">INSIGHT</span>{groupInsight(grp.g)}
                      </td>
                    </tr>
                  )}
                  {isOpen && !three && grp.items.map((r, i) => (
                    <tr key={i} className="mx-child">
                      <td className="l mx-cname">{childMark && childMark(r)}{r[childKey]}</td>
                      {measCells(r)}
                    </tr>
                  ))}
                  {isOpen && three && grp.subgroups.map((sg) => {
                    const sk = grp.g + "||" + sg.sg;
                    const subOpen = expandedSub[sk];
                    return (
                      <React.Fragment key={sk}>
                        <tr className="mx-child mx-click" onClick={() => setExpandedSub((o) => ({ ...o, [sk]: !o[sk] }))}>
                          <td className="l mx-cname">
                            <button className="mx-exp" onClick={(e) => { e.stopPropagation(); setExpandedSub((o) => ({ ...o, [sk]: !o[sk] })); }} aria-label="expand">{subOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
                            <span className="mx-gtext">{sg.sg}</span><span className="mx-count">{sg.items.length}</span>
                          </td>
                          {measCells(sg.sub)}
                        </tr>
                        {subOpen && sg.items.map((r, i) => (
                          <tr key={i} className="mx-child">
                            <td className="l mx-cname" style={{ paddingLeft: 62 }}>{childMark && childMark(r)}{r[childKey]}</td>
                            {measCells(r)}
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}
            {grandTotal && groups.length > 0 && (
              <tr className="dt-total">
                <td className="l">Total</td>
                {measures.map((c) => <td key={c.key} className={c.align || "r"}>{(c.always || total[c.key] != null) ? renderCell(c, total) : ""}</td>)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
function renderCell(c, r) {
  if (c.render) return c.render(r);
  const v = r[c.key];
  if (c.type === "pct") return <Pill text={v} />;
  if (c.type === "kd") return <span className="num">{kd(v)}</span>;
  if (c.type === "kdc") return <span className="num">{kdc(v)}</span>;
  if (c.type === "num") return <span className="num">{num(v)}</span>;
  return v;
}

/* ---------------------------------------------------------------- tabs */
export function Tabs({ tabs, active, onChange }) {
  return (
    <LayoutGroup id="tabs">
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${active === t.id ? "on" : ""}`} onClick={() => onChange(t.id)}>
            {t.label}
            {active === t.id && <motion.span layoutId="tab-underline" className="tab-underline" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
          </button>
        ))}
      </div>
    </LayoutGroup>
  );
}

// spring-based page swap with shared-layout so cards reposition fluidly
export function PageSwap({ id, children }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div key={id}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
        transition={{ type: "spring", stiffness: 360, damping: 30 }}>
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

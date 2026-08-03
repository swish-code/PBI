import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";

/* Step: { target, title, text, onEnter?(actions), advanceOnClick?, cta?:{label, run(actions)} }
   target = a data-tour key, or "page" for a full-screen overview step. */
export const TOURS = {
  landing: [
    { target: "page", title: "Welcome to Analysis Lab", text: "This is your personal analytics workspace — build custom dashboards with no coding. Let's take a quick tour of each part." },
    { target: "my-analyses", title: "My Analyses", text: "This area lists all the dashboards you've saved. Each card is one analysis you created." },
    { target: "analysis-card", title: "Analysis Card", text: "Each card is one dashboard — its name, a thumbnail of the charts inside, the date, and how many visuals it has. Click to open it; hover for delete." },
    { target: "new-analysis", title: "+ New Analysis", text: "Click here to create a brand-new dashboard. It opens the editor where you add visuals, arrange them, and save." },
    { target: "page", title: "You're all set", text: "That's the landing page! Ready to build your first analysis? Continue into the editor tutorial.", cta: { label: "Go to Editor", run: (a) => a.goEditor() } },
  ],
  editor: [
    { target: "editor", title: "Editor Overview", text: "This is the Analysis Editor. The left sidebar manages your visuals, the center canvas is your dashboard, and the top bar has layout, save and back." },
    { target: "editor-sidebar", title: "Left Sidebar", text: "The sidebar shows every visual in this analysis. Click 'Add Visual' to create a new chart." },
    { target: "add-visual", title: "Add Visual", text: "Click this to open the visual builder — you'll pick measures (metrics), dimensions (groups) and a chart type.", advanceOnClick: true, onEnter: (a) => a.closeBuilder() },
    { target: "builder-measures", title: "Measures", text: "Measures are the numbers you analyze — Net Sales, Orders, AOV. We've pre-selected 'Net Sales' (total revenue) for this demo.", onEnter: (a) => a.openBuilderDemo() },
    { target: "builder-dims", title: "Dimensions", text: "Dimensions group your data — by Brand, Location, Channel or Date. We've picked 'Brand' so you'll see sales per restaurant brand." },
    { target: "builder-filters", title: "Filters", text: "Filters narrow the data — a specific brand, location or channel. Everything defaults to 'All'. The date comes from the top date picker." },
    { target: "builder-charttype", title: "Chart Type", text: "The builder recommends the best chart for your picks. One measure + one category → a Bar Chart, ideal for comparing brands. You can override it here." },
    { target: "builder-preview", title: "Live Preview", text: "The preview updates instantly as you configure. Right now it's a live bar chart of Net Sales by Brand, with an auto-generated insight below." },
    { target: "builder-add", title: "Add to Analysis", text: "Click to drop this visual onto your dashboard canvas.", advanceOnClick: true },
    { target: "canvas-visual", title: "Your First Visual", text: "It's on the canvas! Click it to edit, drag the ⠿ handle to reorder, or use the width buttons to resize. Add more visuals the same way.", onEnter: (a) => a.addDemo() },
    { target: "editor-toolbar", title: "Top Toolbar", text: "'Save' stores your dashboard, 'Back' returns to the landing page. Saved analyses appear as cards you can reopen any time." },
    { target: "editor-layout", title: "Layout Presets", text: "Use 1-, 2-, or 3-column presets to arrange the whole dashboard at once, or set each visual's width individually." },
    { target: "editor", title: "You're ready!", text: "That's it — you can now build a multi-visual dashboard. Give it a name up top and hit Save. Want the full written manual?", cta: { label: "Open Learn Guide", run: (a) => a.openLearn() } },
  ],
};

const KEY = (t) => "alab.tour." + t;
export const tourDone = (t) => { try { return localStorage.getItem(KEY(t) + ".done") === "1"; } catch { return false; } };
export const markDone = (t) => { try { localStorage.setItem(KEY(t) + ".done", "1"); } catch {} };
const saveStep = (t, s) => { try { localStorage.setItem(KEY(t) + ".step", String(s)); } catch {} };
export const lastStep = (t) => { try { return Math.max(0, parseInt(localStorage.getItem(KEY(t) + ".step") || "0", 10)); } catch { return 0; } };

const TIP_W = 320, TIP_H = 190, PAD = 6;

export default function Tour({ type, startStep = 0, actions, onClose }) {
  const steps = TOURS[type] || [];
  const [i, setI] = useState(Math.min(startStep, steps.length - 1));
  const [rect, setRect] = useState(null);
  const step = steps[i];
  const tipRef = useRef(null);

  const finish = useCallback((completed) => { if (completed) markDone(type); saveStep(type, 0); onClose && onClose(completed); }, [type, onClose]);
  const go = useCallback((n) => { if (n < 0 || n >= steps.length) return; setI(n); saveStep(type, n); }, [steps.length, type]);
  const next = useCallback(() => { i >= steps.length - 1 ? finish(true) : go(i + 1); }, [i, steps.length, go, finish]);
  const prev = useCallback(() => go(i - 1), [i, go]);

  // run the step's side-effect (open modal, add demo visual…) on enter
  useEffect(() => { if (step && step.onEnter) { try { step.onEnter(actions); } catch {} } }, [i]);

  // keep the spotlight glued to the (possibly animating) target
  useEffect(() => {
    let raf;
    const measure = () => {
      if (!step) return;
      if (step.target === "page") { setRect({ page: true }); }
      else {
        const el = document.querySelector(`[data-tour="${step.target}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
        } else setRect(null);
      }
      raf = requestAnimationFrame(measure);
    };
    // bring target into view first
    const el = step && step.target !== "page" && document.querySelector(`[data-tour="${step.target}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [i]);

  // click-to-advance on the highlighted element
  useEffect(() => {
    if (!step || !step.advanceOnClick) return;
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) return;
    const h = () => setTimeout(next, 260);   // let the click's own action run first
    el.addEventListener("click", h, { once: true });
    return () => el.removeEventListener("click", h);
  }, [i, rect, next, step]);

  // keyboard nav
  useEffect(() => {
    const h = (e) => { if (e.key === "ArrowRight") next(); else if (e.key === "ArrowLeft") prev(); else if (e.key === "Escape") finish(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [next, prev, finish]);

  if (!step) return null;
  const full = !rect || rect.page;
  // tooltip placement
  let tip = { left: window.innerWidth / 2 - TIP_W / 2, top: Math.max(90, window.innerHeight * 0.12) };
  if (!full) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (rect.left + rect.width + TIP_W + 16 < vw) tip = { left: rect.left + rect.width + 14, top: rect.top };
    else if (rect.left - TIP_W - 16 > 0) tip = { left: rect.left - TIP_W - 14, top: rect.top };
    else if (rect.top + rect.height + TIP_H + 16 < vh) tip = { left: rect.left, top: rect.top + rect.height + 14 };
    else tip = { left: rect.left, top: Math.max(12, rect.top - TIP_H - 14) };
    tip.left = Math.min(Math.max(12, tip.left), vw - TIP_W - 12);
    tip.top = Math.min(Math.max(12, tip.top), vh - TIP_H - 12);
  }

  return (
    <div className="tour-root">
      {/* dark mask with a cut-out hole (4 panels) so the target stays interactive */}
      {!full && rect && (
        <>
          <div className="tour-mask" style={{ top: 0, left: 0, width: "100%", height: Math.max(0, rect.top) }} onClick={() => finish(false)} />
          <div className="tour-mask" style={{ top: rect.top + rect.height, left: 0, width: "100%", bottom: 0 }} onClick={() => finish(false)} />
          <div className="tour-mask" style={{ top: rect.top, left: 0, width: Math.max(0, rect.left), height: rect.height }} onClick={() => finish(false)} />
          <div className="tour-mask" style={{ top: rect.top, left: rect.left + rect.width, right: 0, height: rect.height }} onClick={() => finish(false)} />
          <div className="tour-ring" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />
        </>
      )}
      {full && <div className="tour-mask tour-mask-soft" onClick={() => finish(false)} />}

      <AnimatePresence mode="wait">
        <motion.div key={i} ref={tipRef} className="tour-tip" style={{ left: tip.left, top: tip.top, width: TIP_W }}
          initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.16 }}>
          <div className="tour-tip-top">
            <span className="tour-step">Step {i + 1} of {steps.length}</span>
            <button className="tour-x" onClick={() => finish(false)} title="Skip tour"><X size={15} /></button>
          </div>
          <div className="tour-title">{step.title}</div>
          <div className="tour-text">{step.text}</div>
          <div className="tour-bar"><span style={{ width: ((i + 1) / steps.length) * 100 + "%" }} /></div>
          <div className="tour-nav">
            <button className="tour-btn ghost" onClick={prev} disabled={i === 0}><ChevronLeft size={14} /> Back</button>
            <button className="tour-btn ghost" onClick={() => go(0)} title="Restart"><RotateCcw size={13} /></button>
            <div className="spacer" />
            <button className="tour-btn ghost" onClick={() => finish(false)}>Skip</button>
            {step.cta
              ? <button className="tour-btn primary" onClick={() => { step.cta.run(actions); finish(true); }}>{step.cta.label}</button>
              : <button className="tour-btn primary" onClick={next}>{i >= steps.length - 1 ? "Done" : "Next"} <ChevronRight size={14} /></button>}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

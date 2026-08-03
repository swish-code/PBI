// ============================================================================
//  LEARN GUIDE — an in-page teaching walkthrough.
//  A floating "Learn this page" button opens a step-by-step guide that spotlights
//  each visual (dimming the rest) and explains it. Steps without a target show as
//  centred concept cards. Content lives in learnContent.js.
//
//  First visit to a page auto-offers the guide once (a gentle nudge, dismissible),
//  then never again unless the user clicks the button. Progress is remembered so
//  "completed" pages don't nag.
// ============================================================================
import React, { useState, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { GraduationCap, X, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { learnFor, LEARN_LANGS } from "./learnContent.js";

const savedLang = () => { try { const l = localStorage.getItem("learn-lang"); return LEARN_LANGS.some((x) => x.k === l) ? l : "en"; } catch { return "en"; } };

const seen = (page) => { try { return localStorage.getItem("learn-done-" + page) === "1"; } catch { return true; } };
const markSeen = (page) => { try { localStorage.setItem("learn-done-" + page, "1"); } catch {} };

// find the on-screen rect for a step's selector (first visible match)
function rectOf(selector) {
  if (!selector) return null;
  let el = null;
  for (const sel of selector.split(",")) {
    try { const found = document.querySelector(sel.trim()); if (found) { el = found; break; } } catch {}
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export default function LearnGuide({ page }) {
  const content = learnFor(page);
  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null);
  const [lang, setLang] = useState(savedLang);
  const pickLang = (k) => { setLang(k); try { localStorage.setItem("learn-lang", k); } catch {} };
  const tx = (v) => (v && typeof v === "object" ? (v[lang] || v.en) : v);   // resolve {en,ar,hi}
  const isRtl = lang === "ar";

  // first-visit nudge (once per page, after the page has had time to render)
  useEffect(() => {
    if (!content || seen(page)) return;
    const t = setTimeout(() => setNudge(true), 3500);
    return () => clearTimeout(t);
  }, [page, content]);

  const total = content ? content.steps.length : 0;
  const s = content && open ? content.steps[step] : null;

  // measure the spotlight target; re-measure on scroll/resize while open
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setRect(rectOf(s && s.selector));
    measure();
    // the target may still be animating in — settle after a beat
    const t = setTimeout(measure, 60);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { clearTimeout(t); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open, step, s]);

  // bring the target into view when it's off-screen
  useEffect(() => {
    if (!open || !s || !s.selector) return;
    const el = document.querySelector(s.selector.split(",")[0].trim());
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [open, step, s]);

  const start = useCallback(() => { setStep(0); setOpen(true); setNudge(false); }, []);
  const close = useCallback(() => { setOpen(false); markSeen(page); }, [page]);
  const next = useCallback(() => setStep((i) => (i + 1 < total ? i + 1 : (close(), i))), [total, close]);
  const prev = useCallback(() => setStep((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, prev, close]);

  if (!content) return null;

  // position the explanation card near the spotlight, or centred for concept steps
  const pad = 8;
  const cardPos = (() => {
    if (!rect) return { centred: true };
    const below = rect.top + rect.height + pad + 190 < window.innerHeight;
    return {
      centred: false,
      top: below ? rect.top + rect.height + pad : Math.max(12, rect.top - pad - 190),
      left: Math.min(Math.max(12, rect.left), window.innerWidth - 372),
    };
  })();

  const LangSwitch = ({ compact }) => (
    <div className={`learn-lang ${compact ? "compact" : ""}`} role="tablist" aria-label="Guide language">
      {LEARN_LANGS.map((l) => (
        <button key={l.k} role="tab" aria-selected={lang === l.k} className={lang === l.k ? "on" : ""}
          onClick={(e) => { e.stopPropagation(); pickLang(l.k); }}>{l.label}</button>
      ))}
    </div>
  );

  return (
    <>
      <button className="learn-fab top" onClick={start} title={`${tx(content.title)}`}>
        <GraduationCap size={15} /> Learn this page
      </button>

      {/* first-visit nudge */}
      <AnimatePresence>
        {nudge && !open && (
          <motion.div className="learn-nudge" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} dir={isRtl ? "rtl" : "ltr"}>
            <GraduationCap size={18} />
            <div>
              <b>{tx(content.title)}</b>
              <span>{tx(content.intro)}</span>
            </div>
            <div className="learn-nudge-btns">
              <button className="btn sm primary" onClick={start}>{tx({ en: "Show me", ar: "أرني", hi: "दिखाएँ" })}</button>
              <button className="btn sm" onClick={() => { setNudge(false); markSeen(page); }}>{tx({ en: "No thanks", ar: "لا شكراً", hi: "नहीं" })}</button>
            </div>
            <LangSwitch compact />
          </motion.div>
        )}
      </AnimatePresence>

      {/* the guided overlay */}
      {open && createPortal(
        <div className="learn-ov" role="dialog" aria-modal="true" aria-label={`${tx(content.title)} guide`}>
          {/* four dim panels around the spotlight (a cut-out mask), or a full dim for concept steps */}
          {rect ? (
            <>
              <div className="learn-dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - 6) }} onClick={close} />
              <div className="learn-dim" style={{ top: rect.top - 6, left: 0, width: Math.max(0, rect.left - 6), height: rect.height + 12 }} onClick={close} />
              <div className="learn-dim" style={{ top: rect.top - 6, left: rect.left + rect.width + 6, right: 0, height: rect.height + 12 }} onClick={close} />
              <div className="learn-dim" style={{ top: rect.top + rect.height + 6, left: 0, right: 0, bottom: 0 }} onClick={close} />
              <div className="learn-ring" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />
            </>
          ) : (
            <div className="learn-dim full" onClick={close} />
          )}

          <motion.div
            className={`learn-card ${cardPos.centred ? "centred" : ""}`}
            style={cardPos.centred ? undefined : { top: cardPos.top, left: cardPos.left }}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} key={step + lang}
            dir={isRtl ? "rtl" : "ltr"}
          >
            <div className="learn-card-h">
              <span className="learn-step">{step + 1} / {total}</span>
              <span className="learn-page">{tx(content.title)}</span>
              <LangSwitch />
              <button className="ic" onClick={close} aria-label="Close guide"><X size={16} /></button>
            </div>
            <h4>{tx(s.title)}</h4>
            <p>{tx(s.body)}</p>
            <div className="learn-card-f">
              <button className="btn sm" onClick={prev} disabled={step === 0}><ChevronLeft size={14} /> {tx({ en: "Back", ar: "رجوع", hi: "पीछे" })}</button>
              <div className="learn-dots">{content.steps.map((_, i) => <span key={i} className={i === step ? "on" : ""} onClick={() => setStep(i)} />)}</div>
              {step + 1 < total
                ? <button className="btn sm primary" onClick={next}>{tx({ en: "Next", ar: "التالي", hi: "आगे" })} <ChevronRight size={14} /></button>
                : <button className="btn sm primary" onClick={close}>{tx({ en: "Done", ar: "تم", hi: "पूर्ण" })} <Check size={14} /></button>}
            </div>
          </motion.div>
        </div>,
        document.body
      )}
    </>
  );
}

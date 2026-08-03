// ============================================================================
//  ENGAGEMENT — shared frontend layer
//  Reusable across every page: per-visual feedback, export logging, activity
//  logging, the notification bell, admin rating prompts, and the brand footer.
// ============================================================================
import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ThumbsUp, ThumbsDown, MessageSquarePlus, Star, X, Bell, Info, AlertTriangle,
  Megaphone, Send, Check, Download,
} from "lucide-react";

export const api = (url, opts) =>
  fetch(url, { credentials: "include", ...opts }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  });

const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

// short "range" object → the exact string a user was viewing when they acted
const rangeText = (sel) => (sel ? (sel.start ? (sel.start === sel.end ? sel.start : `${sel.start} → ${sel.end}`) : sel.preset || "today") : null);

// ---------------------------------------------------------------------------
//  ACTIVITY + EXPORT logging (fire-and-forget, batched)
// ---------------------------------------------------------------------------
let _buf = [];
let _timer = null;
// low-priority, keepalive beacon so telemetry never competes with data fetches
// for the browser's ~6 connections-per-origin or the server event loop
function beacon(url, body) {
  try { fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "include", keepalive: true, priority: "low" }).catch(() => {}); } catch {}
}
function flush() {
  if (!_buf.length) return;
  const events = _buf; _buf = []; _timer = null;
  beacon("/api/activity", { events });
}
export function logActivity(action, page, details, ms) {
  _buf.push({ action, page, details: details ?? null, ms: ms ?? null });
  if (!_timer) _timer = setTimeout(flush, 12000);   // batch generously; telemetry isn't urgent
  if (_buf.length >= 30) flush();
}
if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);

// track how long a page was open, log page_visit on unmount / change
export function usePageVisit(page) {
  useEffect(() => {
    if (!page) return;
    const t0 = Date.now();
    logActivity("page_visit", page, null, 0); // count the visit immediately
    return () => logActivity("page_visit", page, "dwell", Date.now() - t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
}

// call this from any export button
export function logExport({ visualId, visualName, page, format = "csv", sel, filters, rows }) {
  beacon("/api/exports", { visualId, visualName, page, format, dateRange: rangeText(sel), filters, rows });
  logActivity("feature", page, "export:" + (visualName || visualId));
}

// ---------------------------------------------------------------------------
//  SECTION 2/4: PER-VISUAL FEEDBACK  <VisualFeedback id name description page sel/>
// ---------------------------------------------------------------------------
export function VisualFeedback({ id, name, description, page, sel }) {
  const [open, setOpen] = useState(false);
  const [quick, setQuick] = useState(null);          // last quick thumb sent
  const send = (patch) =>
    post("/api/feedback", { scope: "visual", visualId: id, visualName: name, page, dateRange: rangeText(sel), ...patch }).catch(() => {});

  const thumb = (vote) => { setQuick(vote); send({ vote }); logActivity("feature", page, "feedback:" + vote + ":" + id); };

  return (
    <div className="vf">
      <button className={`vf-b up ${quick === "up" ? "on" : ""}`} title="Helpful" onClick={() => thumb("up")}><ThumbsUp size={12} /></button>
      <button className={`vf-b down ${quick === "down" ? "on" : ""}`} title="Not helpful" onClick={() => thumb("down")}><ThumbsDown size={12} /></button>
      <button className="vf-b link" title="Give feedback" onClick={() => setOpen(true)}><MessageSquarePlus size={12} /> feedback</button>
      <span className="vf-id">{id}</span>
      <AnimatePresence>
        {open && <FeedbackModal scope="visual" visualId={id} name={name} description={description} page={page} sel={sel} onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}

// detailed feedback popup — used by visuals AND whole-page feedback
function FeedbackModal({ scope, visualId, name, description, page, sel, onClose }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [tags, setTags] = useState([]);
  const [sugKind, setSugKind] = useState("");       // "", add, remove, modify
  const [sugText, setSugText] = useState("");
  const [priority, setPriority] = useState("medium");
  const [done, setDone] = useState(false);
  const [exp, setExp] = useState(null);

  useEffect(() => {
    if (visualId) api(`/api/exports?visualId=${encodeURIComponent(visualId)}&latest=1`).then((j) => setExp(j.export)).catch(() => {});
  }, [visualId]);

  const TAGS = scope === "page"
    ? ["Easy to understand", "Fast loading", "Good layout", "Helpful insights", "Too much data", "Confusing layout", "Missing metrics", "Slow loading"]
    : ["Clear", "Useful", "Too much data", "Confusing", "Wrong numbers", "Love it"];
  const toggle = (t) => setTags((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]));

  async function submit() {
    await post("/api/feedback", { scope, visualId, visualName: name, page, rating: rating || undefined, comment, tags, dateRange: rangeText(sel), exportedRecently: !!exp }).catch(() => {});
    if (sugKind && (sugText || sugKind === "remove")) {
      await post("/api/suggestions", { kind: sugKind, visualId, visualName: name, page, title: (sugText || "").slice(0, 120) || `${sugKind} ${name || page}`, detail: sugText, priority }).catch(() => {});
    }
    logActivity("feature", page, "feedback_submit:" + (visualId || page));
    setDone(true);
    setTimeout(onClose, 1600);
  }

  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal fb-modal" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.16 }}>
        {done ? (
          <div className="fb-thanks"><Check size={30} /><b>Thank you for your feedback!</b></div>
        ) : (
          <>
            <div className="modal-head">
              <div><b>{scope === "page" ? "Rate this page" : name || "Feedback"}</b>{description && <div className="fb-desc">{description}</div>}</div>
              <button className="ic" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body fb-body">
              <div className="fb-row"><span className="fb-lbl">Rating</span>
                <Stars value={rating} onChange={setRating} />
              </div>
              <div className="fb-row col"><span className="fb-lbl">What do you think? What can we improve?</span>
                <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Your comment…" />
              </div>
              <div className="fb-row col"><span className="fb-lbl">Quick tags</span>
                <div className="fb-tags">{TAGS.map((t) => <button key={t} className={`fb-tag ${tags.includes(t) ? "on" : ""}`} onClick={() => toggle(t)}>{t}</button>)}</div>
              </div>
              <div className="fb-row col"><span className="fb-lbl">Suggest a change (optional)</span>
                <div className="fb-sug-kinds">
                  {[["add", "Add a visual"], ["remove", "Remove this"], ["modify", "Modify this"]].map(([k, l]) => (
                    <button key={k} className={`fb-tag ${sugKind === k ? "on" : ""}`} onClick={() => setSugKind(sugKind === k ? "" : k)}>{l}</button>
                  ))}
                </div>
                {sugKind && <textarea rows={2} value={sugText} onChange={(e) => setSugText(e.target.value)} placeholder={sugKind === "add" ? "What metric/visual do you want, and why?" : sugKind === "remove" ? "Why should this be removed?" : "What should change (data, layout, colors…)?"} />}
                {sugKind && <div className="fb-prio">Priority: {["high", "medium", "low"].map((p) => <button key={p} className={`fb-tag sm ${priority === p ? "on" : ""}`} onClick={() => setPriority(p)}>{p}</button>)}</div>}
              </div>
              {exp && <div className="fb-exp"><Download size={12} /> Last exported by {exp.userName} on {String(exp.ts).replace("T", " ").slice(0, 16)}</div>}
            </div>
            <div className="modal-foot">
              <span className="fb-brand">SWiSH ANALYTICS · Business Performance &amp; Analytics</span>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={submit}>Submit</button>
            </div>
          </>
        )}
      </motion.div>
    </>
  );
}

// ---------------------------------------------------------------------------
//  PERIODIC OVERALL FEEDBACK — every 7 days, ask once for an overall rating +
//  suggestion. Mounted once at the app root. Cadence is stored per browser; a
//  submit or a "Later" both reset the 7-day clock so we never nag.
// ---------------------------------------------------------------------------
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export function PeriodicFeedback() {
  const [nudge, setNudge] = useState(false);
  const [open, setOpen] = useState(false);
  const snooze = (days = 7) => { try { localStorage.setItem("overall-fb-next", String(Date.now() + days * 24 * 60 * 60 * 1000)); } catch {} };

  useEffect(() => {
    let next;
    try { next = Number(localStorage.getItem("overall-fb-next")); } catch { next = 0; }
    if (!next) { snooze(7); return; }        // first run: start the clock, don't prompt immediately
    if (Date.now() < next) return;           // not due yet
    const t = setTimeout(() => setNudge(true), 45000);   // wait until they've actually used it a while
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <AnimatePresence>
        {nudge && !open && (
          <motion.div className="pf-nudge overall" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}>
            <div className="pf-nudge-stars"><Star size={16} fill="#F5B301" color="#F5B301" /></div>
            <b>How are we doing?</b>
            <span className="pf-nudge-sub">It's been a week — a quick rating and any suggestions help us improve the dashboard.</span>
            <div className="pf-nudge-row">
              <button className="btn sm primary" onClick={() => { setOpen(true); setNudge(false); }}>Rate the dashboard</button>
              <button className="btn sm" onClick={() => { setNudge(false); snooze(7); }}>Later</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && <FeedbackModal scope="page" name="Overall dashboard" page="overall" onClose={() => { setOpen(false); snooze(7); }} />}
      </AnimatePresence>
    </>
  );
}

function Stars({ value, onChange, size = 22 }) {
  const [hov, setHov] = useState(0);
  return (
    <div className="stars" onMouseLeave={() => setHov(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className="star" onMouseEnter={() => setHov(n)} onClick={() => onChange(n)}>
          <Star size={size} fill={(hov || value) >= n ? "#F5B301" : "none"} color={(hov || value) >= n ? "#F5B301" : "#98A2B3"} />
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  SECTION 5: WHOLE-PAGE FEEDBACK PROMPT (auto after 30s) + manual button
// ---------------------------------------------------------------------------
export function PageFeedback({ page, pageLabel, sel, auto = true }) {
  const [open, setOpen] = useState(false);
  const [prompted, setPrompted] = useState(false);
  useEffect(() => {
    if (!auto) return;
    const key = "pf-" + page;
    if (sessionStorage.getItem(key)) return;
    const t = setTimeout(() => { setPrompted(true); sessionStorage.setItem(key, "1"); }, 30000);
    return () => clearTimeout(t);
  }, [page, auto]);
  return (
    <>
      <button className="pf-fab" title="Rate this page" onClick={() => setOpen(true)}><MessageSquarePlus size={15} /> Feedback</button>
      <AnimatePresence>
        {prompted && !open && (
          <motion.div className="pf-nudge" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}>
            <b>How helpful is this page?</b>
            <div className="pf-nudge-row"><button className="btn sm primary" onClick={() => { setOpen(true); setPrompted(false); }}>Tell us</button><button className="btn sm" onClick={() => setPrompted(false)}>Later</button></div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && <FeedbackModal scope="page" name={pageLabel} page={page} sel={sel} onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}

// ---------------------------------------------------------------------------
//  SECTION 6/12: NOTIFICATION BELL
// ---------------------------------------------------------------------------
const KIND_ICON = { info: Info, warning: AlertTriangle, announcement: Megaphone, urgent: AlertTriangle, message: Info, rating: Star, suggestion: Check, response: MessageSquarePlus };
const KIND_COLOR = { warning: "#F79009", urgent: "#F04438", announcement: "#7A5AF8", info: "#1570EF" };

export function NotificationBell({ onRate }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const reload = useCallback(() => fetch("/api/notifications", { credentials: "include", priority: "low" }).then((r) => r.json()).then((j) => setItems(j.notifications || [])).catch(() => {}), []);
  // delay the first poll so it doesn't compete with the initial page data load
  useEffect(() => { const first = setTimeout(reload, 3500); const t = setInterval(reload, 60000); return () => { clearTimeout(first); clearInterval(t); }; }, [reload]);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const markRead = (n) => { api(`/api/notifications/${encodeURIComponent(n.id)}/read`, { method: "POST" }).catch(() => {}); setItems((c) => c.filter((x) => x.id !== n.id)); };
  const clickItem = (n) => {
    if (n.type === "rating" && onRate) onRate(n.requestId, n.link);
    markRead(n);
  };
  const unread = items.length;
  return (
    <div className="nbell" ref={ref}>
      <button className="nbell-btn" onClick={() => setOpen((o) => !o)} title="Notifications">
        <Bell size={17} />{unread > 0 && <span className="nbell-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="nbell-pop" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <div className="nbell-head"><b>Notifications</b>{unread > 0 && <span>{unread} unread</span>}</div>
            <div className="nbell-list">
              {items.length === 0 && <div className="dt-empty">You're all caught up</div>}
              {items.map((n) => {
                const Icon = KIND_ICON[n.kind || n.type] || Info;
                return (
                  <div key={n.id} className="nbell-item" onClick={() => clickItem(n)}>
                    <span className="nbell-ic" style={{ color: KIND_COLOR[n.kind] || "#475467" }}><Icon size={15} /></span>
                    <div className="nbell-body"><b>{n.title}</b><span>{n.body}</span><span className="nbell-ts">{String(n.ts).replace("T", " ").slice(0, 16)}</span></div>
                    <button className="nbell-x" title="Dismiss" onClick={(e) => { e.stopPropagation(); markRead(n); }}><X size={12} /></button>
                  </div>
                );
              })}
            </div>
            <div className="nbell-foot">SWiSH ANALYTICS · Business Performance &amp; Analytics</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  SECTION 9: RATING PROMPT (admin-requested, user rates privately)
//  Host mounts once; polls active requests for the current page, or is opened
//  from a notification via `forceRequestId`.
// ---------------------------------------------------------------------------
export function RatingPromptHost({ page, sel, forcedId, onDone }) {
  const [req, setReq] = useState(null);
  useEffect(() => {
    if (forcedId) {
      api(`/api/rating-requests`).then((j) => { const r = (j.requests || []).find((x) => x.id === forcedId); if (r) setReq(r); }).catch(() => {});
      return;
    }
    if (!page) return;
    api(`/api/rating-requests?page=${encodeURIComponent(page)}`).then((j) => {
      const r = (j.requests || [])[0];
      if (r && !sessionStorage.getItem("rr-skip-" + r.id)) setReq(r);
    }).catch(() => {});
  }, [page, forcedId]);
  if (!req) return null;
  return <RatingPrompt req={req} page={page} sel={sel} onClose={(skip) => { if (skip) sessionStorage.setItem("rr-skip-" + req.id, "1"); setReq(null); onDone && onDone(); }} />;
}

function RatingPrompt({ req, page, sel, onClose }) {
  const t0 = useRef(Date.now());
  const [rating, setRating] = useState(0);
  const [thumb, setThumb] = useState(null);
  const [comment, setComment] = useState("");
  const [answers, setAnswers] = useState({});
  const [done, setDone] = useState(false);
  async function submit() {
    await post("/api/ratings", { requestId: req.id, page: req.page || page, rating: req.scale === "stars" ? rating : undefined, thumb: req.scale === "thumbs" ? thumb : undefined, comment, answers, completionTime: Math.round((Date.now() - t0.current) / 1000) }).catch(() => {});
    setDone(true); setTimeout(() => onClose(false), 1400);
  }
  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.div className="modal rp-modal" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16 }}>
        {done ? <div className="fb-thanks"><Check size={30} /><b>Thank you for your feedback!</b></div> : (
          <>
            <div className="modal-head"><div><b>We'd appreciate your feedback!</b><div className="fb-desc">{req.pageLabel}</div></div></div>
            <div className="modal-body fb-body">
              <p className="rp-msg">{req.message}</p>
              {req.scale === "thumbs" ? (
                <div className="rp-thumbs">
                  <button className={`rp-thumb ${thumb === "up" ? "on up" : ""}`} onClick={() => setThumb("up")}><ThumbsUp size={22} /> Helpful</button>
                  <button className={`rp-thumb ${thumb === "down" ? "on down" : ""}`} onClick={() => setThumb("down")}><ThumbsDown size={22} /> Not really</button>
                </div>
              ) : <Stars value={rating} onChange={setRating} size={30} />}
              {(req.questions || []).map((q, i) => (
                <div key={i} className="rp-q"><span>{q}</span>
                  <div className="rp-yn">
                    <button className={`fb-tag sm ${answers[i] === "yes" ? "on" : ""}`} onClick={() => setAnswers((a) => ({ ...a, [i]: "yes" }))}>Yes</button>
                    <button className={`fb-tag sm ${answers[i] === "no" ? "on" : ""}`} onClick={() => setAnswers((a) => ({ ...a, [i]: "no" }))}>No</button>
                  </div>
                </div>
              ))}
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What could we improve? (optional)" />
              <div className="rp-note">Your rating is private — only administrators see aggregated results.</div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => onClose(true)}>Skip for now</button>
              <div style={{ flex: 1 }} />
              <button className="btn primary" onClick={submit} disabled={req.scale === "stars" ? !rating : !thumb}>Submit</button>
            </div>
          </>
        )}
      </motion.div>
    </>
  );
}

// ---------------------------------------------------------------------------
//  BRAND FOOTER — required on every screen
// ---------------------------------------------------------------------------
export function BrandFooter() {
  return <div className="brand-foot">SWiSH ANALYTICS <span>|</span> Business Performance &amp; Analytics</div>;
}

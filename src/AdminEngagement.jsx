// ============================================================================
//  ADMIN — Engagement console
//  Feedback triage · Suggestions · Messaging · Rating requests + analytics ·
//  Activity & usage analytics. Admin-only (mounted from the Engagement tab).
// ============================================================================
import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageSquare, Lightbulb, Megaphone, Star, BarChart3, X, Send, Download,
  ThumbsUp, ThumbsDown,
} from "lucide-react";
import { api, BrandFooter } from "./engagement.jsx";

const post = (u, b) => api(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
const put = (u, b) => api(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
const ts = (t) => String(t).replace("T", " ").slice(0, 16);
const PAGES = [["landing", "CEO Landing"], ["operations", "Operations"], ["overview", "Sales Analysis"], ["runrate", "Live Runrate"], ["analysislab", "Analysis Lab"]];
const ROLES = [["all", "All users"], ["ops", "Operation Manager"], ["area", "Area Manager"], ["gm", "GM / Brand Manager"], ["marketing", "Marketing"], ["admin", "Admin"]];

const TABS = [
  { id: "feedback", label: "Feedback", icon: MessageSquare },
  { id: "suggestions", label: "Suggestions", icon: Lightbulb },
  { id: "messages", label: "Messages", icon: Megaphone },
  { id: "ratings", label: "Ratings", icon: Star },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
];

export default function AdminEngagement() {
  const [tab, setTab] = useState("feedback");
  return (
    <div className="page admin eng-admin">
      <div className="admin-head">
        <div><h1 className="admin-title"><MessageSquare size={19} /> Engagement</h1><p className="admin-sub">Feedback, suggestions, messaging, private ratings and usage analytics.</p></div>
      </div>
      <div className="eng-tabs">
        {TABS.map((t) => { const I = t.icon; return (
          <button key={t.id} className={`eng-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}><I size={15} /> {t.label}</button>
        ); })}
      </div>
      {tab === "feedback" && <FeedbackTab />}
      {tab === "suggestions" && <SuggestionsTab />}
      {tab === "messages" && <MessagesTab />}
      {tab === "ratings" && <RatingsTab />}
      {tab === "analytics" && <AnalyticsTab />}
      <BrandFooter />
    </div>
  );
}

// ---------------------------------- FEEDBACK -------------------------------
const STATUSES = ["new", "reviewing", "planned", "done", "rejected"];
function FeedbackTab() {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ scope: "", status: "" });
  const [sel, setSel] = useState(null);
  const reload = () => api(`/api/admin/feedback?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`).then((j) => setRows(j.feedback || [])).catch(() => {});
  useEffect(() => { reload(); }, [f.scope, f.status]);
  return (
    <div className="card admin-card">
      <div className="eng-filters">
        <select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="">All scopes</option><option value="visual">Visual</option><option value="page">Page</option></select>
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any status</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
        <span className="eng-count">{rows.length} items</span>
      </div>
      <table className="dt admin-table">
        <thead><tr><th className="dt-th l">When</th><th className="dt-th l">User</th><th className="dt-th l">Target</th><th className="dt-th l">Signal</th><th className="dt-th l">Comment</th><th className="dt-th l">Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => setSel(r)} className="clickable">
              <td className="l">{ts(r.ts)}</td>
              <td className="l"><b>{r.userName}</b><div className="eng-sub">{r.role}</div></td>
              <td className="l">{r.visualName || r.page}<div className="eng-sub">{r.scope}{r.visualId ? " · " + r.visualId : ""}</div></td>
              <td className="l">{r.vote === "up" && <span className="st-on">▲ up</span>}{r.vote === "down" && <span className="st-off">▼ down</span>}{r.rating ? <span> {r.rating}★</span> : null}</td>
              <td className="l eng-clip">{r.comment || (r.tags || []).join(", ")}</td>
              <td className="l"><span className={`eng-badge ${r.status}`}>{r.status}</span></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="dt-empty">No feedback yet</td></tr>}
        </tbody>
      </table>
      <AnimatePresence>{sel && <FeedbackDetail item={sel} onClose={() => setSel(null)} onSaved={() => { setSel(null); reload(); }} />}</AnimatePresence>
    </div>
  );
}

function FeedbackDetail({ item, onClose, onSaved }) {
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.adminNote || "");
  const [response, setResponse] = useState("");
  async function save() {
    await put(`/api/admin/feedback/${item.id}`, { status, adminNote: note, response: response || undefined });
    onSaved();
  }
  return (
    <Modal onClose={onClose} title={item.visualName || item.page || "Feedback"}>
      <div className="eng-detail">
        <Field k="User" v={`${item.userName} (${item.userEmail}) · ${item.role}`} />
        <Field k="Viewing" v={item.dateRange} />
        {item.rating ? <Field k="Rating" v={item.rating + "★"} /> : null}
        {item.vote && <Field k="Vote" v={item.vote} />}
        {!!(item.tags || []).length && <Field k="Tags" v={item.tags.join(", ")} />}
        {item.comment && <Field k="Comment" v={item.comment} />}
        {item.exportedRecently && <Field k="Note" v="Had exported this recently" />}
        <label className="mfield"><span>Status</span><select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label className="mfield"><span>Internal note (private)</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="mfield"><span>Reply to user (sends a notification)</span><textarea rows={2} value={response} onChange={(e) => setResponse(e.target.value)} placeholder="Thank you for your feedback…" /></label>
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
    </Modal>
  );
}

// -------------------------------- SUGGESTIONS ------------------------------
const SUG_STATUS = ["new", "inprogress", "done", "rejected"];
function SuggestionsTab() {
  const [rows, setRows] = useState([]);
  const [sort, setSort] = useState("score");
  const reload = () => api("/api/suggestions").then((j) => setRows(j.suggestions || [])).catch(() => {});
  useEffect(() => { reload(); }, []);
  const sorted = useMemo(() => [...rows].sort((a, b) => sort === "score" ? b.score - a.score : sort === "new" ? (a.ts < b.ts ? 1 : -1) : (a.priority > b.priority ? 1 : -1)), [rows, sort]);
  const vote = (s, dir) => post(`/api/suggestions/${s.id}/vote`, { dir: s.myVote === dir ? null : dir }).then(reload);
  const setStatus = (s, status) => put(`/api/admin/suggestions/${s.id}`, { status }).then(reload);
  return (
    <div className="card admin-card">
      <div className="eng-filters">
        <select value={sort} onChange={(e) => setSort(e.target.value)}><option value="score">Most voted</option><option value="new">Newest</option><option value="priority">Priority</option></select>
        <span className="eng-count">{rows.length} suggestions</span>
      </div>
      <div className="sug-list">
        {sorted.map((s) => (
          <div key={s.id} className="sug-card">
            <div className="sug-votes">
              <button className={`sug-vb ${s.myVote === "up" ? "on" : ""}`} onClick={() => vote(s, "up")}><ThumbsUp size={14} /></button>
              <b>{s.score}</b>
              <button className={`sug-vb ${s.myVote === "down" ? "on down" : ""}`} onClick={() => vote(s, "down")}><ThumbsDown size={14} /></button>
            </div>
            <div className="sug-main">
              <div className="sug-top"><span className={`eng-kind ${s.kind}`}>{s.kind}</span><b>{s.title || s.visualName || "(untitled)"}</b><span className={`eng-badge prio-${s.priority}`}>{s.priority}</span></div>
              {s.detail && <p className="sug-detail">{s.detail}</p>}
              <div className="sug-meta">{s.userName} · {s.role} · {s.page || "—"} · {ts(s.ts)}</div>
            </div>
            <div className="sug-status">
              <select value={s.status} onChange={(e) => setStatus(s, e.target.value)}>{SUG_STATUS.map((x) => <option key={x}>{x}</option>)}</select>
            </div>
          </div>
        ))}
        {!rows.length && <div className="dt-empty">No suggestions yet</div>}
      </div>
    </div>
  );
}

// --------------------------------- MESSAGES --------------------------------
function MessagesTab() {
  const [rows, setRows] = useState([]);
  const [m, setM] = useState({ title: "", body: "", kind: "info", targetType: "all", targetRole: "ops", link: "", ttlDays: 7 });
  const reload = () => api("/api/admin/messages").then((j) => setRows(j.messages || [])).catch(() => {});
  useEffect(() => { reload(); }, []);
  async function send() {
    if (!m.title || !m.body) return;
    const target = m.targetType === "role" ? { type: "role", role: m.targetRole } : { type: m.targetType };
    await post("/api/admin/messages", { ...m, target });
    setM({ ...m, title: "", body: "", link: "" });
    reload();
  }
  return (
    <div className="eng-two">
      <div className="card admin-card">
        <div className="card-head"><span className="card-title">Compose broadcast</span></div>
        <div className="mform">
          <label className="mfield"><span>Title</span><input value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} placeholder="New feature released" /></label>
          <label className="mfield"><span>Message</span><textarea rows={4} value={m.body} onChange={(e) => setM({ ...m, body: e.target.value })} placeholder="Check the Sales Analysis page…" /></label>
          <label className="mfield"><span>Type</span><select value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value })}><option value="info">Info</option><option value="announcement">Announcement</option><option value="warning">Warning</option><option value="urgent">Urgent</option></select></label>
          <label className="mfield"><span>Audience</span><select value={m.targetType} onChange={(e) => setM({ ...m, targetType: e.target.value })}><option value="all">All users</option><option value="role">Specific role</option></select></label>
          {m.targetType === "role" && <label className="mfield"><span>Role</span><select value={m.targetRole} onChange={(e) => setM({ ...m, targetRole: e.target.value })}>{ROLES.filter(([id]) => id !== "all").map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></label>}
          <label className="mfield"><span>Link (optional)</span><input value={m.link} onChange={(e) => setM({ ...m, link: e.target.value })} placeholder="overview" /></label>
          <label className="mfield"><span>Show for (days)</span><input type="number" value={m.ttlDays} onChange={(e) => setM({ ...m, ttlDays: e.target.value })} /></label>
          <button className="btn primary" onClick={send}><Send size={14} /> Send message</button>
        </div>
      </div>
      <div className="card admin-card">
        <div className="card-head"><span className="card-title">Sent messages</span></div>
        <div className="msg-list">
          {rows.map((r) => (
            <div key={r.id} className="msg-row">
              <span className={`eng-badge ${r.kind}`}>{r.kind}</span>
              <div className="msg-main"><b>{r.title}</b><span>{r.body}</span><span className="eng-sub">{ts(r.ts)} · {r.target?.type === "role" ? r.target.role : "all"} · read by {r.readCount}</span></div>
            </div>
          ))}
          {!rows.length && <div className="dt-empty">No messages sent</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------- RATINGS --------------------------------
function RatingsTab() {
  const [data, setData] = useState({ pages: [], requests: [], total: 0 });
  const [r, setR] = useState({ page: "landing", scale: "stars", message: "How helpful is this dashboard for your role?", targetType: "all", targetRole: "ops", questions: "" });
  const reload = () => api("/api/admin/ratings").then(setData).catch(() => {});
  useEffect(() => { reload(); }, []);
  async function request() {
    const target = r.targetType === "role" ? { type: "role", role: r.targetRole } : { type: r.targetType };
    const questions = r.questions.split("\n").map((q) => q.trim()).filter(Boolean);
    await post("/api/admin/rating-requests", { page: r.page, pageLabel: (PAGES.find(([p]) => p === r.page) || [])[1] || r.page, scale: r.scale, message: r.message, target, questions });
    reload();
  }
  const closeReq = (id) => put(`/api/admin/rating-requests/${id}`, { open: false }).then(reload);
  const label = (p) => (PAGES.find(([x]) => x === p) || [null, p])[1];
  return (
    <div className="eng-two">
      <div className="card admin-card">
        <div className="card-head"><span className="card-title">Request ratings</span></div>
        <div className="mform">
          <label className="mfield"><span>Page</span><select value={r.page} onChange={(e) => setR({ ...r, page: e.target.value })}>{PAGES.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></label>
          <label className="mfield"><span>Scale</span><select value={r.scale} onChange={(e) => setR({ ...r, scale: e.target.value })}><option value="stars">1–5 stars</option><option value="thumbs">Thumbs up/down</option></select></label>
          <label className="mfield"><span>Message</span><input value={r.message} onChange={(e) => setR({ ...r, message: e.target.value })} /></label>
          <label className="mfield"><span>Audience</span><select value={r.targetType} onChange={(e) => setR({ ...r, targetType: e.target.value })}><option value="all">All users</option><option value="role">Specific role</option></select></label>
          {r.targetType === "role" && <label className="mfield"><span>Role</span><select value={r.targetRole} onChange={(e) => setR({ ...r, targetRole: e.target.value })}>{ROLES.filter(([id]) => id !== "all").map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></label>}
          <label className="mfield"><span>Extra questions (one per line, optional)</span><textarea rows={3} value={r.questions} onChange={(e) => setR({ ...r, questions: e.target.value })} placeholder={"Is this dashboard easy to use?\nDoes it provide the insights you need?"} /></label>
          <button className="btn primary" onClick={request}><Send size={14} /> Send rating request</button>
        </div>
        <div className="card-head" style={{ marginTop: 16 }}><span className="card-title">Open requests</span></div>
        <div className="msg-list">
          {(data.requests || []).filter((x) => x.open).map((x) => (
            <div key={x.id} className="msg-row"><Star size={14} /><div className="msg-main"><b>{x.pageLabel}</b><span className="eng-sub">{x.scale} · {x.target?.type === "role" ? x.target.role : "all"} · {ts(x.ts)}</span></div><button className="btn sm" onClick={() => closeReq(x.id)}>Close</button></div>
          ))}
          {!(data.requests || []).some((x) => x.open) && <div className="dt-empty">No open requests</div>}
        </div>
      </div>
      <div className="card admin-card">
        <div className="card-head"><span className="card-title">Aggregated ratings <span className="eng-sub">(private — {data.total} responses)</span></span></div>
        {(data.pages || []).map((p) => (
          <div key={p.page} className="rate-agg">
            <div className="rate-agg-top"><b>{label(p.page)}</b>{p.avg != null ? <span className="rate-avg">{p.avg}<small>/5</small></span> : <span className="rate-avg">{p.up}▲ {p.down}▼</span>}<span className="eng-sub">{p.count} responses</span></div>
            {p.avg != null && <div className="rate-dist">{[5, 4, 3, 2, 1].map((n) => { const c = p.dist[n - 1]; const pct = p.count ? (c / p.count) * 100 : 0; return <div key={n} className="rate-bar"><span>{n}★</span><div className="rate-track"><div style={{ width: pct + "%" }} /></div><span>{c}</span></div>; })}</div>}
            {!!(p.comments || []).length && <div className="rate-comments">{p.comments.slice(0, 5).map((c, i) => <div key={i} className="rate-cmt">“{c.comment}” <span className="eng-sub">— {c.by}, {c.role}</span></div>)}</div>}
          </div>
        ))}
        {!(data.pages || []).length && <div className="dt-empty">No ratings yet</div>}
      </div>
    </div>
  );
}

// --------------------------------- ANALYTICS -------------------------------
function AnalyticsTab() {
  const [a, setA] = useState(null);
  useEffect(() => { api("/api/admin/analytics").then(setA).catch(() => {}); }, []);
  if (!a) return <div className="card admin-card"><div className="dt-empty">Loading…</div></div>;
  const t = a.totals;
  const maxDau = Math.max(1, ...a.dauSeries.map((d) => d.users));
  return (
    <div className="eng-analytics">
      <div className="kpi-strip">
        <Kpi v={t.activeUsers} l="Active users" />
        <Kpi v={t.events} l="Events logged" />
        <Kpi v={t.exports} l="Exports" />
        <Kpi v={t.feedback} l="Feedback" />
        <Kpi v={t.ratings} l="Ratings" />
        <Kpi v={`${t.up}▲ / ${t.down}▼`} l="Sentiment" />
        <Kpi v={a.avgPerfMs != null ? a.avgPerfMs + "ms" : "—"} l="Avg render" />
        <Kpi v={t.errors} l="Errors" />
      </div>
      <div className="eng-two">
        <div className="card admin-card">
          <div className="card-head"><span className="card-title">Daily active users (14d)</span></div>
          <div className="dau-chart">{a.dauSeries.map((d) => <div key={d.day} className="dau-bar" title={`${d.day}: ${d.users}`}><div style={{ height: (d.users / maxDau) * 100 + "%" }} /><span>{d.day.slice(5)}</span></div>)}{!a.dauSeries.length && <div className="dt-empty">No activity</div>}</div>
        </div>
        <div className="card admin-card">
          <div className="card-head"><span className="card-title">Page engagement</span></div>
          <table className="dt"><thead><tr><th className="dt-th l">Page</th><th className="dt-th r">Visits</th><th className="dt-th r">Avg dwell</th></tr></thead>
            <tbody>{a.pages.map((p) => <tr key={p.page}><td className="l">{p.page}</td><td className="r">{p.visits}</td><td className="r">{p.avgMs ? Math.round(p.avgMs / 1000) + "s" : "—"}</td></tr>)}{!a.pages.length && <tr><td colSpan={3} className="dt-empty">No visits</td></tr>}</tbody></table>
        </div>
      </div>
      <div className="eng-two">
        <div className="card admin-card">
          <div className="card-head"><span className="card-title"><Download size={14} /> Most exported</span></div>
          <table className="dt"><tbody>{a.exportByVisual.slice(0, 10).map((e) => <tr key={e.name}><td className="l">{e.name}</td><td className="r">{e.count}</td></tr>)}{!a.exportByVisual.length && <tr><td colSpan={2} className="dt-empty">No exports</td></tr>}</tbody></table>
        </div>
        <div className="card admin-card">
          <div className="card-head"><span className="card-title">Most used features</span></div>
          <table className="dt"><tbody>{a.features.slice(0, 10).map((e) => <tr key={e.name}><td className="l">{e.name}</td><td className="r">{e.count}</td></tr>)}{!a.features.length && <tr><td colSpan={2} className="dt-empty">No feature events</td></tr>}</tbody></table>
        </div>
      </div>
      {!!a.recentErrors.length && (
        <div className="card admin-card"><div className="card-head"><span className="card-title">Recent errors</span></div>
          <div className="msg-list">{a.recentErrors.map((e) => <div key={e.id} className="msg-row"><span className="eng-badge rejected">error</span><div className="msg-main"><b>{e.details}</b><span className="eng-sub">{e.page} · {e.userName} · {ts(e.ts)}</span></div></div>)}</div>
        </div>
      )}
    </div>
  );
}

// -------------------------------- primitives -------------------------------
const Kpi = ({ v, l }) => <div className="eng-kpi"><b>{v}</b><span>{l}</span></div>;
const Field = ({ k, v }) => v ? <div className="eng-field"><span>{k}</span><b>{v}</b></div> : null;
function Modal({ title, children, onClose }) {
  return (
    <>
      <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.16 }}>
        <div className="modal-head"><b>{title}</b><button className="ic" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">{children}</div>
      </motion.div>
    </>
  );
}

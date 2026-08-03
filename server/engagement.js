// ============================================================================
//  ENGAGEMENT — feedback, exports, suggestions, messages, ratings, activity
//  A single module that adds the whole feedback/engagement/management layer.
//  Storage: flat JSON collections under server/data/engagement/ (same style as
//  users.json / audit.json). Every write is stamped with the signed-in user.
//  Nothing here can be spoofed from the browser: identity comes from req.user.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireAuth, requireAdmin, logAudit } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "data", "engagement");

// ---- tiny JSON-collection store -------------------------------------------
function ensure() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function load(name) { ensure(); try { return JSON.parse(fs.readFileSync(path.join(DIR, name + ".json"), "utf8")); } catch { return []; } }
function save(name, rows) { ensure(); fs.writeFileSync(path.join(DIR, name + ".json"), JSON.stringify(rows, null, 2)); }
// prepend + cap so files never grow unbounded
function push(name, rec, cap = 5000) { const rows = load(name); rows.unshift(rec); save(name, rows.slice(0, cap)); return rec; }
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
// who did it — trusted, from the JWT, never from the request body
const who = (u) => ({ userId: u.id, userName: u.name, userEmail: u.email, role: u.role });

// message/rating targeting: does this request apply to this user?
function targeted(user, t = {}) {
  if (!t || t.type === "all" || !t.type) return true;
  if (t.type === "role") return t.role === user.role;
  if (t.type === "user") return t.userId === user.id || t.email === user.email;
  return false;
}

export function registerEngagement(app) {
  ensure();

  // ======================= SECTION 2/5: FEEDBACK ==========================
  // Per-visual feedback AND whole-page feedback share one collection,
  // distinguished by `scope` ("visual" | "page").
  app.post("/api/feedback", requireAuth, (req, res) => {
    const b = req.body || {};
    const rec = {
      id: id(), ts: now(), ...who(req.user),
      scope: b.scope === "page" ? "page" : "visual",
      visualId: b.visualId || null, visualName: b.visualName || null,
      page: b.page || null,
      vote: b.vote === "up" || b.vote === "down" ? b.vote : null,   // thumbs
      rating: Number(b.rating) > 0 ? Number(b.rating) : null,        // 1-5 stars
      comment: (b.comment || "").slice(0, 2000),
      tags: Array.isArray(b.tags) ? b.tags.slice(0, 20) : [],        // "easy", "confusing"…
      dateRange: b.dateRange || null,                                // what they were viewing
      exportedRecently: !!b.exportedRecently,
      status: "new",                                                 // new|reviewing|planned|done|rejected
      adminNote: "", response: null,
    };
    push("feedback", rec);
    logAudit(req.user.email, "feedback", rec.visualName || rec.page || "dashboard", rec.vote || (rec.rating ? rec.rating + "★" : "comment"));
    res.json({ ok: true, id: rec.id });
  });

  app.get("/api/admin/feedback", requireAdmin, (req, res) => {
    let rows = load("feedback");
    const { scope, status, visualId, page } = req.query;
    if (scope) rows = rows.filter((r) => r.scope === scope);
    if (status) rows = rows.filter((r) => r.status === status);
    if (visualId) rows = rows.filter((r) => r.visualId === visualId);
    if (page) rows = rows.filter((r) => r.page === page);
    res.json({ feedback: rows.slice(0, 500) });
  });

  // admin triages / responds to a feedback item (response becomes a notification)
  app.put("/api/admin/feedback/:id", requireAdmin, (req, res) => {
    const rows = load("feedback");
    const r = rows.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: "not found" });
    const { status, adminNote, response } = req.body || {};
    if (status) r.status = status;
    if (adminNote !== undefined) r.adminNote = adminNote;
    if (response) {
      r.response = { text: response, ts: now(), by: req.user.name };
      notify(r.userId, { type: "response", title: "Reply to your feedback", body: response, link: null });
    }
    save("feedback", rows);
    res.json({ ok: true });
  });

  // ======================= SECTION 3: EXPORT TRACKING =====================
  app.post("/api/exports", requireAuth, (req, res) => {
    const b = req.body || {};
    const rec = {
      id: id(), ts: now(), ...who(req.user),
      visualId: b.visualId || null, visualName: b.visualName || b.table || "export",
      page: b.page || null, format: (b.format || "csv").toLowerCase(),
      dateRange: b.dateRange || null, filters: b.filters || null, rows: Number(b.rows) || null,
    };
    push("exports", rec);
    logAudit(req.user.email, "export", rec.visualName, `${rec.format.toUpperCase()}${rec.rows ? " · " + rec.rows + " rows" : ""}`);
    res.json({ ok: true });
  });

  // ?visualId= → latest export of that visual (for the "Last exported by…" tag).
  // Admins see everything; a normal user sees only their own exports.
  app.get("/api/exports", requireAuth, (req, res) => {
    let rows = load("exports");
    if (req.user.role !== "admin") rows = rows.filter((r) => r.userId === req.user.id);
    if (req.query.visualId) rows = rows.filter((r) => r.visualId === req.query.visualId);
    if (req.query.latest) return res.json({ export: rows[0] || null });
    res.json({ exports: rows.slice(0, 1000) });
  });

  // ======================= SECTION 4: SUGGESTIONS =========================
  app.post("/api/suggestions", requireAuth, (req, res) => {
    const b = req.body || {};
    const rec = {
      id: id(), ts: now(), ...who(req.user),
      kind: ["add", "remove", "modify"].includes(b.kind) ? b.kind : "add",
      visualId: b.visualId || null, visualName: b.visualName || null, page: b.page || null,
      title: (b.title || "").slice(0, 200), detail: (b.detail || "").slice(0, 2000),
      reason: b.reason || null, priority: ["high", "medium", "low"].includes(b.priority) ? b.priority : "medium",
      votes: { up: [], down: [] }, status: "new",  // new|inprogress|done|rejected
      adminNote: "",
    };
    push("suggestions", rec);
    logAudit(req.user.email, "suggestion", rec.title || rec.visualName || rec.kind, rec.kind);
    res.json({ ok: true, id: rec.id });
  });

  app.get("/api/suggestions", requireAuth, (req, res) => {
    const rows = load("suggestions").map((s) => ({
      ...s,
      score: (s.votes?.up?.length || 0) - (s.votes?.down?.length || 0),
      myVote: s.votes?.up?.includes(req.user.id) ? "up" : s.votes?.down?.includes(req.user.id) ? "down" : null,
    }));
    res.json({ suggestions: rows.slice(0, 500) });
  });

  app.post("/api/suggestions/:id/vote", requireAuth, (req, res) => {
    const rows = load("suggestions");
    const s = rows.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    s.votes = s.votes || { up: [], down: [] };
    const dir = req.body?.dir;
    s.votes.up = s.votes.up.filter((u) => u !== req.user.id);
    s.votes.down = s.votes.down.filter((u) => u !== req.user.id);
    if (dir === "up") s.votes.up.push(req.user.id);
    else if (dir === "down") s.votes.down.push(req.user.id);
    save("suggestions", rows);
    res.json({ ok: true, score: s.votes.up.length - s.votes.down.length });
  });

  app.put("/api/admin/suggestions/:id", requireAdmin, (req, res) => {
    const rows = load("suggestions");
    const s = rows.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    const { status, adminNote, priority } = req.body || {};
    if (status) s.status = status;
    if (priority) s.priority = priority;
    if (adminNote !== undefined) s.adminNote = adminNote;
    save("suggestions", rows);
    if (status === "done") notify(s.userId, { type: "suggestion", title: "Your suggestion was implemented ✓", body: s.title || s.visualName || "See the update", link: s.page });
    else if (status === "inprogress") notify(s.userId, { type: "suggestion", title: "Your suggestion is in progress", body: s.title || s.visualName || "", link: null });
    res.json({ ok: true });
  });

  // ======================= SECTION 6: ADMIN MESSAGES ======================
  app.post("/api/admin/messages", requireAdmin, (req, res) => {
    const b = req.body || {};
    const rec = {
      id: id(), ts: now(), by: req.user.name,
      title: (b.title || "").slice(0, 200), body: (b.body || "").slice(0, 4000),
      kind: ["info", "warning", "announcement", "urgent"].includes(b.kind) ? b.kind : "info",
      target: b.target && b.target.type ? b.target : { type: "all" },
      link: b.link || null,
      ttlDays: Number(b.ttlDays) > 0 ? Number(b.ttlDays) : 7,
      reads: {},  // userId -> ts
    };
    push("messages", rec);
    logAudit(req.user.email, "message", rec.title, rec.kind + " → " + rec.target.type);
    res.json({ ok: true, id: rec.id });
  });

  const alive = (m) => (Date.now() - new Date(m.ts).getTime()) / 86400000 < (m.ttlDays || 7);

  // messages visible to the signed-in user (targeted + not expired)
  app.get("/api/messages", requireAuth, (req, res) => {
    const rows = load("messages").filter((m) => alive(m) && targeted(req.user, m.target));
    res.json({ messages: rows.map((m) => ({
      id: m.id, ts: m.ts, by: m.by, title: m.title, body: m.body, kind: m.kind, link: m.link,
      read: !!m.reads?.[req.user.id],
    })) });
  });

  app.post("/api/messages/:id/read", requireAuth, (req, res) => {
    const rows = load("messages");
    const m = rows.find((x) => x.id === req.params.id);
    if (m) { m.reads = m.reads || {}; if (req.body?.unread) delete m.reads[req.user.id]; else m.reads[req.user.id] = now(); save("messages", rows); }
    res.json({ ok: true });
  });

  // admin view with read receipts
  app.get("/api/admin/messages", requireAdmin, (_req, res) => {
    res.json({ messages: load("messages").map((m) => ({ ...m, readCount: Object.keys(m.reads || {}).length })) });
  });

  // ======================= SECTION 9: RATING REQUESTS =====================
  app.post("/api/admin/rating-requests", requireAdmin, (req, res) => {
    const b = req.body || {};
    const rec = {
      id: id(), ts: now(), by: req.user.name,
      page: b.page || "landing", pageLabel: b.pageLabel || b.page || "Dashboard",
      message: (b.message || "How helpful is this dashboard for your role?").slice(0, 400),
      scale: b.scale === "thumbs" ? "thumbs" : "stars",
      questions: Array.isArray(b.questions) ? b.questions.slice(0, 6) : [],
      target: b.target && b.target.type ? b.target : { type: "all" },
      deadline: b.deadline || null, open: true,
    };
    push("ratingRequests", rec);
    logAudit(req.user.email, "rating-request", rec.pageLabel, rec.target.type);
    res.json({ ok: true, id: rec.id });
  });

  app.put("/api/admin/rating-requests/:id", requireAdmin, (req, res) => {
    const rows = load("ratingRequests");
    const r = rows.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: "not found" });
    if (req.body?.open !== undefined) r.open = !!req.body.open;
    save("ratingRequests", rows);
    res.json({ ok: true });
  });

  // active rating request for a given page that THIS user hasn't answered yet
  app.get("/api/rating-requests", requireAuth, (req, res) => {
    const answered = new Set(load("ratings").filter((r) => r.userId === req.user.id).map((r) => r.requestId));
    let rows = load("ratingRequests").filter((r) => r.open && targeted(req.user, r.target) && !answered.has(r.id));
    if (req.query.page) rows = rows.filter((r) => r.page === req.query.page);
    res.json({ requests: rows });
  });

  app.post("/api/ratings", requireAuth, (req, res) => {
    const b = req.body || {};
    const rec = {
      id: id(), ts: now(), ...who(req.user),
      requestId: b.requestId || null, page: b.page || null,
      rating: Number(b.rating) || null, thumb: b.thumb || null,
      comment: (b.comment || "").slice(0, 2000),
      answers: b.answers || {}, completionTime: Number(b.completionTime) || null,
    };
    push("ratings", rec);
    logAudit(req.user.email, "rating", rec.page, (rec.rating ? rec.rating + "★" : rec.thumb) || "");
    res.json({ ok: true });
  });

  // aggregated ratings (admin only — users never see other users' ratings)
  app.get("/api/admin/ratings", requireAdmin, (_req, res) => {
    const ratings = load("ratings");
    const byPage = {};
    for (const r of ratings) {
      const p = r.page || "unknown";
      const g = (byPage[p] = byPage[p] || { page: p, count: 0, sum: 0, dist: [0, 0, 0, 0, 0], up: 0, down: 0, comments: [] });
      g.count++;
      if (r.rating) { g.sum += r.rating; g.dist[Math.min(4, Math.max(0, Math.round(r.rating) - 1))]++; }
      if (r.thumb === "up") g.up++; if (r.thumb === "down") g.down++;
      if (r.comment) g.comments.push({ comment: r.comment, by: r.userName, role: r.role, ts: r.ts });
    }
    const pages = Object.values(byPage).map((g) => ({ ...g, avg: g.sum && g.count ? +(g.sum / g.dist.reduce((a, b) => a + b, 0) || 0).toFixed(2) : null }));
    res.json({ pages, requests: load("ratingRequests"), total: ratings.length });
  });

  // ======================= SECTION 7: ACTIVITY LOG ========================
  // Batched from the client (page visits, feature use, timings, errors).
  app.post("/api/activity", requireAuth, (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    const rows = load("activity");
    for (const e of events.slice(0, 50)) {
      rows.unshift({ id: id(), ts: now(), ...who(req.user), action: (e.action || "event").slice(0, 60), page: e.page || null, details: e.details || null, ms: Number(e.ms) || null });
    }
    save("activity", rows.slice(0, 20000));
    res.json({ ok: true });
  });

  app.get("/api/admin/activity", requireAdmin, (req, res) => {
    let rows = load("activity");
    if (req.query.action) rows = rows.filter((r) => r.action === req.query.action);
    res.json({ activity: rows.slice(0, 1000) });
  });

  // rolled-up analytics for the admin dashboard
  app.get("/api/admin/analytics", requireAdmin, (_req, res) => {
    const activity = load("activity"), exports = load("exports"), feedback = load("feedback"), ratings = load("ratings");
    const dayKey = (ts) => String(ts).slice(0, 10);
    const uniq = (arr, k) => new Set(arr.map(k)).size;
    // engagement
    const visits = activity.filter((a) => a.action === "page_visit");
    const pageTime = {}, pageVisits = {};
    for (const v of visits) { pageVisits[v.page] = (pageVisits[v.page] || 0) + 1; if (v.ms) pageTime[v.page] = (pageTime[v.page] || 0) + v.ms; }
    const feature = {};
    for (const a of activity.filter((a) => a.action === "feature")) feature[a.details] = (feature[a.details] || 0) + 1;
    // per-day active users (last 14 days)
    const dau = {};
    for (const a of activity) { const d = dayKey(a.ts); (dau[d] = dau[d] || new Set()).add(a.userId); }
    const dauSeries = Object.entries(dau).sort().slice(-14).map(([d, s]) => ({ day: d, users: s.size }));
    // exports
    const exportByVisual = {}, exportByFormat = {};
    for (const e of exports) { exportByVisual[e.visualName] = (exportByVisual[e.visualName] || 0) + 1; exportByFormat[e.format] = (exportByFormat[e.format] || 0) + 1; }
    // feedback sentiment
    const up = feedback.filter((f) => f.vote === "up").length, down = feedback.filter((f) => f.vote === "down").length;
    const perf = activity.filter((a) => a.action === "perf" && a.ms);
    const errors = activity.filter((a) => a.action === "error");
    res.json({
      totals: {
        activeUsers: uniq(activity, (a) => a.userId), events: activity.length, exports: exports.length,
        feedback: feedback.length, ratings: ratings.length, up, down, errors: errors.length,
      },
      dauSeries,
      pages: Object.keys(pageVisits).map((p) => ({ page: p, visits: pageVisits[p], avgMs: pageVisits[p] ? Math.round((pageTime[p] || 0) / pageVisits[p]) : 0 })).sort((a, b) => b.visits - a.visits),
      features: Object.entries(feature).map(([k, v]) => ({ name: k, count: v })).sort((a, b) => b.count - a.count),
      exportByVisual: Object.entries(exportByVisual).map(([k, v]) => ({ name: k, count: v })).sort((a, b) => b.count - a.count),
      exportByFormat: Object.entries(exportByFormat).map(([k, v]) => ({ name: k, count: v })),
      avgPerfMs: perf.length ? Math.round(perf.reduce((s, a) => s + a.ms, 0) / perf.length) : null,
      recentErrors: errors.slice(0, 20),
    });
  });

  // ======================= SECTION 12: NOTIFICATIONS ======================
  // A unified feed = unread admin messages + direct notifications (responses,
  // suggestion updates) + open rating requests targeted at this user.
  function notify(userId, n) { if (!userId) return; push("notifications", { id: id(), ts: now(), userId, read: false, ...n }); }

  app.get("/api/notifications", requireAuth, (req, res) => {
    const u = req.user;
    const direct = load("notifications").filter((n) => n.userId === u.id);
    const msgs = load("messages").filter((m) => alive(m) && targeted(u, m.target) && !m.reads?.[u.id])
      .map((m) => ({ id: "msg:" + m.id, ts: m.ts, type: "message", title: m.title, body: m.body, kind: m.kind, link: m.link, read: false }));
    const answered = new Set(load("ratings").filter((r) => r.userId === u.id).map((r) => r.requestId));
    const reqs = load("ratingRequests").filter((r) => r.open && targeted(u, r.target) && !answered.has(r.id))
      .map((r) => ({ id: "rate:" + r.id, ts: r.ts, type: "rating", title: "Rating requested: " + r.pageLabel, body: r.message, link: r.page, read: false, requestId: r.id }));
    const items = [...direct.filter((n) => !n.read), ...msgs, ...reqs].sort((a, b) => (a.ts < b.ts ? 1 : -1));
    res.json({ notifications: items, unread: items.length });
  });

  app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
    const raw = req.params.id;
    if (raw.startsWith("msg:")) {
      const rows = load("messages"); const m = rows.find((x) => x.id === raw.slice(4));
      if (m) { m.reads = m.reads || {}; m.reads[req.user.id] = now(); save("messages", rows); }
    } else {
      const rows = load("notifications"); const n = rows.find((x) => x.id === raw && x.userId === req.user.id);
      if (n) { n.read = true; save("notifications", rows); }
    }
    res.json({ ok: true });
  });

  // expose notify() for other modules if ever needed
  registerEngagement._notify = notify;
}

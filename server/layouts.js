// ============================================================================
//  DASHBOARD LAYOUT STORE — the persistence layer for the widget framework.
//  Governance model:
//    • global.<dash>.default / global.<dash>.roles.<role>  → admin-published
//      default layouts (Phase 3). Every user falls back to these.
//    • users.<userId>.<dash> = { active, layouts:{name:layout} }             → each
//      user's personal named layouts (Phase 2).
//  A "layout" is an ordered array of { id, w, hidden, collapsed } — order is the
//  array order, w is the column span (of 12). Widgets not present are appended
//  with their defaults on the client (future-proofing), so the store never has
//  to know the widget catalogue.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, requireAdmin, logAudit } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "data", "layouts.json");
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { global: {}, users: {} }; } };
const save = (x) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(x, null, 2)); } catch {} };
const cleanLayout = (l) => (Array.isArray(l) ? l.filter((it) => it && it.id).map((it) => ({ id: String(it.id), w: Number(it.w) || 12, hidden: !!it.hidden, collapsed: !!it.collapsed })).slice(0, 100) : []);

export function registerLayouts(app) {
  // what a user sees for a dashboard: their personal layouts + the applicable
  // default + the admin's per-widget governance config (enforced client-side).
  app.get("/api/layouts/:dash", requireAuth, (req, res) => {
    const db = load(), dash = req.params.dash, g = db.global[dash] || {};
    const roleDefault = (g.roles && g.roles[req.user.role]) || null;
    res.json({ user: (db.users[req.user.id] && db.users[req.user.id][dash]) || null, globalDefault: roleDefault || g.default || null, config: g.config || {}, visuals: g.visuals || {} });
  });
  // save a user's personal layouts (their private workspace — never touches governance)
  app.post("/api/layouts/:dash", requireAuth, (req, res) => {
    const db = load(), dash = req.params.dash, b = req.body || {};
    const layouts = {};
    for (const [name, l] of Object.entries(b.layouts || {})) layouts[String(name).slice(0, 60)] = cleanLayout(l);
    db.users[req.user.id] = db.users[req.user.id] || {};
    db.users[req.user.id][dash] = { active: b.active || Object.keys(layouts)[0] || "Default", layouts };
    save(db); res.json({ ok: true });
  });
  // ---- admin: global / per-role default (Phase 3) ----
  app.get("/api/admin/layouts/:dash", requireAdmin, (req, res) => res.json((load().global[req.params.dash]) || {}));
  app.post("/api/admin/layouts/:dash/publish", requireAdmin, (req, res) => {
    const db = load(), dash = req.params.dash, b = req.body || {};
    db.global[dash] = db.global[dash] || {};
    if (b.role) { db.global[dash].roles = db.global[dash].roles || {}; db.global[dash].roles[b.role] = cleanLayout(b.layout); }
    else db.global[dash].default = cleanLayout(b.layout);
    save(db);
    logAudit(req.user.email, "published-layout", dash, b.role ? "role: " + b.role : "global default");
    res.json({ ok: true });
  });
  // per-widget governance config: { widgetId: { enabled, defaultVisible, movable, hideable, roles:[] } }
  app.post("/api/admin/layouts/:dash/config", requireAdmin, (req, res) => {
    const db = load(), dash = req.params.dash, cfg = (req.body && req.body.config) || {};
    const clean = {};
    for (const [id, c] of Object.entries(cfg)) clean[String(id)] = {
      enabled: c.enabled !== false, defaultVisible: c.defaultVisible !== false,
      movable: c.movable !== false, hideable: c.hideable !== false,
      roles: Array.isArray(c.roles) ? c.roles.slice(0, 10) : [],
    };
    db.global[dash] = db.global[dash] || {}; db.global[dash].config = clean;
    save(db);
    logAudit(req.user.email, "widget-config", dash, `${Object.keys(clean).length} widgets`);
    res.json({ ok: true });
  });
  // Phase 4 — Visual Config: page-defined visual defaults (filters, locks, default
  // selections, Top-N, sort). Opaque to the store — the page defines the shape;
  // it's just persisted globally and applied for every user.
  app.post("/api/admin/layouts/:dash/visuals", requireAdmin, (req, res) => {
    const db = load(), dash = req.params.dash;
    db.global[dash] = db.global[dash] || {};
    db.global[dash].visuals = (req.body && req.body.visuals) || {};
    save(db);
    logAudit(req.user.email, "visual-config", dash, "");
    res.json({ ok: true });
  });
}

// ============================================================================
//  AUTH + USER MANAGEMENT + SCOPE MODEL
//  - Users persisted to server/data/users.json (bcrypt-hashed passwords).
//  - Session via JWT in an httpOnly cookie (8h).
//  - Every user carries a data scope; server.js enforces it on every DAX query.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.json");
const SECRET_FILE = path.join(DATA_DIR, ".jwtsecret");
const COOKIE = "sid";
const MSFLOW = "msflow";           // short-lived cookie holding OAuth state/nonce/PKCE
const SESSION_HOURS = 8;

// ---- Microsoft Entra ID (Azure AD) OpenID Connect config (from server/.env) ----
// User sign-in reuses the same Azure app as Power BI (TENANT_ID/CLIENT_ID/CLIENT_SECRET)
// unless a dedicated login app is provided via the MS_* vars.
const MS = {
  get tenant() { return process.env.MS_TENANT_ID || process.env.TENANT_ID || ""; },
  get clientId() { return process.env.MS_CLIENT_ID || process.env.CLIENT_ID || ""; },
  get clientSecret() { return process.env.MS_CLIENT_SECRET || process.env.CLIENT_SECRET || ""; },
  get redirectUri() { return process.env.MS_REDIRECT_URI || `http://localhost:${process.env.PORT || 7001}/api/auth/microsoft/callback`; },
  get postLoginUrl() { return process.env.APP_URL || "/"; },
  get authority() { return `https://login.microsoftonline.com/${this.tenant}`; },
  get issuer() { return `https://login.microsoftonline.com/${this.tenant}/v2.0`; },
};
export const msEnabled = () => !!(MS.tenant && MS.clientId && MS.clientSecret);
// Secure cookies in production (behind HTTPS): auto-on when COOKIE_SECURE=1 or the
// public APP_URL / MS_REDIRECT_URI is https. Stays off for http://localhost dev.
const secureCookies = () => process.env.COOKIE_SECURE === "1"
  || /^https:/i.test(process.env.APP_URL || "")
  || /^https:/i.test(process.env.MS_REDIRECT_URI || "");
const sessionCookie = () => ({ httpOnly: true, sameSite: "lax", secure: secureCookies(), maxAge: SESSION_HOURS * 3600 * 1000 });
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// JWKS cache for verifying Microsoft's id_token signatures (RS256)
let _jwks = { keys: [], at: 0 };
async function jwksKey(kid) {
  if (Date.now() - _jwks.at > 3600_000 || !_jwks.keys.length) {
    const r = await fetch(`${MS.authority}/discovery/v2.0/keys`);
    const j = await r.json();
    _jwks = { keys: j.keys || [], at: Date.now() };
  }
  const jwk = _jwks.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error("signing key not found");
  return crypto.createPublicKey({ key: jwk, format: "jwk" }).export({ format: "pem", type: "spki" });
}
// verify an Entra id_token: signature (RS256/JWKS) + audience + issuer + nonce
async function verifyIdToken(idToken, expectedNonce) {
  const header = JSON.parse(Buffer.from(idToken.split(".")[0], "base64url").toString("utf8"));
  const pem = await jwksKey(header.kid);
  const claims = jwt.verify(idToken, pem, { algorithms: ["RS256"], audience: MS.clientId, issuer: MS.issuer });
  if (expectedNonce && claims.nonce !== expectedNonce) throw new Error("nonce mismatch");
  return claims;
}

// roles → how their scope is shaped
export const ROLE_LABELS = {
  admin: "Admin",
  ceo: "CEO",
  gm: "General Manager",
  opsmgr: "Operations Manager",
  area: "Area Manager",
  store: "Store User",
  ops_director: "Ops Director",
  ops: "Operation Manager (legacy)",
  marketing: "Marketing",
};
// roles that see everything (no brand/location restriction)
const FULL_ACCESS = new Set(["admin", "ceo", "ops", "ops_director"]);
// roles restricted to specific brands (all locations of those brands)
const BRAND_LEVEL = new Set(["gm", "opsmgr", "marketing"]);
// roles restricted to specific (brand, location) pairs
const LOCATION_LEVEL = new Set(["area", "store"]);

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, "[]");
  if (!fs.existsSync(USERS_FILE)) {
    // Use ADMIN_PASSWORD (set by IT in .env.local) if provided; otherwise a default
    // that MUST be reset on first login. Never print the password in production.
    const provided = process.env.ADMIN_PASSWORD;
    const pass = provided || "Admin@123";
    const admin = {
      id: crypto.randomUUID(), email: process.env.ADMIN_EMAIL || "admin@swishhh.net", name: "Administrator",
      passwordHash: bcrypt.hashSync(pass, 10), role: "admin",
      scope: { brands: "all", locations: "all" }, active: true, needsReset: !provided,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify([admin], null, 2));
    if (!provided && process.env.NODE_ENV !== "production") {
      console.log(`\n  [auth] Seeded admin  ->  ${admin.email} / ${pass}  (change after first login)\n`);
    } else {
      console.log(`\n  [auth] Seeded admin ${admin.email} — sign in and set a password (or set ADMIN_PASSWORD).\n`);
    }
  }
}
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { return []; } };
// exported so the server can pre-warm the cache for the exact data scopes real
// users have (not just the all-brands admin scope)
export function activeUsers() { return loadUsers().filter((u) => u.active !== false).map((u) => ({ id: u.id, email: u.email, role: u.role, scope: u.scope })); }
const saveUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
const loadAudit = () => { try { return JSON.parse(fs.readFileSync(AUDIT_FILE, "utf8")); } catch { return []; } };
function audit(actor, action, target, details) {
  const log = loadAudit();
  log.unshift({ ts: new Date().toISOString(), actor, action, target, details });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(log.slice(0, 500), null, 2));
}
// exported so other modules (e.g. the debug editor) can write to the same audit trail
export function logAudit(actor, action, target, details) { ensureStore(); audit(actor, action, target, details); }
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, "utf8");
  const s = crypto.randomBytes(48).toString("hex");
  try { fs.writeFileSync(SECRET_FILE, s); } catch {}
  return s;
}

// public shape (never leak the hash)
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, scope: u.scope, active: u.active });
// the brands a user may see (["*"] means all)
export function allowedBrands(u) {
  if (!u || FULL_ACCESS.has(u.role)) return "all";
  if (u.scope && u.scope.brands && u.scope.brands !== "all") return u.scope.brands;
  return "all";
}
// human-readable scope summary for the admin table
export function scopeSummary(u) {
  if (!u.scope || (u.scope.brands === "all" && u.scope.locations === "all")) return "All brands, all locations";
  const brands = u.scope.brands === "all" ? "All brands" : u.scope.brands.join(", ");
  if (u.scope.locations === "all") return `${brands} (all locations)`;
  const parts = Object.entries(u.scope.locations).map(([b, locs]) => `${b} (${(locs || []).join(", ") || "—"})`);
  return parts.join(" · ") || brands;
}

// normalize the scope a form sends, per role rules
function normalizeScope(role, scope = {}) {
  if (FULL_ACCESS.has(role)) return { brands: "all", locations: "all" };
  const brands = Array.isArray(scope.brands) && scope.brands.length ? scope.brands : [];
  if (LOCATION_LEVEL.has(role)) {                       // area (many locations) / store (one)
    const locations = {};
    for (const b of brands) locations[b] = Array.isArray(scope.locations?.[b]) ? scope.locations[b] : [];
    return { brands, locations };
  }
  // gm / opsmgr / marketing → brand level, all locations of those brands
  return { brands, locations: "all" };
}

const validPw = (p) => typeof p === "string" && p.length >= 8;

export function authMiddleware(req, _res, next) {
  req.user = null;
  const tok = req.cookies?.[COOKIE];
  if (tok) { try { req.user = jwt.verify(tok, getSecret()); } catch {} }
  next();
}
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "auth required" });
  next();
}
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "auth required" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  next();
}
// admin OR ops director — may set operational targets
export function requireOpsDirector(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "auth required" });
  if (req.user.role !== "admin" && req.user.role !== "ops_director") return res.status(403).json({ error: "ops director only" });
  next();
}

export function registerAuth(app) {
  ensureStore();
  getSecret();
  app.use(cookieParser());
  app.use(authMiddleware);

  app.post("/api/login", (req, res) => {
    const { email, password } = req.body || {};
    const users = loadUsers();
    const u = users.find((x) => x.email.toLowerCase() === String(email || "").toLowerCase());
    if (!u || !u.active || !bcrypt.compareSync(String(password || ""), u.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const payload = { id: u.id, email: u.email, name: u.name, role: u.role, scope: u.scope };
    const token = jwt.sign(payload, getSecret(), { expiresIn: `${SESSION_HOURS}h` });
    res.cookie(COOKIE, token, sessionCookie());
    audit(u.email, "login", u.email, "");
    res.json({ user: { ...publicUser(u), needsReset: u.needsReset, isAdmin: u.role === "admin", brands: allowedBrands(u) } });
  });

  app.post("/api/logout", (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

  // tell the client which sign-in methods are available
  app.get("/api/auth/config", (_req, res) => res.json({ microsoft: msEnabled() }));

  // ---- Microsoft Entra ID (Azure AD) sign-in — OpenID Connect auth-code + PKCE ----
  // Step 1: redirect the browser to Microsoft's consent/login screen.
  app.get("/api/auth/microsoft/start", (req, res) => {
    if (!msEnabled()) return res.status(404).send("Microsoft sign-in is not configured.");
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    // stash state/nonce/verifier in a short-lived signed cookie (5 min)
    const flow = jwt.sign({ state, nonce, verifier }, getSecret(), { expiresIn: "5m" });
    res.cookie(MSFLOW, flow, { httpOnly: true, sameSite: "lax", secure: secureCookies(), maxAge: 5 * 60 * 1000 });
    const p = new URLSearchParams({
      client_id: MS.clientId, response_type: "code", redirect_uri: MS.redirectUri,
      response_mode: "query", scope: "openid profile email", state, nonce,
      code_challenge: challenge, code_challenge_method: "S256",
    });
    res.redirect(`${MS.authority}/oauth2/v2.0/authorize?${p}`);
  });

  // Step 2: Microsoft redirects back with a code — exchange it, verify, sign the user in.
  app.get("/api/auth/microsoft/callback", async (req, res) => {
    const fail = (msg) => res.redirect(`${MS.postLoginUrl}?authError=${encodeURIComponent(msg)}`);
    try {
      if (!msEnabled()) return fail("Microsoft sign-in is not configured.");
      const { code, state, error, error_description } = req.query;
      if (error) return fail(error_description || String(error));
      const flowTok = req.cookies?.[MSFLOW];
      res.clearCookie(MSFLOW);
      if (!code || !flowTok) return fail("Sign-in session expired. Please try again.");
      const flow = jwt.verify(flowTok, getSecret());
      if (state !== flow.state) return fail("Invalid sign-in state.");
      // exchange the authorization code for tokens
      const body = new URLSearchParams({
        client_id: MS.clientId, client_secret: MS.clientSecret, grant_type: "authorization_code",
        code: String(code), redirect_uri: MS.redirectUri, code_verifier: flow.verifier, scope: "openid profile email",
      });
      const tr = await fetch(`${MS.authority}/oauth2/v2.0/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
      });
      const tok = await tr.json();
      if (!tr.ok || !tok.id_token) return fail(tok.error_description || "Token exchange failed.");
      const claims = await verifyIdToken(tok.id_token, flow.nonce);
      const email = String(claims.email || claims.preferred_username || claims.upn || "").toLowerCase();
      if (!email) return fail("Your Microsoft account has no email address.");
      // PRE-APPROVED ONLY: the email must already exist as an active user
      const u = loadUsers().find((x) => x.email.toLowerCase() === email && x.active);
      if (!u) { audit(email, "login-denied", email, "Microsoft account not pre-approved"); return fail(`${email} is not authorised. Ask an administrator to add you.`); }
      const payload = { id: u.id, email: u.email, name: u.name, role: u.role, scope: u.scope };
      const token = jwt.sign(payload, getSecret(), { expiresIn: `${SESSION_HOURS}h` });
      res.cookie(COOKIE, token, sessionCookie());
      audit(u.email, "login", u.email, "via Microsoft");
      res.redirect(MS.postLoginUrl);
    } catch (e) { fail("Sign-in failed: " + String(e.message || e)); }
  });

  app.get("/api/me", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "not logged in" });
    const u = loadUsers().find((x) => x.id === req.user.id);
    if (!u || !u.active) { res.clearCookie(COOKIE); return res.status(401).json({ error: "inactive" }); }
    res.json({ ...publicUser(u), needsReset: u.needsReset, isAdmin: u.role === "admin", brands: allowedBrands(u) });
  });

  // ---- admin: user management ----
  app.get("/api/admin/users", requireAdmin, (_req, res) => {
    res.json({ users: loadUsers().map((u) => ({ ...publicUser(u), summary: scopeSummary(u) })) });
  });

  app.post("/api/admin/users", requireAdmin, (req, res) => {
    const { email, password, name, role, scope } = req.body || {};
    if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: "Valid email required" });
    if (!ROLE_LABELS[role] || role === "admin" && false) {} // allow admin creation
    if (!ROLE_LABELS[role]) return res.status(400).json({ error: "Invalid role" });
    // With Microsoft SSO on, a password is optional — pre-approved users sign in with their MS account.
    const ssoOnly = msEnabled() && !password;
    if (!ssoOnly && !validPw(password)) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const users = loadUsers();
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ error: "Email already exists" });
    const u = {
      id: crypto.randomUUID(), email, name: name || email.split("@")[0],
      passwordHash: bcrypt.hashSync(ssoOnly ? crypto.randomBytes(24).toString("hex") : password, 10),
      role, scope: normalizeScope(role, scope), authProvider: ssoOnly ? "microsoft" : "password",
      active: true, needsReset: !ssoOnly, createdAt: new Date().toISOString(),
    };
    users.push(u); saveUsers(users);
    audit(req.user.email, "created", email, `Role: ${ROLE_LABELS[role]}, ${scopeSummary(u)}`);
    res.json({ user: { ...publicUser(u), summary: scopeSummary(u) } });
  });

  app.put("/api/admin/users/:id", requireAdmin, (req, res) => {
    const users = loadUsers();
    const u = users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: "not found" });
    const { name, role, scope, password } = req.body || {};
    const changes = [];
    if (name && name !== u.name) { u.name = name; changes.push("name"); }
    if (role && ROLE_LABELS[role] && role !== u.role) { u.role = role; changes.push(`role→${ROLE_LABELS[role]}`); }
    if (scope !== undefined || role) { u.scope = normalizeScope(u.role, scope || u.scope); changes.push("scope"); }
    if (password) { if (!validPw(password)) return res.status(400).json({ error: "Password too short" }); u.passwordHash = bcrypt.hashSync(password, 10); u.needsReset = true; changes.push("password reset"); }
    u.updatedAt = new Date().toISOString();
    saveUsers(users);
    audit(req.user.email, "edited", u.email, `${changes.join(", ")} — ${scopeSummary(u)}`);
    res.json({ user: { ...publicUser(u), summary: scopeSummary(u) } });
  });

  app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
    const users = loadUsers();
    const u = users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: "not found" });
    if (u.id === req.user.id) return res.status(400).json({ error: "cannot deactivate yourself" });
    u.active = false; u.updatedAt = new Date().toISOString();
    saveUsers(users);
    audit(req.user.email, "deactivated", u.email, "");
    res.json({ ok: true });
  });

  app.get("/api/admin/audit", requireAdmin, (_req, res) => res.json({ log: loadAudit().slice(0, 100) }));
}

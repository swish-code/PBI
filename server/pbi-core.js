// ============================================================================
//  PBI-CORE — the ONLY module that talks to Power BI.
//  Contains: model registry, AAD token (service-principal / device-code), dataset
//  discovery, the per-dataset concurrency gate, and runDax (executeQueries).
//
//  HARD BOUNDARY: this module must be imported ONLY by the worker (worker.js) and
//  the legacy shell (server.js). The cache web entrypoint (web.js) must never reach
//  it — enforced by ESLint no-restricted-imports + a madge dependency-graph test,
//  AND by the runtime guard in runDax (throws unless WORKER=1 or PBI_LEGACY=1).
// ============================================================================
import "./env.js";   // MUST be first — populates process.env before we read it below
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- multi-model registry -------------------------------------------------
export const MODELS_FILE = path.join(__dirname, "data", "models.json");
export const MODELS = {
  main: {
    workspaceId: process.env.WORKSPACE_ID || "c7e619c9-f39c-4491-9c87-2e110bca9330",
    datasetId: process.env.DATASET_ID,
    useGroup: false,
  },
  productmix: {
    workspaceId: "0f38e085-b204-41e5-895e-10b09ce13437",
    reportId: "b37457e6-1ba8-4076-8c1b-ae21921e1ad8",
    datasetId: process.env.PRODUCTMIX_DATASET_ID || "accff459-afde-4ed7-b72f-2768384b27a9",
    useGroup: true,
    brand: "BBT",
  },
  mm: {
    workspaceId: "f1ebb7ca-100b-42da-9b6c-b8b2473f270c",
    reportId: "bfd97ccb-d477-4a9b-ae9d-7e2902afb329",
    datasetId: process.env.MM_DATASET_ID,
    useGroup: true,
    brand: "Mishmash",
  },
  tabel: {
    workspaceId: "f1ebb7ca-100b-42da-9b6c-b8b2473f270c",
    datasetId: process.env.TABEL_DATASET_ID,
    useGroup: true,
    brand: "Tabel",
  },
  shakir: {
    workspaceId: "ac0b48d1-3257-4495-b8ad-4b03cbe0e4e5",
    datasetId: process.env.SHAKIR_DATASET_ID,
    useGroup: true,
    brand: "Shawarma Shakir",
  },
  yelo: {
    workspaceId: "619e852b-65b5-4f5e-a848-6a4ceb4e8ba8",
    datasetId: process.env.YELO_DATASET_ID,
    useGroup: true,
  },
  shared: {
    workspaceId: "6ec3386b-1c37-418d-a901-1d711e517acc",
    datasetId: process.env.SHARED_DATASET_ID,
    useGroup: true,
  },
};
export function brandModels() { const m = {}; for (const [k, v] of Object.entries(MODELS)) if (v.brand) m[v.brand] = k; return m; }
export function loadModelsConfig() {
  try { const j = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")); for (const [k, v] of Object.entries(j)) if (MODELS[k] && v.datasetId) MODELS[k].datasetId = v.datasetId; } catch { /* none yet */ }
}
export function saveModelsConfig() {
  try { fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true }); fs.writeFileSync(MODELS_FILE, JSON.stringify(Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, { datasetId: v.datasetId }])), null, 2)); } catch {}
}
loadModelsConfig();
export async function discoverDataset(model) {
  const m = MODELS[model];
  if (!m) throw new Error("unknown model: " + model);
  if (m.datasetId) return m.datasetId;
  if (!m.reportId) throw new Error(`model '${model}' has no datasetId and no reportId to discover it from`);
  const token = await getToken();
  const r = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${m.workspaceId}/reports/${m.reportId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401 || r.status === 403) throw new Error(`Access denied to the '${model}' report — grant the identity access to workspace ${m.workspaceId} and Build on its dataset (HTTP ${r.status}).`);
  if (!r.ok) throw new Error(`Failed to read '${model}' report (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.datasetId) throw new Error(`report response had no datasetId`);
  m.datasetId = j.datasetId; saveModelsConfig();
  console.log(`  [model] discovered '${model}' datasetId = ${m.datasetId}`);
  return m.datasetId;
}

// ---- AAD token (service principal in prod; device-code dev fallback) --------
const AUTHORITY = `https://login.microsoftonline.com/${process.env.TENANT_ID}`;
const PBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default offline_access";
const TOKEN_FILE = path.join(__dirname, ".pbi-token.json");
let cachedToken = { token: null, exp: 0 };
let refreshToken = loadRefreshToken();
let authInFlight = null;

function loadRefreshToken() {
  // The on-disk token ROTATES — Azure issues a new refresh token on each renewal and the
  // app rewrites this file (env vars can't be rewritten at runtime, so the token can't
  // live only in the env). But the env can SEED it: PBI_REFRESH_TOKEN is used once when
  // there's no file yet, then the rotating file takes over. Lets IT hand off a single file.
  try { const t = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).refresh_token; if (t) return t; } catch { /* no file yet */ }
  return process.env.PBI_REFRESH_TOKEN || null;
}
function saveRefreshToken(rt) {
  refreshToken = rt;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: rt }, null, 2), { mode: 0o600 }); }
  catch (e) { console.warn("  Could not save token file:", e.message); }
}
function storeTokens(j) {
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  if (j.refresh_token) saveRefreshToken(j.refresh_token);
  return cachedToken.token;
}
async function postToken(params) {
  const r = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
  });
  return r.json();
}
async function refreshAccess() {
  const j = await postToken({ grant_type: "refresh_token", client_id: process.env.CLIENT_ID, scope: PBI_SCOPE, refresh_token: refreshToken });
  if (!j.access_token) throw new Error("refresh failed: " + JSON.stringify(j));
  return storeTokens(j);
}
async function deviceLogin() {
  const dcRes = await fetch(`${AUTHORITY}/oauth2/v2.0/devicecode`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.CLIENT_ID, scope: PBI_SCOPE }),
  });
  const dc = await dcRes.json();
  if (!dc.device_code) throw new Error("device code request failed: " + JSON.stringify(dc));
  console.log("\n  ============================================================");
  console.log("   SIGN IN TO POWER BI  (one time)");
  console.log("  ------------------------------------------------------------");
  console.log(`   1. Open:        ${dc.verification_uri}`);
  console.log(`   2. Enter code:  ${dc.user_code}`);
  console.log("  ============================================================\n");
  let interval = (dc.interval || 5) * 1000;
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, interval));
    const j = await postToken({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: process.env.CLIENT_ID, device_code: dc.device_code });
    if (j.access_token) { console.log("  Signed in. Token saved.\n"); return storeTokens(j); }
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") { interval += 5000; continue; }
    throw new Error("device login failed: " + JSON.stringify(j));
  }
  throw new Error("device login timed out — restart the app and try again");
}
async function getAppToken() {
  const j = await postToken({ grant_type: "client_credentials", client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, scope: "https://analysis.windows.net/powerbi/api/.default" });
  if (!j.access_token) throw new Error("client-credentials token failed: " + JSON.stringify(j));
  return storeTokens(j);
}
export const PBI_AUTH = (process.env.PBI_AUTH || "devicecode").toLowerCase();
export async function getToken() {
  if (cachedToken.token && Date.now() < cachedToken.exp) return cachedToken.token;
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    if (PBI_AUTH === "sp") return await getAppToken();
    if (refreshToken) { try { return await refreshAccess(); } catch (e) { console.warn("  Saved sign-in expired, asking again:", e.message); } }
    return await deviceLogin();
  })();
  try { return await authInFlight; } finally { authInFlight = null; }
}
export function startTokenRefresher() {
  setInterval(() => {
    if (!cachedToken.exp) return;
    if (Date.now() > cachedToken.exp - 10 * 60_000) { cachedToken.exp = 0; getToken().catch((e) => console.warn("  [token] proactive refresh failed:", e.message)); }
  }, 60_000).unref();
}

// ---- per-dataset concurrency gate + runDax ---------------------------------
const DS_CONCURRENCY = Number(process.env.PBI_DS_CONCURRENCY) || 2;
const _dsActive = new Map();   // total in-flight per dataset
const _dsBg = new Map();       // background (prewarm) in-flight per dataset
const _dsWaiters = new Map();
const _cnt = (m, k) => m.get(k) || 0;
// Priority gate: live user queries (prio 0) always keep at least one open slot.
// Background prewarm (prio > 0) may use at most DS_CONCURRENCY-1 slots, so a cold
// user request is NEVER stuck behind a flood of prewarm queries — it always has a
// slot free and takes it immediately.
async function acquireDs(dsId, prio = 0) {
  const bgCap = Math.max(1, DS_CONCURRENCY - 1);
  const canStart = () => _cnt(_dsActive, dsId) < DS_CONCURRENCY && (prio === 0 || _cnt(_dsBg, dsId) < bgCap);
  while (!canStart()) {
    await new Promise((res) => { const q = _dsWaiters.get(dsId) || []; q.push(res); _dsWaiters.set(dsId, q); });
  }
  _dsActive.set(dsId, _cnt(_dsActive, dsId) + 1);
  if (prio > 0) _dsBg.set(dsId, _cnt(_dsBg, dsId) + 1);
}
function releaseDs(dsId, prio = 0) {
  _dsActive.set(dsId, Math.max(0, _cnt(_dsActive, dsId) - 1));
  if (prio > 0) _dsBg.set(dsId, Math.max(0, _cnt(_dsBg, dsId) - 1));
  const q = _dsWaiters.get(dsId);      // wake all waiters; each re-checks canStart (user work wins the free slot)
  if (q && q.length) { _dsWaiters.set(dsId, []); for (const res of q) res(); }
}

// Structural guard: Power BI is allowed in every process EXCEPT the FUTURE dedicated
// cache web entrypoint (web.js), which will launch with WEB_NO_PBI=1. This keeps the
// current hosting (legacy server.js) working with no special env; the boundary
// re-tightens automatically the moment web.js ships with WEB_NO_PBI=1.
const PBI_ALLOWED = process.env.WEB_NO_PBI !== "1";

export async function runDax(dax, model = "main", opts = {}) {
  const prio = opts.priority || 0;   // 0 = live user (reserved slot); >0 = background prewarm
  if (!PBI_ALLOWED) throw new Error("runDax is blocked in the cache web entrypoint (WEB_NO_PBI=1). Only the worker / legacy shell may query Power BI.");
  const m = MODELS[model];
  if (!m) throw new Error("unknown model: " + model);
  const dsId = m.datasetId || await discoverDataset(model);
  const url = m.useGroup
    ? `https://api.powerbi.com/v1.0/myorg/groups/${m.workspaceId}/datasets/${dsId}/executeQueries`
    : `https://api.powerbi.com/v1.0/myorg/datasets/${dsId}/executeQueries`;
  const body = JSON.stringify({ queries: [{ query: dax }], serializerSettings: { includeNulls: true } });
  await acquireDs(dsId, prio);
  try {
    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
      if (r.status === 429) {
        const ra = Number(r.headers.get("retry-after")) || 0;
        const wait = (ra > 0 ? ra * 1000 : Math.min(30_000, 1000 * 2 ** attempt)) + Math.floor(Math.random() * 500);
        console.error(`  [ALERT][429] Power BI throttled model '${model}' (dataset ${dsId}) — retry-after ${ra || "?"}s, waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1})`);
        if (attempt >= 5) throw new Error(`Power BI 429: exhausted retries for model '${model}'`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      const j = await r.json();
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error(`Access denied to model '${model}' — the identity needs Build permission / access to workspace ${m.workspaceId} (HTTP ${r.status}).`);
        throw new Error("Query failed: " + JSON.stringify(j));
      }
      return j.results[0].tables[0].rows;
    }
  } finally { releaseDs(dsId, prio); }
}

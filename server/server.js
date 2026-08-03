// ============================================================================
// THE WAITER
// Sits between the website and Power BI. The website asks it for numbers at
// /api/dax; it fetches them from your Power BI model and hands them back.
// Until you fill in .env, it serves SAMPLE data so you can see the app work.
// ============================================================================

import express from "express";
import cors from "cors";
import compression from "compression";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAssistant } from "./assistant.js";
import { registerVoiceBrief } from "./voicebrief.js";
import { registerNarration } from "./narration.js";
import { registerBranches } from "./branches.js";
import { registerAuth, requireAuth, requireAdmin, requireOpsDirector, allowedBrands, logAudit, activeUsers } from "./auth.js";
import { registerDebug, getVizOverride } from "./debug.js";
import { registerEngagement } from "./engagement.js";
import { registerLayouts } from "./layouts.js";
import { createPersistence, CACHE_VERSION } from "./cache.js";
import { Agent, setGlobalDispatcher } from "undici";
// Power BI query core lives in pbi-core.js (the only module that calls Power BI).
// server.js is the LEGACY shell — allowed to import it (launched with PBI_LEGACY=1).
import { MODELS, MODELS_FILE, brandModels, loadModelsConfig, saveModelsConfig, discoverDataset, getToken, startTokenRefresher, runDax, PBI_AUTH } from "./pbi-core.js";

// ONE shared keep-alive connection pool for ALL outbound HTTPS (Power BI + AAD).
// Reuses TLS connections instead of a fresh handshake per request — cuts per-call
// latency and lets the worker sustain its query budget without connection churn.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 10 * 60_000, connections: 64, pipelining: 1 }));

// Load server/.env no matter which folder `node` was launched from.
// (npm run dev starts this as `node server/server.js` from the project root,
//  so the default cwd-based lookup would miss server/.env.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env.local FIRST so its values win (dotenv never overrides an already-set
// var), then .env fills the gaps. IT puts production overrides (PORT, MS_REDIRECT_URI,
// APP_URL, dataset IDs, secrets) in server/.env.local — .env stays the dev defaults.
dotenv.config({ path: path.join(__dirname, ".env.local") });
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
// Behind a reverse proxy / load balancer (the way you'd run this for 300 users),
// trust X-Forwarded-* so client IPs and secure cookies work correctly.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);
app.disable("x-powered-by");
// gzip all responses — viz JSON compresses ~75%. Threshold skips tiny bodies so
// we don't spend CPU compressing sub-1KB payloads under load.
app.use(compression({ threshold: 1024 }));
// In production the SPA + API are same-origin (behind IIS), so lock CORS to the known
// app origin(s). In dev, Vite proxies /api (same-origin from the browser) so `true` is fine.
const CORS_ORIGIN = process.env.APP_URL ? [process.env.APP_URL] : true;
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// auth + user management (login / logout / me / admin) + cookie session
registerAuth(app);

const PORT = Number(process.env.PORT) || 7001;

// Is Power BI configured? (device-code login needs only these three)
const LIVE = Boolean(
  process.env.TENANT_ID && process.env.CLIENT_ID && process.env.DATASET_ID
);

// MODELS registry, dataset discovery, token/auth and runDax now live in pbi-core.js
// (imported above). This keeps the ONLY Power BI code path in one guarded module.

// ---- the exact queries your dashboard runs (from Power BI "Copy query") ------
// brandScorecard is the real brand-table query. The single-day date filter is
// parameterised: `dateExpr` defaults to TODAY(), or a "YYYY-MM-DD" from the UI
// becomes DATE(y,m,d) (see dateExprFrom + the /api/dax route). It groups by
// 'Brand Table'[Brand Full Name] with ROLLUPADDISSUBTOTAL, so the result has a
// grand-total row flagged by [IsGrandTotalRowTotal]=1 (used for the KPI cards).
function brandScorecardDax(range) {
  return `
DEFINE
  VAR __DS0FilterTable =
    FILTER(
      KEEPFILTERS(VALUES('DATETABLE'[DATE])),
      ${rangeFilterBody(range)}
    )
  VAR __DS0FilterTable2 = ${brandFilterVar()}
  VAR __ValueFilterDM3 =
    FILTER(
      KEEPFILTERS(
        SUMMARIZECOLUMNS(
          'Brand Table'[Brand Full Name],
          'LocationMaster'[Location],
          __DS0FilterTable,
          __DS0FilterTable2,
          "CountTRXSALES", CALCULATE(COUNTA('SALES DATA'[TRXSALES])),
          "SumDaily_Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
          "SumMonthRunrate", CALCULATE(SUM('FORECAST BRANCH'[MonthRunrate])),
          "AOV", 'Append1'[AOV],
          "SumNET", CALCULATE(SUM('SALES DATA'[NET]))
        )
      ),
      [SumNET] > 0
    )
  VAR __DS0Core =
    SUMMARIZECOLUMNS(
      ROLLUPADDISSUBTOTAL('Brand Table'[Brand Full Name], "IsGrandTotalRowTotal"),
      __DS0FilterTable,
      __DS0FilterTable2,
      __ValueFilterDM3,
      "CountTRXSALES", CALCULATE(COUNTA('SALES DATA'[TRXSALES])),
      "SumDaily_Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
      "Sales_Variance___Text", 'Append1'[Sales Variance % Text],
      "SumMonthRunrate", CALCULATE(SUM('FORECAST BRANCH'[MonthRunrate])),
      "Runrate___Text", 'Append1'[Runrate % Text],
      "AOV", 'Append1'[AOV],
      "Sales_Growth_vs_LastWeek_Text", 'Append1'[Sales_Growth_vs_LastWeek_Text],
      "Sales_Growth_vs_SameDay_LastYear_Text", 'Append1'[Sales_Growth_vs_SameDay_LastYear_Text],
      "SumNET", CALCULATE(SUM('SALES DATA'[NET]))
    )
  VAR __DS0PrimaryWindowed =
    TOPN(502, __DS0Core, [IsGrandTotalRowTotal], 0, 'Brand Table'[Brand Full Name], 1)
EVALUATE
  __DS0PrimaryWindowed
ORDER BY
  [IsGrandTotalRowTotal] DESC, 'Brand Table'[Brand Full Name]`;
}

const TEMPLATES = {
  // function templates receive the resolved date expression
  brandScorecard: brandScorecardDax,
  brandBoard: `
    EVALUATE
    SUMMARIZECOLUMNS(
        'Brand'[Brand], 'Brand'[Ticker],
        "SalesToday",   [Net Sales KD],
        "ProjectedNow", [Projected KD to Now],
        "Orders",       [Orders],
        "AOV",          [AOV KD]
    )
    ORDER BY [SalesToday] DESC`,
  intraday: `
    EVALUATE
    SUMMARIZECOLUMNS(
        'Time'[Bucket],
        "Actual",    [Cumulative Net Sales KD],
        "Projected", [Cumulative Projected KD]
    )
    ORDER BY 'Time'[Bucket]`,
};

// ---- date range + preset resolver (all pages share one selection) ----------
// "today" is resolved in Asia/Kuwait. Presets become a concrete [start,end]
// (inclusive), which rangeFilterBody() turns into a DAX DATETABLE filter.
const validIso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s : null);
function kuwaitToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuwait" }); // YYYY-MM-DD
}
function addDays(iso, n) {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const firstOfMonth = (iso) => iso.slice(0, 8) + "01";
function weekStart(iso) { // week starts Saturday (Kuwait)
  const dow = new Date(iso + "T00:00:00Z").getUTCDay(); // 0 Sun .. 6 Sat
  return addDays(iso, -((dow + 1) % 7));
}
function resolveRange(sel = {}) {
  const today = kuwaitToday();
  const preset = sel.preset || (sel.start ? "custom" : "today");
  let start = today, end = today;
  switch (preset) {
    case "yesterday": start = end = addDays(today, -1); break;
    case "last7": start = addDays(today, -6); break;
    case "thisWeek": start = weekStart(today); break;
    case "lastWeek": { const ws = weekStart(today); start = addDays(ws, -7); end = addDays(ws, -1); break; }
    case "thisMonth": start = firstOfMonth(today); break;
    case "lastMonth": { const prev = addDays(firstOfMonth(today), -1); start = firstOfMonth(prev); end = prev; break; }
    case "custom": start = validIso(sel.start) || today; end = validIso(sel.end) || start; break;
    case "today": default: break;
  }
  if (end < start) [start, end] = [end, start];
  return { preset, start, end };
}
// DAX DATETABLE filter body for a range (end is inclusive -> < end+1)
function rangeFilterBody(range) {
  const s = range.start.split("-").map(Number);
  const e = addDays(range.end, 1).split("-").map(Number);
  return `AND('DATETABLE'[DATE] >= DATE(${s[0]}, ${s[1]}, ${s[2]}), 'DATETABLE'[DATE] < DATE(${e[0]}, ${e[1]}, ${e[2]}))`;
}
// build a range from request params (?preset= | ?start=&end= | ?date= legacy)
function rangeFromReq(q = {}) {
  if (q.date && !q.preset && !q.start) return resolveRange({ preset: "custom", start: q.date, end: q.date });
  return resolveRange({ preset: q.preset, start: q.start, end: q.end });
}

// ---- which real user each demo role runs as (for Row-Level Security) --------
// In production this comes from the signed-in user, NOT from the browser.
const ROLE_TO_USER = {
  ceo:   process.env.RLS_CEO   || "ceo@yourco.com",
  brand: process.env.RLS_BRAND || "bm.yelo@yourco.com",
  area:  process.env.RLS_AREA  || "am.salmiya@yourco.com",
};

// ======================= SAMPLE DATA (used until LIVE) ======================
const SAMPLE = [
  { brand: "Mishmash", ticker: "MSH", sales: 7420 }, { brand: "Yelo Pizza", ticker: "YLO", sales: 6180 },
  { brand: "Tabel", ticker: "TBL", sales: 5240 }, { brand: "Pattie Pattie", ticker: "PTY", sales: 3960 },
  { brand: "BBT", ticker: "BBT", sales: 3110 }, { brand: "Slice", ticker: "SLC", sales: 2480 },
  { brand: "Karak House", ticker: "KRK", sales: 2210 }, { brand: "Wok This Way", ticker: "WOK", sales: 1890 },
].map((b) => ({
  ...b,
  projected: Math.round(b.sales / 0.99),
  orders: Math.round(b.sales / 3),
  aov: +(b.sales / Math.round(b.sales / 3)).toFixed(2),
  spark: Array.from({ length: 14 }, (_, k) => Math.round((b.sales / 14) * (k + 1) * (0.88 + Math.random() * 0.24))),
}));

function scopeSample(role) {
  if (role === "brand") return SAMPLE.filter((b) => b.brand === "Yelo Pizza");
  if (role === "area") {
    const f = 2 / 6;
    return SAMPLE.map((b) => ({ ...b, sales: Math.round(b.sales * f), projected: Math.round(b.projected * f), orders: Math.round(b.orders * f), spark: b.spark.map((v) => Math.round(v * f)) }));
  }
  return SAMPLE;
}

function sampleIntraday(role) {
  const total = scopeSample(role).reduce((s, b) => s + b.sales, 0);
  const labels = Array.from({ length: 29 }, (_, i) => `${String(10 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
  let a = 0, p = 0;
  return labels.map((t, i) => {
    const w = Math.sin((i / 28) * Math.PI * 0.92) * (1 + i / 40);
    a += w; p += w * 1.0;
    const s = total / 34;
    return { t, actual: i <= 18 ? Math.round(a * s) : null, projected: Math.round(p * s * 1.03) };
  });
}

// sample equivalent of the live brandScorecard shape: { brands, total }
function sampleScorecard(role) {
  const pct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%";
  const brands = scopeSample(role).map((b) => {
    const target = b.projected;
    return {
      brand: b.brand,
      netSales: b.sales,
      dailyTarget: target,
      varianceText: pct(b.sales / target - 1),
      runrate: Math.round(b.sales * 30),
      runrateText: pct(b.sales / target - 1),
      aov: b.aov,
      orders: b.orders,
      growthWoWText: pct((b.sales % 7) / 50 - 0.06),
      growthYoYText: pct((b.sales % 11) / 40 - 0.05),
    };
  });
  const sum = (k) => brands.reduce((s, b) => s + b[k], 0);
  const netSales = sum("netSales"), orders = sum("orders"), dailyTarget = sum("dailyTarget");
  const total = {
    brand: "All brands", netSales, dailyTarget, orders,
    varianceText: pct(netSales / dailyTarget - 1),
    runrate: sum("runrate"), runrateText: pct(netSales / dailyTarget - 1),
    aov: orders ? +(netSales / orders).toFixed(2) : 0,
    growthWoWText: "", growthYoYText: "",
  };
  return { brands, total };
}

// ======================= LIVE: talk to Power BI =============================
// Token/auth, per-dataset concurrency gate and runDax now live in pbi-core.js.

// map Power BI's row keys -> the clean shape the website expects
function mapBoard(rows) {
  return rows.map((r) => ({
    brand: r["Brand[Brand]"], ticker: r["Brand[Ticker]"],
    sales: r["[SalesToday]"], projected: r["[ProjectedNow]"],
    orders: r["[Orders]"], aov: r["[AOV]"], spark: [],
  }));
}
function mapIntraday(rows) {
  return rows.map((r) => ({ t: r["Time[Bucket]"], actual: r["[Actual]"], projected: r["[Projected]"] }));
}

// brandScorecard rows -> { brands: [...], total: {...grand-total row} }
function mapScorecard(rows) {
  const rec = (r) => ({
    brand: r["Brand Table[Brand Full Name]"],
    netSales: r["[SumNET]"] ?? 0,
    dailyTarget: r["[SumDaily_Target]"] ?? 0,
    varianceText: r["[Sales_Variance___Text]"] ?? "",
    runrate: r["[SumMonthRunrate]"] ?? 0,
    runrateText: r["[Runrate___Text]"] ?? "",
    aov: r["[AOV]"] ?? 0,
    orders: r["[CountTRXSALES]"] ?? 0,
    growthWoWText: r["[Sales_Growth_vs_LastWeek_Text]"] ?? "",
    growthYoYText: r["[Sales_Growth_vs_SameDay_LastYear_Text]"] ?? "",
  });
  const brands = [];
  let total = null;
  for (const r of rows) {
    const flag = r["[IsGrandTotalRowTotal]"];
    if (flag === true || flag === 1) total = { ...rec(r), brand: "All brands" };
    else brands.push(rec(r));
  }
  return { brands, total };
}

// ============================================================================
// TAB 2 — "Overview" page. One registry entry per exported Power BI visual,
// with the exact measures/columns taken from the report's Performance Analyzer
// capture. Each runs for the selected single day (defaults to TODAY()).
// `cols` maps Power BI's row keys -> clean field names for the website.
// ============================================================================
// shared DEFINE vars: the selected date-range filter + non-blank brand filter
// ---- GLOBAL brand scope -----------------------------------------------------
// A single request-scoped brand drives the __brand filter var used by (almost)
// every query, so selecting a brand in the header scopes the whole platform.
// Set synchronously at route entry BEFORE the (sync) DAX build, so each request
// captures its own brand with no interleaving. RLS still applies on top.
const CURRENT = { brand: null, user: null };
const daxList = (arr) => arr.map((s) => `"${String(s).replace(/"/g, '""')}"`).join(", ");
// The __brand filter is injected into EVERY query, so it is the enforcement point.
// It returns the intersection of (a) the brand the user requested in the header and
// (b) the brand/location scope of the logged-in user. An Area Manager is scoped by
// LOCATION (their branches), which also implies their brand; GM/Marketing by BRAND;
// Operation Manager / Admin see everything. A request outside scope returns no rows.
function brandFilterVar() {
  const req = CURRENT.brand && CURRENT.brand !== "all" ? CURRENT.brand : null;
  const u = CURRENT.user;
  const sc = u && u.scope ? u.scope : { brands: "all", locations: "all" };

  // location-restricted user (Area Manager) — filter to the exact (brand, location)
  // PAIRS they own. Location names repeat across brands, so we must constrain BOTH
  // columns together via TREATAS, or another brand's same-named branch would leak.
  if (sc.locations && sc.locations !== "all") {
    const esc = (s) => String(s).replace(/"/g, '""');
    const pairs = [];
    for (const [b, arr] of Object.entries(sc.locations)) {
      if (req && b !== req) continue;                 // header brand narrows within scope
      (arr || []).forEach((l) => pairs.push(`("${esc(b)}", "${esc(l)}")`));
    }
    if (!pairs.length) return `FILTER(ALL('LocationMaster'[Location]), FALSE())`; // out of scope → nothing
    return `TREATAS({${pairs.join(", ")}}, 'Brand Table'[Brand Full Name], 'LocationMaster'[Location])`;
  }

  // brand-restricted user (GM / Marketing) or all-brands (Admin / Ops)
  let brands = sc.brands && sc.brands !== "all" ? sc.brands.slice() : null;
  if (req) brands = brands ? brands.filter((b) => b === req) : [req];
  if (brands && brands.length === 0) return `FILTER(ALL('Brand Table'[Brand Full Name]), FALSE())`; // out of scope
  if (brands) return `FILTER(ALL('Brand Table'[Brand Full Name]), 'Brand Table'[Brand Full Name] IN {${daxList(brands)}})`;
  return `FILTER(KEEPFILTERS(VALUES('Brand Table'[Brand])), NOT('Brand Table'[Brand] IN {BLANK()}))`;
}

const dayFilters = (range) => `
  VAR __date = FILTER(KEEPFILTERS(VALUES('DATETABLE'[DATE])), ${rangeFilterBody(range)})
  VAR __brand = ${brandFilterVar()}`;

// FORECAST BRANCH stores short brand CODES; the global brand selector passes full
// names. Translate so the top selector can drive the Branch Runrate directly.
const FB_BRAND_MAP = { "BBT": "BBT", "Chilli Pepper": "CHP", "Just C": "BUR", "Mishmash": "MM", "Pattie Pattie": "PAT", "Shawarma Shakir": "SS", "Slice": "SLC", "Tabel": "TBL", "Yelo Pizza": "YP" };
const fbBrand = (v) => (v ? (FB_BRAND_MAP[v] || v) : v);
// Server-side scope for FORECAST BRANCH queries: a scoped user can only ever see their
// own runrate, even by URL manipulation. Returns DAX FILTER vars + a matching arg string
// (empty for full-access users). Brand codes come from FB_BRAND_MAP; per-LOCATION scope
// (area/store) maps the user's full location names -> LocationMaster[LocationID] ->
// FORECAST BRANCH[BRANCH] (the forecast table stores locations as those 3-letter codes).
function fbScopeVar() {
  const u = CURRENT.user;
  const sc = u && u.scope ? u.scope : null;
  const brands = sc && sc.brands && sc.brands !== "all" ? sc.brands : null;
  if (!brands || !brands.length) return { def: "", arg: "" };
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const codes = [...new Set(brands.map((b) => fbBrand(b)))];
  let def = `\n  VAR __fbBrand = FILTER(ALL('FORECAST BRANCH'[BRAND]), 'FORECAST BRANCH'[BRAND] IN {${codes.map(q).join(", ")}})`;
  let arg = ", __fbBrand";
  if (sc.locations && sc.locations !== "all") {
    const locs = [...new Set(Object.values(sc.locations).flat().filter(Boolean))];
    if (locs.length) {
      def += `\n  VAR __fbLocNames = {${locs.map(q).join(", ")}}`
        + `\n  VAR __fbLocIDs = SELECTCOLUMNS(FILTER(ALL('LocationMaster'), 'LocationMaster'[Location] IN __fbLocNames), "id", 'LocationMaster'[LocationID])`
        + `\n  VAR __fbLoc = FILTER(ALL('FORECAST BRANCH'[BRANCH]), 'FORECAST BRANCH'[BRANCH] IN __fbLocIDs)`;
      arg += ", __fbLoc";
    }
  }
  return { def, arg };
}

// ---- weekday-aligned period comparisons (WoW / MoM / YoY) -------------------
// Comparisons use WHOLE-WEEK offsets so the weekday always lines up:
//   -7 days (last week), -28 days (~last month), -364 days (52 weeks = last year).
// Each period is its own date-filter table; measures apply it via CALCULATE, so
// the grouping carries no date filter and each column re-evaluates in its window.
const betweenBody = (range) => {
  const s = range.start.split("-").map(Number);
  const e = addDays(range.end, 1).split("-").map(Number);
  return `'DATETABLE'[DATE] >= DATE(${s[0]}, ${s[1]}, ${s[2]}) && 'DATETABLE'[DATE] < DATE(${e[0]}, ${e[1]}, ${e[2]})`;
};
const shiftRange = (range, days) => ({ start: addDays(range.start, days), end: addDays(range.end, days) });
const dayCount = (range) => Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1;
// calendar month/year arithmetic (clamps the day to the target month's length)
const addMonths = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  let ny = y, nm = m + n;
  while (nm < 1) { nm += 12; ny--; }
  while (nm > 12) { nm -= 12; ny++; }
  const ld = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, ld)).padStart(2, "0")}`;
};
const shiftMonthsR = (range, n) => ({ start: addMonths(range.start, n), end: addMonths(range.end, n) });
const shiftYearsR = (range, n) => ({ start: addMonths(range.start, n * 12), end: addMonths(range.end, n * 12) });
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// false | 'month' | 'month+' — a whole calendar month (June 1–30) or month + first-of-next (June 1–Jul 1)
function calType(range) {
  const [sy, sm, sd] = range.start.split("-").map(Number);
  const [ey, em, ed] = range.end.split("-").map(Number);
  if (sd !== 1) return false;
  if (ey === sy && em === sm && ed === lastDayOfMonth(sy, sm)) return "month";
  let ny = sy, nm = sm + 1; if (nm > 12) { nm = 1; ny++; }
  if (ey === ny && em === nm && ed === 1) return "month+";
  return false;
}
// Weekday-aligned for short ranges (whole-week offsets keep the weekday), calendar-aligned
// for whole-month / long ranges. MoM: prev calendar month when the range is a month, else −28d.
// YoY: prev calendar year for month/long ranges, else −364d (52 weeks, weekday-aligned).
// Which comparison periods the CURRENT range will actually display. quad()/quint()
// read this to emit only the CALCULATE columns that get shown — WoW only for ≤7d,
// QoQ only for >35d (Operations long mode) — instead of always computing all of
// W/M/Q/Y. Every VAR is still defined (below) so manual CALCULATE(..,__w/__q)
// references never break; we only skip the expensive per-measure evaluations.
// Set synchronously by periodVars() at the very start of each query template, so
// it's always current before quad()/quint() run later in the same literal.
let _cmp = { w: true, q: true };
function periodVars(range) {
  const n = dayCount(range);
  const cal = calType(range);
  _cmp = { w: n <= 7, q: n > 35 };            // m + y are always shown
  const wR = shiftRange(range, -7);
  const mR = cal ? shiftMonthsR(range, -1) : shiftRange(range, -28);
  const qR = shiftRange(range, -91);
  const yR = (cal || n >= 30) ? shiftYearsR(range, -1) : shiftRange(range, -364);
  const mk = (name, r) => `  VAR ${name} = FILTER(ALL('DATETABLE'[DATE]), ${betweenBody(r)})`;
  return "\n" + [
    mk("__cur", range), mk("__w", wR), mk("__m", mR), mk("__q", qR), mk("__y", yR),
    `  VAR __brand = ${brandFilterVar()}`,
  ].join("\n");
}
// A saved admin override is a frozen DAX string with the date window baked in at
// save time — so it would ignore the selected range. Re-inject the LIVE period
// windows (+ brand/scope filter) into the override so it stays date-reactive.
function refreshOverrideScope(dax, range) {
  let out = dax;
  const n = dayCount(range), cal = calType(range);
  const wins = {
    __cur: range,
    __w: shiftRange(range, -7),
    __m: cal ? shiftMonthsR(range, -1) : shiftRange(range, -28),
    __q: shiftRange(range, -91),
    __y: (cal || n >= 30) ? shiftYearsR(range, -1) : shiftRange(range, -364),
  };
  for (const [name, r] of Object.entries(wins)) {
    const re = new RegExp(`VAR ${name} = FILTER\\(ALL\\('DATETABLE'\\[DATE\\]\\), [\\s\\S]*?\\)\\)(?=\\r?\\n)`);
    out = out.replace(re, `VAR ${name} = FILTER(ALL('DATETABLE'[DATE]), ${betweenBody(r)})`);
  }
  // dayFilters-style single __date window
  out = out.replace(/VAR __date = FILTER\(KEEPFILTERS\(VALUES\('DATETABLE'\[DATE\]\)\), [\s\S]*?\)\)(?=\r?\n)/,
    `VAR __date = FILTER(KEEPFILTERS(VALUES('DATETABLE'[DATE])), ${rangeFilterBody(range)})`);
  // always refresh the brand/scope filter to the live global selection
  out = out.replace(/VAR __brand = [\s\S]*?(?=\r?\n)/, `VAR __brand = ${brandFilterVar()}`);
  return out;
}
// current + comparison columns for one measure. Only the periods active for the
// selected range are emitted (see _cmp): WoW for ≤7d, QoQ for >35d, MoM+YoY
// always. Unshown columns are simply absent → the frontend maps them to
// undefined and already hides them for that range. This cuts the per-measure
// CALCULATE work by 20–40% on the common monthly/period views.
const cmpCols = (base, expr, withQ) =>
  `\n  "${base}", CALCULATE(${expr}, __cur),`
  + (_cmp.w ? `\n  "${base}_W", CALCULATE(${expr}, __w),` : "")
  + `\n  "${base}_M", CALCULATE(${expr}, __m),`
  + (withQ && _cmp.q ? `\n  "${base}_Q", CALCULATE(${expr}, __q),` : "")
  + `\n  "${base}_Y", CALCULATE(${expr}, __y)`;
const quint = (base, expr) => cmpCols(base, expr, true);
const quintCols = (as, key) => [[as, `[${key}]`], [`${as}_w`, `[${key}_W]`], [`${as}_m`, `[${key}_M]`], [`${as}_q`, `[${key}_Q]`], [`${as}_y`, `[${key}_Y]`]];
const quad = (base, expr) => cmpCols(base, expr, false);
const quadCols = (as, key) => [[as, `[${key}]`], [`${as}_w`, `[${key}_W]`], [`${as}_m`, `[${key}_M]`], [`${as}_y`, `[${key}_Y]`]];

// ---- DAX-generated insight narration (same pattern as KPI_Insight_Final) ------
// Query-scoped copies (…_q names) so they run LIVE now without republishing and
// never collide with the model measures once you publish the clean-named ones.
// Each is evaluated wrapped in CALCULATE(…, __cur) so the period context applies.
const INS = {
  Brand_Insight_q: `
    VAR BrandName = SELECTEDVALUE('Brand Table'[Brand Full Name])
    VAR Threshold = 0.02
    VAR WoW = [Sales WoW %]  VAR OrdersW = [Orders WoW %]  VAR AOVW = [AOV WoW %]
    VAR HasWoW = NOT ISBLANK(WoW)  VAR HasOrd = NOT ISBLANK(OrdersW)  VAR HasAOV = NOT ISBLANK(AOVW)
    VAR SalesUp = HasWoW && WoW > Threshold  VAR SalesDown = HasWoW && WoW < -Threshold
    VAR SalesFlat = HasWoW && NOT SalesUp && NOT SalesDown
    VAR OrdUp = HasOrd && OrdersW > Threshold  VAR OrdDown = HasOrd && OrdersW < -Threshold
    VAR AOVUp = HasAOV && AOVW > Threshold  VAR AOVDown = HasAOV && AOVW < -Threshold
    VAR MoveText = FORMAT(ABS(WoW), "0.0%")
    VAR TrendText = SWITCH(TRUE(), NOT HasWoW, "",
        SalesDown, "declined " & MoveText & " " & [WoW_Label],
        SalesUp, "grew " & MoveText & " " & [WoW_Label],
        "held broadly stable " & [WoW_Label])
    VAR DriverText = SWITCH(TRUE(), NOT HasWoW, "",
        SalesDown && OrdDown && AOVDown, "driven by lower orders and ticket",
        SalesDown && OrdDown, "driven mainly by lower order volume",
        SalesDown && AOVDown, "driven mainly by a lower average ticket",
        SalesDown, "on softer trading",
        SalesUp && OrdUp && AOVUp, "on higher orders and ticket",
        SalesUp && OrdUp, "led mainly by higher order volume",
        SalesUp && AOVUp, "led mainly by a higher average ticket",
        SalesUp, "on firmer trading",
        SalesFlat && OrdUp && AOVDown, "as more orders offset a lower ticket",
        SalesFlat && OrdDown && AOVUp, "as a higher ticket offset fewer orders", "")
    VAR Gap = [Projection Gap]
    VAR ProjText = SWITCH(TRUE(), ISBLANK(Gap), "",
        Gap < 0, "; likely to miss target by " & FORMAT(ABS(Gap), "#,##0"),
        Gap > 0, "; likely to beat target by " & FORMAT(Gap, "#,##0"),
        "; on track to meet target")
    VAR Clause = IF(LEN(TrendText) > 0, TrendText & IF(LEN(DriverText) > 0, ", " & DriverText, ""), "")
    RETURN IF(ISBLANK(BrandName) || LEN(Clause) = 0, BLANK(),
        SUBSTITUTE(BrandName & " " & Clause & ProjText & ".", "  ", " "))`,

  Channel_Insight_q: `
    VAR ChName = SELECTEDVALUE('BusinessesTable'[OrdersourceName])
    VAR Threshold = 0.02
    VAR WoW = [Sales WoW %]  VAR OrdersW = [Orders WoW %]  VAR AOVW = [AOV WoW %]
    VAR HasWoW = NOT ISBLANK(WoW)  VAR HasOrd = NOT ISBLANK(OrdersW)  VAR HasAOV = NOT ISBLANK(AOVW)
    VAR SalesUp = HasWoW && WoW > Threshold  VAR SalesDown = HasWoW && WoW < -Threshold
    VAR OrdUp = HasOrd && OrdersW > Threshold  VAR OrdDown = HasOrd && OrdersW < -Threshold
    VAR AOVUp = HasAOV && AOVW > Threshold  VAR AOVDown = HasAOV && AOVW < -Threshold
    VAR MoveText = FORMAT(ABS(WoW), "0.0%")
    VAR TrendText = SWITCH(TRUE(), NOT HasWoW, "",
        SalesDown, "declined " & MoveText & " " & [WoW_Label],
        SalesUp, "grew " & MoveText & " " & [WoW_Label],
        "held broadly stable " & [WoW_Label])
    VAR DriverText = SWITCH(TRUE(), NOT HasWoW, "",
        SalesDown && OrdDown, "on lower order volume",
        SalesDown && AOVDown, "on a lower average ticket",
        SalesDown, "on softer trading",
        SalesUp && OrdUp, "on higher order volume",
        SalesUp && AOVUp, "on a higher average ticket",
        SalesUp, "on firmer trading", "")
    VAR Share = DIVIDE([TotalNetAmount], CALCULATE([TotalNetAmount], ALLSELECTED('BusinessesTable'[OrdersourceName])))
    VAR ShareText = IF(NOT ISBLANK(Share), "; now " & FORMAT(Share, "0.0%") & " of the mix", "")
    VAR Clause = IF(LEN(TrendText) > 0, TrendText & IF(LEN(DriverText) > 0, ", " & DriverText, ""), "")
    RETURN IF(ISBLANK(ChName) || LEN(Clause) = 0, BLANK(),
        SUBSTITUTE(ChName & " " & Clause & ShareText & ".", "  ", " "))`,

  Section_When_q: `
    VAR Hours = ADDCOLUMNS(VALUES('SALES DATA'[HOUR]), "N", CALCULATE(SUM('SALES DATA'[NET])))
    VAR PeakHour = MAXX(TOPN(1, Hours, [N], DESC), 'SALES DATA'[HOUR])
    VAR PeakText = IF(NOT ISBLANK(PeakHour), "Peak trading around " & FORMAT(TIME(PeakHour, 0, 0), "h AM/PM"), "")
    VAR WoW = [Sales WoW %]
    VAR TrendText = SWITCH(TRUE(), ISBLANK(WoW), "",
        WoW < -0.02, "sales down " & FORMAT(ABS(WoW), "0.0%") & " " & [WoW_Label],
        WoW > 0.02, "sales up " & FORMAT(WoW, "0.0%") & " " & [WoW_Label],
        "sales broadly flat " & [WoW_Label])
    RETURN IF(LEN(PeakText) = 0 && LEN(TrendText) = 0, BLANK(),
        SUBSTITUTE(PeakText & IF(LEN(PeakText) > 0 && LEN(TrendText) > 0, "; ", "") & TrendText & ".", "  ", " "))`,

  Section_Where_q: `
    VAR Locs = ADDCOLUMNS(VALUES('LocationMaster'[Location]),
        "N", CALCULATE(SUM('SALES DATA'[NET])), "Tgt", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])))
    VAR Ranked = FILTER(Locs, [N] > 0)
    VAR Best = MAXX(TOPN(1, Ranked, [N], DESC), 'LocationMaster'[Location])
    VAR BestN = MAXX(TOPN(1, Ranked, [N], DESC), [N])
    VAR Below = COUNTROWS(FILTER(Ranked, [Tgt] > 0 && [N] < [Tgt]))
    VAR Total = COUNTROWS(Ranked)
    RETURN IF(ISBLANK(Best), BLANK(),
        Best & " leads with KD " & FORMAT(BestN, "#,##0") &
        IF(Below > 0, "; " & Below & " of " & Total & " branches are below target", "") & ".")`,

  Section_How_q: `
    VAR Chans = ADDCOLUMNS(VALUES('BusinessesTable'[OrdersourceName]),
        "N", CALCULATE(SUM('SALES DATA'[NET])), "WoW", [Sales WoW %])
    VAR Ranked = FILTER(Chans, [N] > 0)
    VAR TopName = MAXX(TOPN(1, Ranked, [N], DESC), 'BusinessesTable'[OrdersourceName])
    VAR TopShare = DIVIDE(MAXX(TOPN(1, Ranked, [N], DESC), [N]), SUMX(Ranked, [N]))
    VAR Risers = FILTER(Ranked, NOT ISBLANK([WoW]))
    VAR RName = MAXX(TOPN(1, Risers, [WoW], DESC), 'BusinessesTable'[OrdersourceName])
    VAR RWoW = MAXX(TOPN(1, Risers, [WoW], DESC), [WoW])
    VAR RiserText = IF(NOT ISBLANK(RName) && RWoW > 0.02, "; " & RName & " growing fastest (" & FORMAT(RWoW, "+0.0%") & " " & [WoW_Label] & ")", "")
    RETURN IF(ISBLANK(TopName), BLANK(), TopName & " leads the mix at " & FORMAT(TopShare, "0%") & RiserText & ".")`,

  Section_HowMuch_q: `
    VAR AOVNow = [AOV]  VAR SalesW = [Sales WoW %]  VAR OrdersW = [Orders WoW %]  VAR AOVW = [AOV WoW %]
    VAR Driver = SWITCH(TRUE(), ISBLANK(SalesW), "",
        ABS(OrdersW) >= ABS(AOVW), "led by order volume (" & FORMAT(OrdersW, "+0.0%;-0.0%") & " orders)",
        "led by ticket size (" & FORMAT(AOVW, "+0.0%;-0.0%") & " AOV)")
    RETURN "Blended ticket KD " & FORMAT(AOVNow, "0.00") & IF(LEN(Driver) > 0, "; the period's move was " & Driver, "") & "."`,

  Story_Headline_q: `
    VAR Net = [TotalNetAmount]  VAR WoW = [Sales WoW %]  VAR Gap = [TARGETDIFF]
    VAR WoWText = IF(NOT ISBLANK(WoW), FORMAT(WoW, "+0.0%;-0.0%") & " " & [WoW_Label], "")
    VAR GapText = SWITCH(TRUE(), ISBLANK(Gap), "",
        Gap < 0, "KD " & FORMAT(ABS(Gap), "#,##0") & " short of target",
        Gap > 0, "KD " & FORMAT(Gap, "#,##0") & " ahead of target", "on target")
    RETURN IF(ISBLANK(Net), BLANK(),
        "Net sales KD " & FORMAT(Net, "#,##0") & IF(LEN(WoWText) > 0, ", " & WoWText, "") & IF(LEN(GapText) > 0, " and " & GapText, "") & ".")`,

  Story_Brand_q: `
    VAR B = ADDCOLUMNS(VALUES('Brand Table'[Brand Full Name]),
        "bNet", CALCULATE([TotalNetAmount]), "bPrev", CALCULATE([Sales_Previous_Period]),
        "bOWoW", CALCULATE([Orders WoW %]), "bAWoW", CALCULATE([AOV WoW %]))
    VAR B2 = ADDCOLUMNS(FILTER(B, NOT ISBLANK([bPrev])), "bSwing", [bNet] - [bPrev], "bAbs", ABS([bNet] - [bPrev]))
    VAR TopRow = TOPN(1, B2, [bAbs], DESC)
    VAR Nm = MAXX(TopRow, 'Brand Table'[Brand Full Name])
    VAR Swing = MAXX(TopRow, [bSwing])
    VAR OWoW = MAXX(TopRow, [bOWoW])
    VAR AWoW = MAXX(TopRow, [bAWoW])
    VAR Dir = IF(Swing < 0, "declined", "grew")
    VAR Driver = IF(ABS(OWoW) >= ABS(AWoW), "on order volume", "on average ticket")
    RETURN IF(ISBLANK(Nm), BLANK(),
        Nm & " was the standout - " & Dir & " KD " & FORMAT(ABS(Swing), "#,##0") & " " & [WoW_Label] & " " & Driver & ".")`,

  Story_Channel_q: `
    VAR C = ADDCOLUMNS(VALUES('BusinessesTable'[OrdersourceName]),
        "cNet", CALCULATE([TotalNetAmount]), "cPrev", CALCULATE([Sales_Previous_Period]))
    VAR C2 = ADDCOLUMNS(FILTER(C, NOT ISBLANK([cPrev])), "cSwing", [cNet] - [cPrev], "cAbs", ABS([cNet] - [cPrev]))
    VAR TopRow = TOPN(1, C2, [cAbs], DESC)
    VAR Nm = MAXX(TopRow, 'BusinessesTable'[OrdersourceName])
    VAR Swing = MAXX(TopRow, [cSwing])
    VAR Share = DIVIDE(MAXX(TopRow, [cNet]), SUMX(C, [cNet]))
    RETURN IF(ISBLANK(Nm), BLANK(),
        Nm & IF(Swing < 0, " slipped ", " gained ") & "KD " & FORMAT(ABS(Swing), "#,##0") & " " & [WoW_Label] & ", now " & FORMAT(Share, "0%") & " of the mix.")`,

  Story_Outlook_q: `
    VAR Gap = [Projection Gap]
    VAR Days = DATEDIFF(MIN('DATETABLE'[DATE]), MAX('DATETABLE'[DATE]), DAY) + 1
    VAR PeriodText = IF(Days <= 31, "this month", "this year")
    VAR ProjClose = IF(Days <= 31, [RUNRATE_FULL_MONTH], [Runrate_Full_Year])
    RETURN SWITCH(TRUE(), ISBLANK(Gap), BLANK(),
        Gap < 0, "At the current pace we project KD " & FORMAT(ProjClose, "#,##0") & " for " & PeriodText & ", short of target by " & FORMAT(ABS(Gap), "#,##0") & ".",
        Gap > 0, "At the current pace we project KD " & FORMAT(ProjClose, "#,##0") & " for " & PeriodText & ", ahead of target by " & FORMAT(Gap, "#,##0") & ".",
        "At the current pace we project KD " & FORMAT(ProjClose, "#,##0") & " for " & PeriodText & ", on target.")`,
};
// emit query-scoped MEASURE blocks for the requested names
const insDefs = (...names) => names.map((n) => `\n  MEASURE 'Append1'[${n}] =${INS[n]}`).join("");

// ---- role scope + cross-filters (applied live, security still enforced by RLS) --
// loc = role scope (pipe-separated locations); fb/fc/fl = clicked brand/channel/
// location cross-filters. Each becomes a filter table injected into SUMMARIZECOLUMNS
// so every measure re-evaluates in that intersection. The frontend omits a table's
// own dimension (a brand filter never collapses the Brand table, etc.).
function xf(q = {}) {
  const esc = (s) => String(s).replace(/"/g, '""');
  const vars = [], names = [];
  if (q.loc) {
    const list = String(q.loc).split("|").filter(Boolean).map((s) => `"${esc(s)}"`).join(", ");
    if (list) { vars.push(`  VAR __sLoc = FILTER(ALL('LocationMaster'[Location]), 'LocationMaster'[Location] IN {${list}})`); names.push("__sLoc"); }
  }
  if (q.fb) { vars.push(`  VAR __fB = FILTER(ALL('Brand Table'[Brand Full Name]), 'Brand Table'[Brand Full Name] = "${esc(q.fb)}")`); names.push("__fB"); }
  if (q.fc) { vars.push(`  VAR __fC = FILTER(ALL('BusinessesTable'[OrdersourceName]), 'BusinessesTable'[OrdersourceName] = "${esc(q.fc)}")`); names.push("__fC"); }
  if (q.fl) { const fls = String(q.fl).split("|").filter(Boolean).map((s) => `"${esc(s)}"`).join(", "); if (fls) { vars.push(`  VAR __fL = FILTER(ALL('LocationMaster'[Location]), 'LocationMaster'[Location] IN {${fls}})`); names.push("__fL"); } }
  if (q.fcat) { vars.push(`  VAR __fCat = FILTER(ALL('Complaints'[ComplaintCategories]), 'Complaints'[ComplaintCategories] = "${esc(q.fcat)}")`); names.push("__fCat"); }
  if (q.fpb) { vars.push(`  VAR __fPB = FILTER(ALL('TALABAT_LOGISTICS'[PrepTimeBucket]), 'TALABAT_LOGISTICS'[PrepTimeBucket] = "${esc(q.fpb)}")`); names.push("__fPB"); }
  if (q.fdb) {
    const R = { "15-20": [-1, 20], "20-25": [20, 25], "25-30": [25, 30], "30-35": [30, 35], "35-40": [35, 40], "40+": [40, 1000000] };
    const rg = R[q.fdb];
    if (rg) { vars.push(`  VAR __fDB = FILTER(ALL('TALABAT_LOGISTICS'[Actual Delivery Time]), 'TALABAT_LOGISTICS'[Actual Delivery Time] > ${rg[0]} && 'TALABAT_LOGISTICS'[Actual Delivery Time] <= ${rg[1]})`); names.push("__fDB"); }
  }
  // Page-level Operations filters — per table, multi-value (pipe-separated). Each
  // targets its OWN table's column, so it only affects measures over that table.
  //   vc/vh = Validation on Complaints / Hidden
  //   rc/rb/rh = Responsible Party on Complaints / Busy(Offline) / Hidden
  const inList = (raw) => String(raw).split("|").map((s) => s.trim()).filter(Boolean).map((s) => `"${esc(s)}"`).join(", ");
  const addFilter = (raw, varName, col) => { const l = inList(raw); if (l) { vars.push(`  VAR ${varName} = FILTER(ALL(${col}), ${col} IN {${l}})`); names.push(varName); } };
  if (q.vc) addFilter(q.vc, "__vCmp", "'Complaints'[Validation]");
  if (q.vh) addFilter(q.vh, "__vHid", "'HIDEN'[Validation]");
  if (q.rc) addFilter(q.rc, "__rCmp", "'Complaints'[Responsible Party]");
  if (q.rb) addFilter(q.rb, "__rBsy", "'BUSY TIME'[RESPONSIBLE_PARTY]");
  if (q.rh) addFilter(q.rh, "__rHid", "'HIDEN'[Responsible Party]");
  return { def: vars.length ? "\n" + vars.join("\n") : "", args: names.length ? names.join(", ") + ", " : "" };
}

// Operations "by branch" charts: group by BRAND at All-Brands, by LOCATION when a brand is scoped.
const opsDim = () => (CURRENT.brand && CURRENT.brand !== "all") ? "'LocationMaster'[Location]" : "'Brand Table'[Brand Full Name]";

// ---- PRODUCT MIX model helpers (dataset accff459…, date col is [Date]) ------
// This second semantic model uses 'DATETABLE'[Date] (not [DATE]) and has no
// Brand Table; product data lives in the LINE table. Its visuals compute their
// own date windows + adaptive WoW/MoM/YoY (frontend picks which to show).
// IMPORTANT: this model's DATETABLE is NOT related to the facts — the measures
// respond to the fact-level 'SALES DATA'[VoucherDate] (verified: it filters
// NetSales/Orders/Qty/ItemSales; DATETABLE[Date] filters nothing). So all date
// windows filter that column. `col` lets a viz use a different fact date
// (e.g. hourly uses 'HOURLY SALES'[Day]).
const pmBetween = (r, col = "'SALES DATA'[VoucherDate]") => { const s = r.start.split("-").map(Number), e = r.end.split("-").map(Number); return `${col} >= DATE(${s[0]},${s[1]},${s[2]}) && ${col} < DATE(${e[0]},${e[1]},${e[2]}) + 1`; };
function pmPeriods(range, col = "'SALES DATA'[VoucherDate]") {
  const n = dayCount(range), cal = calType(range);
  const wR = shiftRange(range, -7), mR = cal ? shiftMonthsR(range, -1) : shiftRange(range, -28), yR = (cal || n >= 30) ? shiftYearsR(range, -1) : shiftRange(range, -364);
  const mk = (nm, r) => `  VAR ${nm} = FILTER(ALL(${col}), ${pmBetween(r, col)})`;
  return { def: "\n" + [mk("__d", range), mk("__w", wR), mk("__m", mR), mk("__y", yR)].join("\n"), w: n <= 7 };
}
// current + adaptive comparison columns for one Product Mix measure (sc = page-filter args)
const pmQuad = (base, measure, w, sc = "") =>
  `\n  "${base}", CALCULATE(${measure}, __d${sc}),`
  + (w ? `\n  "${base}_w", CALCULATE(${measure}, __w${sc}),` : "")
  + `\n  "${base}_m", CALCULATE(${measure}, __m${sc}),\n  "${base}_y", CALCULATE(${measure}, __y${sc})`;
const pmQuadCols = (as) => [[as, `[${as}]`], [`${as}_w`, `[${as}_w]`], [`${as}_m`, `[${as}_m]`], [`${as}_y`, `[${as}_y]`]];
// selection filter for the item-driven visuals (frequently-bought-together,
// cross-sell/attach). Product names can contain double quotes → escape them.
const pmItemFilter = (q) => { const v = (q.pmitem || "").replace(/"/g, '""').trim(); return v ? `'Product Selector'[ProductName_Fixed_Option] = "${v}"` : null; };
// MAIN_ITEM slicer (LINE[MAIN_ITEM]); "All"/blank → no filter (overall)
const pmMainFilter = (q) => { const v = (q.pmmain || "").replace(/"/g, '""').trim(); return v && v !== "All" ? `'LINE'[MAIN_ITEM] = "${v}"` : null; };
// Page-level filter bar (Product / Category / Order Source / Location). Returns
// DEFINE VAR block + a ", __f.." argument string to append to a SUMMARIZECOLUMNS
// filter position (the inner measures inherit them). Only active filters emit.
function pmScope(q) {
  const vars = [], args = [];
  const add = (nm, col, val) => { const v = (val || "").replace(/"/g, '""').trim(); if (v && v !== "All") { vars.push(`  VAR ${nm} = FILTER(ALL(${col}), ${col} = "${v}")`); args.push(nm); } };
  add("__fprod", "'LINE'[ProductName_Fixed_Option]", q.pmprod);
  add("__fcat", "'LINE'[Category]", q.pmcat);
  // Order Source + Location filter on the ORDER-level 'SALES DATA' (not LINE / the line-fed
  // LocationMapping), reaching the product mix via the bi-directional LINE[KEY] ↔ 'SALES DATA'[KEY].
  add("__fsrc", "'SALES DATA'[OrderSource]", q.pmsrc);
  add("__floc", "'SALES DATA'[LOCATIONID]", q.pmloc);
  add("__fbrand", "'LINE'[Brand]", q.pmbrand);
  // Selling Price range (numeric) — LINE[SellingPrice]
  const lo = q.pmpmin !== undefined && q.pmpmin !== "" ? Number(q.pmpmin) : null;
  const hi = q.pmpmax !== undefined && q.pmpmax !== "" ? Number(q.pmpmax) : null;
  if ((lo != null && isFinite(lo)) || (hi != null && isFinite(hi))) {
    const cond = [lo != null ? `'LINE'[SellingPrice] >= ${lo}` : "", hi != null ? `'LINE'[SellingPrice] <= ${hi}` : ""].filter(Boolean).join(" && ");
    vars.push(`  VAR __fprice = FILTER(ALL('LINE'[SellingPrice]), ${cond})`); args.push("__fprice");
  }
  return { def: vars.length ? "\n" + vars.join("\n") : "", args: args.length ? ", " + args.join(", ") : "" };
}
// admin-managed exclusions (e.g. products the Hero list should never show)
const PM_EXCL_FILE = path.join(__dirname, "data", "pm-exclusions.json");
function loadPmExcl() { try { return JSON.parse(fs.readFileSync(PM_EXCL_FILE, "utf8")); } catch { return { hero: [] }; } }
function savePmExcl(x) { try { fs.mkdirSync(path.dirname(PM_EXCL_FILE), { recursive: true }); fs.writeFileSync(PM_EXCL_FILE, JSON.stringify(x, null, 2)); } catch {} }

// ---- LocationMaster mapping store + the source columns that join to it --------
const LOC_MAP_FILE = path.join(__dirname, "data", "location-map.json");
function loadLocMap() { try { return JSON.parse(fs.readFileSync(LOC_MAP_FILE, "utf8")); } catch { return { overrides: {}, added: [] }; } }
function saveLocMap(x) { try { fs.mkdirSync(path.dirname(LOC_MAP_FILE), { recursive: true }); fs.writeFileSync(LOC_MAP_FILE, JSON.stringify(x, null, 2)); } catch {} }
// every source column that relates to LocationMaster (by LocationID or cleaned name)
const LOC_SOURCES = [
  { key: "sales",      label: "SALES DATA",        table: "'SALES DATA'",     col: "'SALES DATA'[LOCATIONID]",          type: "id" },
  { key: "forecast",   label: "FORECAST BRANCH",   table: "'FORECAST BRANCH'", col: "'FORECAST BRANCH'[BRANCH]",         type: "id" },
  { key: "complaints", label: "Complaints",        table: "Complaints",       col: "Complaints[Branch_Clean]",          type: "name" },
  { key: "talabat",    label: "TALABAT_LOGISTICS", table: "TALABAT_LOGISTICS", col: "TALABAT_LOGISTICS[Location_Clean]", type: "name" },
  { key: "append1",    label: "Append1",           table: "Append1",          col: "Append1[Branch_Clean_Append1]",     type: "name" },
  { key: "busytime",   label: "BUSY TIME",         table: "'BUSY TIME'",      col: "'BUSY TIME'[Branch_Clean_BusyTime]", type: "name" },
  { key: "hiden",      label: "HIDEN",             table: "HIDEN",            col: "HIDEN[Branch_Clean_Hiden]",         type: "name" },
];
// normalize overrides to `${type}::${value}` keys — tolerant of older per-table keys
// (e.g. "talabat::X", "complaints::X") as well as the current "name::" / "id::" keys.
const LOC_SRC_TYPE = Object.fromEntries(LOC_SOURCES.map((s) => [s.key, s.type]));
function normalizedOverrides() {
  const s = loadLocMap();
  const out = {};
  for (const [k, id] of Object.entries(s.overrides || {})) {
    const i = k.indexOf("::"); if (i < 0) continue;
    const pfx = k.slice(0, i), val = k.slice(i + 2);
    const type = (pfx === "name" || pfx === "id") ? pfx : LOC_SRC_TYPE[pfx];
    if (!type) continue;
    out[`${type}::${val.toLowerCase()}`] = String(id);
  }
  return out;
}
// name-type aliases → a DAX bridge (canonical LocationID → raw source name) so misspelled
// branch names fold into the right location inside the app's own queries. Nothing is written
// to LocationMaster — this only translates on read, per query.
function locNameAliases() {
  return Object.entries(normalizedOverrides()).filter(([k]) => k.startsWith("name::")).map(([k, id]) => ({ raw: k.slice(6), cid: String(id) }));
}
function locBridge() {
  const a = locNameAliases();
  if (!a.length) return { def: "", active: false };
  const rows = a.map((x) => `{"${x.cid.replace(/"/g, '""')}", "${x.raw.replace(/"/g, '""')}"}`).join(", ");
  return { def: `\n  VAR __locbridge = DATATABLE("cid", STRING, "raw", STRING, {${rows}})`, active: true };
}
// wrap a name-joined measure so a location also picks up rows whose raw name aliases to it.
// `extra` = additional CALCULATE filters to preserve (e.g. a period var). Falls back to the
// plain measure at non-location grain (SELECTEDVALUE blank) and when no aliases exist.
function locFold(measureRef, sourceCol, active, extra) {
  const e = extra ? `, ${extra}` : "";
  const base = `CALCULATE(${measureRef}${e})`;
  if (!active) return base;
  // Regression-proof: keep the original value for every branch that already resolves; only when
  // it's blank (an unmatched/misspelled branch) do we pull in the rows whose raw name aliases to it.
  const orphan = `CALCULATE(${measureRef}${e}, REMOVEFILTERS('LocationMaster'), `
    + `FILTER(ALL(${sourceCol}), ${sourceCol} IN SELECTCOLUMNS(FILTER(__locbridge, [cid] = __lcid), "n", [raw])))`;
  return `(VAR __lcid = SELECTEDVALUE('LocationMaster'[LocationID]) `
    + `RETURN COALESCE(${base}, IF(ISBLANK(__lcid), BLANK(), ${orphan})))`;
}
// DAX predicate excluding a list of product names (or "" if none)
const pmExclPredicate = (list) => (list && list.length ? ` && NOT('LINE'[ProductName_Fixed_Option] IN {${list.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(", ")}})` : "");
// the immediately-preceding equal-length window (for growth %, since the model's own growth measures need its Date1/Date2 slicers)
const pmPrevFilter = (r) => `FILTER(ALL('SALES DATA'[VoucherDate]), ${pmBetween(shiftRange(r, -dayCount(r)))})`;
const pmDateFilter = (r) => `FILTER(ALL('SALES DATA'[VoucherDate]), ${pmBetween(r)})`;
// every calendar month intersecting the selected range (capped at 12), as
// { key, label, filter } for the Category × Month matrix
function pmMonths(range) {
  const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [sy, sm] = range.start.split("-").map(Number);
  const [ey, em] = range.end.split("-").map(Number);
  const out = []; let y = sy, m = sm, i = 0;
  while ((y < ey || (y === ey && m <= em)) && i < 12) {
    const lo = `DATE(${y},${m},1)`, hi = m === 12 ? `DATE(${y + 1},1,1)` : `DATE(${y},${m + 1},1)`;
    out.push({ key: `m${i}`, label: `${MN[m - 1]} ${y}`, filter: `FILTER(ALL('SALES DATA'[VoucherDate]), 'SALES DATA'[VoucherDate] >= ${lo} && 'SALES DATA'[VoucherDate] < ${hi})` });
    m++; if (m > 12) { m = 1; y++; } i++;
  }
  return out;
}

const VIZ = {
  // KPI + multi-row cards, all in one single-row query
  kpis: {
    single: true,
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS(__date, __brand,
  "TotalNetAmount", 'BUSY TIME'[TotalNetAmount],
  "Orders", 'Append1'[Count of Orders],
  "AOV", 'Append1'[AOV],
  "Discount", 'Append1'[Discount %],
  "AvgPerDaySales", 'Append1'[AveragePerDaySales],
  "AvgOrdersPerDay", 'Append1'[AvgOrdersPerDay],
  "SumNET", CALCULATE(SUM('SALES DATA'[NET])))`,
    cols: [["totalNet", "[TotalNetAmount]"], ["orders", "[Orders]"], ["aov", "[AOV]"], ["discount", "[Discount]"], ["avgPerDaySales", "[AvgPerDaySales]"], ["avgOrdersPerDay", "[AvgOrdersPerDay]"], ["sumNet", "[SumNET]"]],
  },
  // intraday curves (single day -> grouped by HOUR)
  salesByHour: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __date, __brand, "TotalNetAmount", 'BUSY TIME'[TotalNetAmount]) ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["x", "SALES DATA[HOUR]"], ["value", "[TotalNetAmount]"]],
  },
  ordersByHour: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __date, __brand, "Orders", 'Append1'[Count of Orders]) ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["x", "SALES DATA[HOUR]"], ["value", "[Orders]"]],
  },
  aovByHour: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __date, __brand, "AOV", 'Append1'[AOV]) ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["x", "SALES DATA[HOUR]"], ["value", "[AOV]"]],
  },
  // category breakdowns
  byLocation: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('LocationMaster'[Location], __date, __brand, "SumNET", CALCULATE(SUM('SALES DATA'[NET])), "Orders", 'Append1'[Count of Orders]) ORDER BY [SumNET] DESC`,
    cols: [["label", "LocationMaster[Location]"], ["value", "[SumNET]"], ["orders", "[Orders]"]],
  },
  byOrderSource: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('BusinessesTable'[OrdersourceName], __date, __brand, "SumNET", CALCULATE(SUM('SALES DATA'[NET]))) ORDER BY [SumNET] DESC`,
    cols: [["label", "BusinessesTable[OrdersourceName]"], ["value", "[SumNET]"]],
  },
  byOrderType: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('Order Type'[Description], __date, __brand, "TotalNetAmount", 'BUSY TIME'[TotalNetAmount]) ORDER BY [TotalNetAmount] DESC`,
    cols: [["label", "Order Type[Description]"], ["value", "[TotalNetAmount]"]],
  },
  ordersByBucket: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[NETSALES_BUCKET], __date, __brand, "Orders", 'Append1'[Count of Orders]) ORDER BY 'SALES DATA'[NETSALES_BUCKET]`,
    cols: [["label", "SALES DATA[NETSALES_BUCKET]"], ["value", "[Orders]"]],
  },
  // matrices (location x order source)
  matrixLocSource: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('LocationMaster'[Location], 'BusinessesTable'[OrdersourceName], __date, __brand, "TotalNetAmount", 'BUSY TIME'[TotalNetAmount], "Orders", 'Append1'[Count of Orders])`,
    cols: [["row", "LocationMaster[Location]"], ["col", "BusinessesTable[OrdersourceName]"], ["value", "[TotalNetAmount]"], ["orders", "[Orders]"]],
  },
  // hour matrices (single day -> HOUR rows). Different measures each.
  matrixSalesByHour: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], 'DATETABLE'[DayName], __date, __brand, "TotalNetAmount", 'BUSY TIME'[TotalNetAmount]) ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["row", "SALES DATA[HOUR]"], ["col", "DATETABLE[DayName]"], ["value", "[TotalNetAmount]"]],
  },
  matrixOrdersByHour: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], 'DATETABLE'[DayName], __date, __brand, "Orders", 'Append1'[Count of Orders]) ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["row", "SALES DATA[HOUR]"], ["col", "DATETABLE[DayName]"], ["value", "[Orders]"]],
  },
  matrixAvgSalesByHour: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], 'DATETABLE'[DayName], __date, __brand, "AvgPerDaySales", 'Append1'[AveragePerDaySales]) ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["row", "SALES DATA[HOUR]"], ["col", "DATETABLE[DayName]"], ["value", "[AvgPerDaySales]"]],
  },
  matrixAvgOrdersByHour: {
    dax: (f) => `DEFINE${dayFilters(f)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], 'DATETABLE'[DayName], __date, __brand, "AvgOrdersPerDay", 'Append1'[AvgOrdersPerDay]) ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["row", "SALES DATA[HOUR]"], ["col", "DATETABLE[DayName]"], ["value", "[AvgOrdersPerDay]"]],
  },

  // ---- Runrate terminal (from PowerBIPerformanceData.json) ------------------
  rr_kpis: {
    single: true,
    dax: (r, q) => { const esc = (s) => String(s).replace(/"/g, '""'); const bf = fbBrand(q.brand && q.brand !== "all" ? q.brand : ""); const fbf = bf ? `, FILTER(ALL('FORECAST BRANCH'[BRAND]), 'FORECAST BRANCH'[BRAND] = "${esc(bf)}")` : ""; return `DEFINE${dayFilters(r)}
EVALUATE SUMMARIZECOLUMNS(__date, __brand,
  "RunrateMTD", 'BUSY TIME'[RUNRATE_MTD],
  "ForecastMTD", 'BUSY TIME'[FORECAST_MTD],
  "MtdActual", 'FORECAST'[MTD Actual Sales],
  "RunrateYTD", 'BUSY TIME'[RUNRATE_YTD],
  "ForecastYTD", 'BUSY TIME'[FORECAST_YTD],
  "TotYear", 'FORECAST'[TOT YEAR],
  "ForecastGrowth", 'BUSY TIME'[FORECASTGROWTH],
  "DrrText", 'Append1'[DRRGROWTH_Text],
  "WrrText", 'Append1'[WRRGROWTH_Text],
  "RrrMTD", 'FORECAST'[RRR MTD],
  "RrrGrowth", 'Append1'[RRRGROWTH%],
  "DrrMTD", 'Append1'[RUNRATE_MTD1],
  "WrrMTD", 'Append1'[RUNRATE_MTD7],
  "Revenue", SUM('SALES DATA'[NET]),
  "Orders", 'Append1'[Count of Orders],
  "MRRsale", SUM('FORECAST'[Totalsale]),
  "MrrFB", CALCULATE(SUM('FORECAST BRANCH'[Totalsale])${fbf}))`; },
    cols: [["runrateMTD", "[RunrateMTD]"], ["forecastMTD", "[ForecastMTD]"], ["mtdActual", "[MtdActual]"], ["runrateYTD", "[RunrateYTD]"], ["forecastYTD", "[ForecastYTD]"], ["totYear", "[TotYear]"], ["forecastGrowth", "[ForecastGrowth]"], ["drrText", "[DrrText]"], ["wrrText", "[WrrText]"], ["rrrMTD", "[RrrMTD]"], ["rrrGrowth", "[RrrGrowth]"], ["drrMTD", "[DrrMTD]"], ["wrrMTD", "[WrrMTD]"], ["revenue", "[Revenue]"], ["orders", "[Orders]"], ["mrrSale", "[MRRsale]"], ["mrrFB", "[MrrFB]"]],
  },
  // Branch run-rate table — Location × revenue + growth indicators (from the RunRate page tableEx)
  rr_branch: {
    dax: (r) => `DEFINE${dayFilters(r)}
EVALUATE FILTER(SUMMARIZECOLUMNS('LocationMaster'[Location], __date, __brand,
  "Net", SUM('SALES DATA'[NET]), "Orders", 'Append1'[Count of Orders], "RrrGrowth", 'Append1'[RRRGROWTH%], "FcGrowth", 'BUSY TIME'[FORECASTGROWTH]), [Net] > 0) ORDER BY [Net] DESC`,
    cols: [["label", "LocationMaster[Location]"], ["net", "[Net]"], ["orders", "[Orders]"], ["rrrGrowth", "[RrrGrowth]"], ["fcGrowth", "[FcGrowth]"]],
  },
  // daily RUNRATE line — exact measures from the Power BI "RUNRATE" line chart:
  // Actual Sales vs Forecast vs Required Run Rate vs Totalsale vs MonthRunrate.
  rr_daily: {
    dax: (r) => `DEFINE${dayFilters(r)}
EVALUATE SUMMARIZECOLUMNS('DATETABLE'[DATE], __date, __brand,
  "Actual", CALCULATE(SUM('FORECAST'[Actual Sales])),
  "Forecast", CALCULATE(SUM('FORECAST'[Forecast])),
  "Required", CALCULATE(SUM('FORECAST'[Required Run Rate TEST])),
  "Runrate", CALCULATE(SUM('FORECAST'[MonthRunrate])),
  "Totalsale", CALCULATE(SUM('FORECAST'[Totalsale])),
  "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
  "Net", CALCULATE(SUM('SALES DATA'[NET])))
ORDER BY 'DATETABLE'[DATE]`,
    cols: [["x", "DATETABLE[DATE]"], ["actual", "[Actual]"], ["forecast", "[Forecast]"], ["required", "[Required]"], ["runrate", "[Runrate]"], ["totalsale", "[Totalsale]"], ["target", "[Target]"], ["net", "[Net]"]],
  },
  // ---- FORECAST BRANCH runrate — filterable by Brand / Order Source / Location ----
  // FORECAST BRANCH is at DATE × BRAND × BRANCH × SOURCE grain and carries its own
  // Actual Sales / Daily Target / MonthRunrate / Totalsale, so the runrate view can
  // be sliced to a single brand, channel and/or branch. Filters are plain equality
  // on the FORECAST BRANCH dimension columns.
  rr_fb_daily: {
    dax: (r, q) => {
      const esc = (s) => String(s).replace(/"/g, '""');
      const vars = [], args = [];
      const add = (nm, col, val) => { if (val) { vars.push(`  VAR ${nm} = FILTER(ALL(${col}), ${col} = "${esc(val)}")`); args.push(nm); } };
      add("__fbrand", "'FORECAST BRANCH'[BRAND]", fbBrand(q.rrbrand));
      add("__floc", "'FORECAST BRANCH'[BRANCH]", q.rrloc);
      add("__fsrc", "'FORECAST BRANCH'[SOURCE]", q.rrsrc);
      const sc = fbScopeVar();
      const a = (args.length ? ", " + args.join(", ") : "") + sc.arg;
      return `DEFINE${dayFilters(r)}${vars.length ? "\n" + vars.join("\n") : ""}${sc.def}
EVALUATE SUMMARIZECOLUMNS('DATETABLE'[DATE], __date${a},
  "Actual", CALCULATE(SUM('FORECAST BRANCH'[Actual Sales])),
  "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
  "Runrate", CALCULATE(SUM('FORECAST BRANCH'[MonthRunrate])),
  "Totalsale", CALCULATE(SUM('FORECAST BRANCH'[Totalsale])))
ORDER BY 'DATETABLE'[DATE]`;
    },
    cols: [["x", "DATETABLE[DATE]"], ["actual", "[Actual]"], ["target", "[Target]"], ["runrate", "[Runrate]"], ["totalsale", "[Totalsale]"]],
  },
  // Headline runrate metrics — the EXACT FORECAST BRANCH columns that mirror the
  // model measures, at the filtered brand/source/location scope:
  //   MRR = SUM(Totalsale) over MTD  (same as BUSY TIME[RUNRATE_MTD])
  //   YRR = SUM(Totalsale) over the year  (same as BUSY TIME[RUNRATE_YTD])
  //   RR-MTD / Current / Month runrate, targets, and the runrate gap.
  // DRR/WRR (LAST1/LAST7-day sales) are NOT in FORECAST BRANCH, so they can't be
  // produced at brand level from this table.
  rr_fb_kpis: {
    single: true,
    dax: (r, q) => {
      const esc = (s) => String(s).replace(/"/g, '""');
      const vars = [], args = [];
      const add = (nm, col, val) => { if (val) { vars.push(`  VAR ${nm} = FILTER(ALL(${col}), ${col} = "${esc(val)}")`); args.push(nm); } };
      add("__fbrand", "'FORECAST BRANCH'[BRAND]", fbBrand(q.rrbrand));
      add("__floc", "'FORECAST BRANCH'[BRANCH]", q.rrloc);
      add("__fsrc", "'FORECAST BRANCH'[SOURCE]", q.rrsrc);
      const sc = fbScopeVar();
      const a = (args.length ? ", " + args.join(", ") : "") + sc.arg;
      const yr = Number(String(r.start).slice(0, 4)) || new Date().getFullYear();
      return `DEFINE${dayFilters(r)}
  VAR __yr = FILTER(ALL('DATETABLE'[DATE]), YEAR('DATETABLE'[DATE]) = ${yr})
  // proper YRR: actual sales for the completed months of the year + the run-rate
  // (Totalsale = actual-so-far + forecast-rest) for the current month onward.
  VAR __moStart = DATE(YEAR(TODAY()), MONTH(TODAY()), 1)
  VAR __ytdActualDates = FILTER(ALL('DATETABLE'[DATE]), YEAR('DATETABLE'[DATE]) = ${yr} && 'DATETABLE'[DATE] < __moStart)
  VAR __restDates = FILTER(ALL('DATETABLE'[DATE]), YEAR('DATETABLE'[DATE]) = ${yr} && 'DATETABLE'[DATE] >= __moStart)${vars.length ? "\n" + vars.join("\n") : ""}${sc.def}
EVALUATE SUMMARIZECOLUMNS(__date${a},
  "MRR", CALCULATE(SUM('FORECAST BRANCH'[Totalsale])),
  "RrMtd", CALCULATE(SUM('FORECAST BRANCH'[MonthlyRunRate_MTD])),
  "CurrentRR", CALCULATE(SUM('FORECAST BRANCH'[CurrentMonthRunrate])),
  "MonthRR", CALCULATE(SUM('FORECAST BRANCH'[MonthRunrate])),
  "Actual", CALCULATE(SUM('FORECAST BRANCH'[Actual Sales])),
  "MtgtCum", CALCULATE(SUM('FORECAST BRANCH'[CUMULATIVE_MONTH_TARGET])),
  "FinalTarget", CALCULATE(SUM('FORECAST BRANCH'[Final Target])),
  "DailyTarget", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
  "RunrateGap", CALCULATE(SUM('FORECAST BRANCH'[Runrate Gap])),
  "YRR", CALCULATE(SUM('FORECAST BRANCH'[Actual Sales]), __ytdActualDates) + CALCULATE(SUM('FORECAST BRANCH'[Totalsale]), __restDates),
  "TRY", CALCULATE(SUM('FORECAST BRANCH'[Final Target]), __yr))`;
    },
    cols: [["mrr", "[MRR]"], ["rrMtd", "[RrMtd]"], ["currentRR", "[CurrentRR]"], ["monthRR", "[MonthRR]"], ["actual", "[Actual]"], ["mtgtCum", "[MtgtCum]"], ["finalTarget", "[FinalTarget]"], ["dailyTarget", "[DailyTarget]"], ["runrateGap", "[RunrateGap]"], ["yrr", "[YRR]"], ["try", "[TRY]"]],
  },
  // filter option lists (from FORECAST BRANCH's own dimension columns)
  rr_fb_brands: { dax: () => `EVALUATE FILTER(VALUES('FORECAST BRANCH'[BRAND]), NOT ISBLANK('FORECAST BRANCH'[BRAND])) ORDER BY 'FORECAST BRANCH'[BRAND]`, cols: [["v", "FORECAST BRANCH[BRAND]"]] },
  rr_fb_locs: { dax: (r, q) => { const bf = fbBrand(q.rrbrand); const esc = (s) => String(s).replace(/"/g, '""'); const sc = fbScopeVar();
    const bv = bf ? `\n  VAR __fb = FILTER(ALL('FORECAST BRANCH'[BRAND]), 'FORECAST BRANCH'[BRAND] = "${esc(bf)}")` : "";
    const ba = (bf ? ", __fb" : "") + sc.arg;
    // only branches that actually TRADED in the selected period (Actual Sales > 0),
    // scoped to the selected brand (and the user's brand scope) — so no unrelated
    // / non-trading / out-of-scope branches appear.
    return `DEFINE${dayFilters(r)}${bv}${sc.def}
EVALUATE DISTINCT(SELECTCOLUMNS(FILTER(SUMMARIZECOLUMNS('FORECAST BRANCH'[BRANCH], __date${ba}, "S", CALCULATE(SUM('FORECAST BRANCH'[Actual Sales]))), [S] > 0 && NOT ISBLANK('FORECAST BRANCH'[BRANCH])), "v", 'FORECAST BRANCH'[BRANCH])) ORDER BY [v]`; },
    cols: [["v", "[v]"]] },
  rr_fb_sources: { dax: () => { const sc = fbScopeVar();
    return sc.def
      ? `DEFINE${sc.def}\nEVALUATE FILTER(VALUES('FORECAST BRANCH'[SOURCE]), NOT ISBLANK('FORECAST BRANCH'[SOURCE]) && 'FORECAST BRANCH'[SOURCE] IN CALCULATETABLE(VALUES('FORECAST BRANCH'[SOURCE])${sc.arg})) ORDER BY 'FORECAST BRANCH'[SOURCE]`
      : `EVALUATE FILTER(VALUES('FORECAST BRANCH'[SOURCE]), NOT ISBLANK('FORECAST BRANCH'[SOURCE])) ORDER BY 'FORECAST BRANCH'[SOURCE]`; }, cols: [["v", "FORECAST BRANCH[SOURCE]"]] },

  // intraday actual by hour, with last-week and last-4-week-avg overlays
  rr_intraday: {
    dax: (r) => `DEFINE${dayFilters(r)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __date, __brand,
  "SumNET", CALCULATE(SUM('SALES DATA'[NET])),
  "LastWeek", 'BUSY TIME'[Sales_ByHour_LastWeek],
  "Last4Avg", 'BUSY TIME'[Sales_ByHour_Last4Weeks_Avg])
ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["x", "SALES DATA[HOUR]"], ["value", "[SumNET]"], ["lastWeek", "[LastWeek]"], ["last4", "[Last4Avg]"]],
  },

  // ---- Landing page (from PowerBIPerformanceDataLandingpage.json) -----------
  // headline Revenue/Orders + operational KPI cards + insight narration.
  landing_kpis: {
    single: true,
    dax: (r) => `DEFINE${dayFilters(r)}
EVALUATE SUMMARIZECOLUMNS(__date, __brand,
  "Revenue", CALCULATE(SUM('SALES DATA'[NET])),
  "Orders", 'Append1'[Count of Orders],
  "AOV", 'Append1'[AOV],
  "AvgPrep", CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))),
  "AvgDelivery", 'TALABAT_LOGISTICS'[Avg Delivery Time (min)],
  "OfflineRate", 'Append1'[TotalOfflineRate],
  "Hidden", 'Append1'[Hiden],
  "AvgRating", 'Append1'[AverageRating],
  "ComplaintRatio", 'Append1'[Complaint_to_Order_Ratio],
  "Insight", 'Append1'[KPI_Insight_Final])`,
    cols: [["revenue", "[Revenue]"], ["orders", "[Orders]"], ["aov", "[AOV]"], ["avgPrep", "[AvgPrep]"], ["avgDelivery", "[AvgDelivery]"], ["offlineRate", "[OfflineRate]"], ["hidden", "[Hidden]"], ["avgRating", "[AvgRating]"], ["complaintRatio", "[ComplaintRatio]"], ["insight", "[Insight]"]],
  },
  // intraday sales by hour vs last week / 4-week average (landing combo)
  landing_hourly: {
    dax: (r) => `DEFINE${dayFilters(r)}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __date, __brand,
  "SumNET", CALCULATE(SUM('SALES DATA'[NET])),
  "LastWeek", 'BUSY TIME'[Sales_ByHour_LastWeek],
  "Last4Avg", 'BUSY TIME'[Sales_ByHour_Last4Weeks_Avg])
ORDER BY 'SALES DATA'[HOUR]`,
    cols: [["x", "SALES DATA[HOUR]"], ["value", "[SumNET]"], ["lastWeek", "[LastWeek]"], ["last4", "[Last4Avg]"]],
  },
  // landing "Brand Performance" matrix — Brand Full Name > Location.
  // ROLLUPADDISSUBTOTAL adds DAX-evaluated brand subtotals + grand total (exactly
  // like Power BI's matrix) so the text/ratio measures (Variance %, Runrate %, WoW,
  // YoY, AOV) populate at brand level instead of being summed client-side.
  landing_brand_perf: {
    dax: (r) => `DEFINE${dayFilters(r)}
  VAR __core =
    SUMMARIZECOLUMNS(
      ROLLUPADDISSUBTOTAL(
        'Brand Table'[Brand Full Name], "IsBrandTotal",
        'LocationMaster'[Location], "IsLocTotal"),
      __date, __brand,
      "SumNET", CALCULATE(SUM('SALES DATA'[NET])),
      "TRXSALES", CALCULATE(COUNTROWS('SALES DATA')),
      "DailyTarget", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
      "VarText", 'Append1'[Sales Variance % Text],
      "MonthRunrate", CALCULATE(SUM('FORECAST BRANCH'[MonthRunrate])),
      "RunrateText", 'Append1'[Runrate % Text],
      "WoWText", 'Append1'[Sales_Growth_vs_LastWeek_Text],
      "YoYText", 'Append1'[Sales_Growth_vs_SameDay_LastYear_Text],
      "AOV", 'Append1'[AOV])
  VAR __f = FILTER(__core, [IsLocTotal] = TRUE() || [SumNET] > 0)
EVALUATE __f ORDER BY [IsBrandTotal] DESC, [SumNET] DESC`,
    cols: [["brand", "Brand Table[Brand Full Name]"], ["location", "LocationMaster[Location]"], ["isGroupTotal", "[IsLocTotal]"], ["isGrandTotal", "[IsBrandTotal]"], ["netSales", "[SumNET]"], ["trx", "[TRXSALES]"], ["dailyTarget", "[DailyTarget]"], ["varianceText", "[VarText]"], ["runrate", "[MonthRunrate]"], ["runrateText", "[RunrateText]"], ["growthWoWText", "[WoWText]"], ["growthYoYText", "[YoYText]"], ["aov", "[AOV]"]],
  },
  // landing "Source Performance" matrix — Order Source > Location (same rollup pattern)
  landing_source_perf: {
    dax: (r) => `DEFINE${dayFilters(r)}
  VAR __core =
    SUMMARIZECOLUMNS(
      ROLLUPADDISSUBTOTAL(
        'BusinessesTable'[OrdersourceName], "IsSourceTotal",
        'LocationMaster'[Location], "IsLocTotal"),
      __date, __brand,
      "SumNET", CALCULATE(SUM('SALES DATA'[NET])),
      "TRXSALES", CALCULATE(COUNTROWS('SALES DATA')),
      "DailyTarget", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
      "VarText", 'Append1'[Sales Variance % Text],
      "MonthRunrate", CALCULATE(SUM('FORECAST BRANCH'[MonthRunrate])),
      "RunrateText", 'Append1'[Runrate % Text],
      "WoWText", 'Append1'[Sales_Growth_vs_LastWeek_Text],
      "YoYText", 'Append1'[Sales_Growth_vs_SameDay_LastYear_Text],
      "AOV", 'Append1'[AOV])
  VAR __f = FILTER(__core, [IsLocTotal] = TRUE() || [SumNET] > 0)
EVALUATE __f ORDER BY [IsSourceTotal] DESC, [SumNET] DESC`,
    cols: [["source", "BusinessesTable[OrdersourceName]"], ["location", "LocationMaster[Location]"], ["isGroupTotal", "[IsLocTotal]"], ["isGrandTotal", "[IsSourceTotal]"], ["netSales", "[SumNET]"], ["trx", "[TRXSALES]"], ["dailyTarget", "[DailyTarget]"], ["varianceText", "[VarText]"], ["runrate", "[MonthRunrate]"], ["runrateText", "[RunrateText]"], ["growthWoWText", "[WoWText]"], ["growthYoYText", "[YoYText]"], ["aov", "[AOV]"]],
  },

  // ---- Landing "command center" (redesign) ---------------------------------
  // Top headline strip: Net Sales, Gap to Target (KD + %), Orders, AOV,
  // Forecast Closing + achievement gauge (achievement = NetSales / Target).
  // Sales KPIs carry WoW/MoM/YoY (weekday-aligned -7/-28/-364d) comparisons.
  landing_head: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS(__brand, ${x.args}${quad("NetSales", "SUM('SALES DATA'[NET])")},${quad("Orders", "'Append1'[Count of Orders]")},${quad("AOV", "'Append1'[AOV]")},${quad("ForecastClosing", "'Append1'[RUNRATE_FULL_MONTH]")},
  "Target", CALCULATE('Append1'[TARGETS_RR], __cur),
  "GapKD", CALCULATE('Append1'[TARGETDIFF], __cur),
  "GapText", CALCULATE('Append1'[TargetDiff % Text], __cur),
  "RunrateText", CALCULATE('Append1'[Runrate % Text], __cur),
  "Insight", CALCULATE('Append1'[KPI_Insight_Final], __cur))`; },
    cols: [...quadCols("netSales", "NetSales"), ...quadCols("orders", "Orders"), ...quadCols("aov", "AOV"), ...quadCols("forecastClosing", "ForecastClosing"), ["target", "[Target]"], ["gapKD", "[GapKD]"], ["gapText", "[GapText]"], ["runrateText", "[RunrateText]"], ["insight", "[Insight]"]],
  },
  // MTD / QTD / YTD achievement — actual-to-date AND projected (actual + forecast)
  // against target. Anchored to the end of the selected range, so it reads "as of"
  // that date. Actual = SALES DATA[NET]; target = FORECAST[D.TARGET]; the projected
  // close = FORECAST[Totalsale] (blended actual+forecast) over the full period.
  landing_achievement: {
    single: true,
    // Only MTD (landing gauge + MTD Sales) and month (narration close) are consumed;
    // QTD/YTD were dropped from the UI, so we no longer compute them (was 12 measures
    // over 6 date windows -> 4 over 2). Same values, far less scan work.
    dax: (r) => `DEFINE${dayFilters(r)}
  VAR __ref = MAXX(__date, 'DATETABLE'[DATE])
  VAR __y = YEAR(__ref)
  VAR __mo = MONTH(__ref)
  VAR __mtd     = FILTER(ALL('DATETABLE'[DATE]), YEAR('DATETABLE'[DATE]) = __y && MONTH('DATETABLE'[DATE]) = __mo && 'DATETABLE'[DATE] <= __ref)
  VAR __month   = FILTER(ALL('DATETABLE'[DATE]), YEAR('DATETABLE'[DATE]) = __y && MONTH('DATETABLE'[DATE]) = __mo)
EVALUATE ROW(
  "mtdSales",       CALCULATE(SUM('SALES DATA'[NET]), __mtd, __brand),
  "mtdTarget",      CALCULATE(SUM('FORECAST'[D.TARGET]), __mtd, __brand),
  "monthTarget",    CALCULATE(SUM('FORECAST'[D.TARGET]), __month, __brand),
  "monthForecast",  CALCULATE(SUM('FORECAST'[Totalsale]), __month, __brand))`,
    cols: [["mtdSales", "[mtdSales]"], ["mtdTarget", "[mtdTarget]"], ["monthTarget", "[monthTarget]"], ["monthForecast", "[monthForecast]"]],
  },
  // Operations KPIs (all lower-is-better here) with WoW/MoM/YoY comparisons.
  landing_ops: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS(__brand, ${x.args}${quad("Prep", "CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30)))")},${quad("Delivery", "'TALABAT_LOGISTICS'[Avg Delivery Time (min)]")},${quad("Complaint", "'Append1'[Complaint_to_Order_Ratio]")},${quad("Rating", "'Append1'[AverageRating]")},${quad("Offline", "'Append1'[TotalOfflineRate]")},${quad("Discount", "'Append1'[Discount %]")})`; },
    cols: [...quadCols("prep", "Prep"), ...quadCols("delivery", "Delivery"), ...quadCols("complaint", "Complaint"), ...quadCols("rating", "Rating"), ...quadCols("offline", "Offline"), ...quadCols("discount", "Discount")],
  },
  // Operations per BRANCH — the four ops KPIs at Location grain (worst-branch view).
  landing_ops_branches: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS('LocationMaster'[Location], __brand, ${x.args}
    "Prep", CALCULATE(CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))), __cur),
    "Prep_W", CALCULATE(CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))), __w),
    "Delivery", CALCULATE('TALABAT_LOGISTICS'[Avg Delivery Time (min)], __cur),
    "Delivery_W", CALCULATE('TALABAT_LOGISTICS'[Avg Delivery Time (min)], __w),
    "Complaint", CALCULATE('Append1'[Complaint_to_Order_Ratio], __cur),
    "Complaint_W", CALCULATE('Append1'[Complaint_to_Order_Ratio], __w),
    "Discount", CALCULATE('Append1'[Discount %], __cur),
    "Discount_W", CALCULATE('Append1'[Discount %], __w),
    "Rating", CALCULATE('Append1'[AverageRating], __cur),
    "Orders", CALCULATE('Append1'[Count of Orders], __cur),
    "Net", CALCULATE(SUM('SALES DATA'[NET]), __cur))
  VAR __f = FILTER(__core, [Net] > 0)
EVALUATE __f ORDER BY [Net] DESC`; },
    cols: [["label", "LocationMaster[Location]"], ["prep", "[Prep]"], ["prep_w", "[Prep_W]"], ["delivery", "[Delivery]"], ["delivery_w", "[Delivery_W]"], ["complaint", "[Complaint]"], ["complaint_w", "[Complaint_W]"], ["discount", "[Discount]"], ["discount_w", "[Discount_W]"], ["rating", "[Rating]"], ["orders", "[Orders]"], ["net", "[Net]"]],
  },
  // Operational Performance MATRIX (Area Manager) — Brand > Location, same shape as the
  // CEO Brand Performance matrix so it renders with identical column widths/styling.
  landing_ops_matrix: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(
    ROLLUPADDISSUBTOTAL('Brand Table'[Brand Full Name], "IsBrandTotal", 'LocationMaster'[Location], "IsLocTotal"),
    __brand, ${x.args}
    "Prep", CALCULATE(CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))), __cur),
    "Prep_W", CALCULATE(CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))), __w),
    "Delivery", CALCULATE('TALABAT_LOGISTICS'[Avg Delivery Time (min)], __cur),
    "Complaint", CALCULATE('Append1'[Complaint_to_Order_Ratio], __cur),
    "Rating", CALCULATE('Append1'[AverageRating], __cur),
    "Orders", CALCULATE('Append1'[Count of Orders], __cur),
    "Net", CALCULATE(SUM('SALES DATA'[NET]), __cur))
  VAR __f = FILTER(__core, [IsLocTotal] = TRUE() || [Net] > 0)
EVALUATE __f ORDER BY [IsBrandTotal] DESC, [Prep] DESC`; },
    cols: [["brand", "Brand Table[Brand Full Name]"], ["location", "LocationMaster[Location]"], ["isGroupTotal", "[IsLocTotal]"], ["isGrandTotal", "[IsBrandTotal]"], ["prep", "[Prep]"], ["prep_w", "[Prep_W]"], ["delivery", "[Delivery]"], ["complaint", "[Complaint]"], ["rating", "[Rating]"], ["orders", "[Orders]"]],
  },
  // Brand Performance table — one row per brand (dense, sortable, exportable).
  // WoW inline; MoM/YoY via net_m/net_y for the row hover/drill-down.
  landing_brand_table: {
    dax: (r) => `DEFINE${periodVars(r)}
  VAR __core = SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], __brand,${quad("Net", "SUM('SALES DATA'[NET])")},
    "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target]), __cur),
    "GapText", CALCULATE('Append1'[Sales Variance % Text], __cur),
    "RunrateText", CALCULATE('Append1'[Runrate % Text], __cur),
    "Orders", CALCULATE('Append1'[Count of Orders], __cur),
    "AOV", CALCULATE('Append1'[AOV], __cur))
  VAR __f = FILTER(__core, [Net] > 0)
EVALUATE __f ORDER BY [Net] DESC`,
    cols: [["brand", "Brand Table[Brand Full Name]"], ...quadCols("netSales", "Net"), ["target", "[Target]"], ["gapText", "[GapText]"], ["runrateText", "[RunrateText]"], ["orders", "[Orders]"], ["aov", "[AOV]"]],
  },
  // Channel / Order Source — ranked list with share + WoW/MoM/YoY
  landing_channels: {
    dax: (r) => `DEFINE${periodVars(r)}
  VAR __core = SUMMARIZECOLUMNS('BusinessesTable'[OrdersourceName], __brand,${quad("Net", "SUM('SALES DATA'[NET])")})
  VAR __f = FILTER(__core, [Net] > 0)
EVALUATE __f ORDER BY [Net] DESC`,
    cols: [["label", "BusinessesTable[OrdersourceName]"], ...quadCols("value", "Net")],
  },
  // Location / Branch — net vs Daily Target (achievement client-side) + WoW/MoM/YoY
  landing_branches: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS('LocationMaster'[Location], __brand, ${x.args}${quad("Net", "SUM('SALES DATA'[NET])")},
    "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target]), __cur))
  VAR __f = FILTER(__core, [Net] > 0)
EVALUATE __f ORDER BY [Net] DESC`; },
    cols: [["label", "LocationMaster[Location]"], ...quadCols("value", "Net"), ["target", "[Target]"]],
  },
  // Brand Performance MATRIX — Brand Full Name > Location, drill-down + WoW/MoM/YoY
  landing_brand_matrix: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${insDefs("Brand_Insight_q")}${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(
    ROLLUPADDISSUBTOTAL('Brand Table'[Brand Full Name], "IsBrandTotal", 'LocationMaster'[Location], "IsLocTotal"),
    __brand, ${x.args}${quad("Net", "SUM('SALES DATA'[NET])")},
    "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target]), __cur),
    "GapText", CALCULATE('Append1'[Sales Variance % Text], __cur),
    "RunrateText", CALCULATE('Append1'[Runrate % Text], __cur),${quad("Orders", "'Append1'[Count of Orders]")},
    "AOV", CALCULATE('Append1'[AOV], __cur),
    "Insight", CALCULATE([Brand_Insight_q], __cur))
  VAR __f = FILTER(__core, [IsLocTotal] = TRUE() || [Net] > 0)
EVALUATE __f ORDER BY [IsBrandTotal] DESC, [Net] DESC`; },
    cols: [["brand", "Brand Table[Brand Full Name]"], ["location", "LocationMaster[Location]"], ["isGroupTotal", "[IsLocTotal]"], ["isGrandTotal", "[IsBrandTotal]"], ...quadCols("netSales", "Net"), ["target", "[Target]"], ["gapText", "[GapText]"], ["runrateText", "[RunrateText]"], ...quadCols("orders", "Orders"), ["aov", "[AOV]"], ["insight", "[Insight]"]],
  },
  // Channel Performance MATRIX — Order Source > Location, drill-down + WoW/MoM/YoY
  landing_channel_matrix: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${insDefs("Channel_Insight_q")}${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(
    ROLLUPADDISSUBTOTAL('BusinessesTable'[OrdersourceName], "IsSrcTotal", 'LocationMaster'[Location], "IsLocTotal"),
    __brand, ${x.args}${quad("Net", "SUM('SALES DATA'[NET])")},
    "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target]), __cur),
    "GapText", CALCULATE('Append1'[Sales Variance % Text], __cur),
    "RunrateText", CALCULATE('Append1'[Runrate % Text], __cur),${quad("Orders", "'Append1'[Count of Orders]")},
    "AOV", CALCULATE('Append1'[AOV], __cur),
    "Insight", CALCULATE([Channel_Insight_q], __cur))
  VAR __f = FILTER(__core, [IsLocTotal] = TRUE() || [Net] > 0)
EVALUATE __f ORDER BY [IsSrcTotal] DESC, [Net] DESC`; },
    cols: [["source", "BusinessesTable[OrdersourceName]"], ["location", "LocationMaster[Location]"], ["isGroupTotal", "[IsLocTotal]"], ["isGrandTotal", "[IsSrcTotal]"], ...quadCols("netSales", "Net"), ["target", "[Target]"], ["gapText", "[GapText]"], ["runrateText", "[RunrateText]"], ...quadCols("orders", "Orders"), ["aov", "[AOV]"], ["insight", "[Insight]"]],
  },
  // Branch Performance MATRIX (Area Manager) — Location > Channel drill-down, full columns.
  landing_branch_matrix: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(
    ROLLUPADDISSUBTOTAL('LocationMaster'[Location], "IsBranchTotal", 'BusinessesTable'[OrdersourceName], "IsChanTotal"),
    __brand, ${x.args}${quad("Net", "SUM('SALES DATA'[NET])")},
    "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target]), __cur),
    "GapText", CALCULATE('Append1'[Sales Variance % Text], __cur),
    "RunrateText", CALCULATE('Append1'[Runrate % Text], __cur),
    "Orders", CALCULATE('Append1'[Count of Orders], __cur),
    "AOV", CALCULATE('Append1'[AOV], __cur))
  VAR __f = FILTER(__core, [IsChanTotal] = TRUE() || [Net] > 0)
EVALUATE __f ORDER BY [IsBranchTotal] DESC, [Net] DESC`; },
    cols: [["location", "LocationMaster[Location]"], ["source", "BusinessesTable[OrdersourceName]"], ["isGroupTotal", "[IsChanTotal]"], ["isGrandTotal", "[IsBranchTotal]"], ...quadCols("netSales", "Net"), ["target", "[Target]"], ["gapText", "[GapText]"], ["runrateText", "[RunrateText]"], ["orders", "[Orders]"], ["aov", "[AOV]"]],
  },
  // Landing "Story" briefing — 3-4 DAX-generated sentences for the selected period.
  landing_story: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${insDefs("Story_Headline_q", "Story_Brand_q", "Story_Channel_q", "Story_Outlook_q")}${periodVars(r)}${x.def}
EVALUATE ROW(
  "Headline", CALCULATE([Story_Headline_q], __cur, __brand),
  "Brand", CALCULATE([Story_Brand_q], __cur, __brand),
  "Channel", CALCULATE([Story_Channel_q], __cur, __brand),
  "Outlook", CALCULATE([Story_Outlook_q], __cur, __brand))`; },
    cols: [["headline", "[Headline]"], ["brand", "[Brand]"], ["channel", "[Channel]"], ["outlook", "[Outlook]"]],
  },
  // Landing hourly sales — net by hour + the 4-week typical hour average (comparison baseline).
  landing_hourly: {
    // Ships BOTH metrics (sales value + order count) with ALL THREE benchmarks each,
    // so the client's metric + benchmark toggles switch with no refetch.
    // Order benchmarks replicate the Sales_ByHour_* measures' DATEADD logic on
    // COUNTROWS('SALES DATA') (1 row = 1 order), since no order-count measure exists.
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __date, __brand, ${x.args}
  "Net", CALCULATE(SUM('SALES DATA'[NET])),
  "Yesterday", 'BUSY TIME'[Sales_ByHour_LastDay],
  "LastWeek", 'BUSY TIME'[Sales_ByHour_LastWeek],
  "Last4Avg", 'BUSY TIME'[Sales_ByHour_Last4Weeks_Avg],
  "Ord", CALCULATE(COUNTROWS('SALES DATA')),
  "OrdYesterday", CALCULATE(COUNTROWS('SALES DATA'), DATEADD('DateTable'[Date], -1, DAY)),
  "OrdLastWeek", CALCULATE(COUNTROWS('SALES DATA'), DATEADD('DateTable'[Date], -7, DAY)),
  "OrdLast4Avg", AVERAGEX({-7, -14, -21, -28}, CALCULATE(COUNTROWS('SALES DATA'), DATEADD('DateTable'[Date], [Value], DAY))))
ORDER BY 'SALES DATA'[HOUR]`; },
    cols: [["x", "SALES DATA[HOUR]"], ["value", "[Net]"], ["yesterday", "[Yesterday]"], ["lastWeek", "[LastWeek]"], ["last4", "[Last4Avg]"],
      ["orders", "[Ord]"], ["ordYesterday", "[OrdYesterday]"], ["ordLastWeek", "[OrdLastWeek]"], ["ordLast4", "[OrdLast4Avg]"]],
  },
  // Hourly drill-down — for ONE hour (q.hr), what drove the gain/drop, by Location or Order Source
  // (q.hdim). Returns the metric for that hour + the item's benchmark, ranked by |delta|.
  // q.hbench = "yesterday" | "lastweek" | else 4-week avg. q.hmetric = "orders" | else sales.
  landing_hourly_drill: {
    dax: (r, q) => {
      const x = xf(q); const hr = Number(q.hr) || 0;
      const dim = q.hdim === "src" ? "'BusinessesTable'[OrdersourceName]" : "'LocationMaster'[Location]";
      const orders = q.hmetric === "orders";
      const valExpr = orders ? "CALCULATE(COUNTROWS('SALES DATA'))" : "CALCULATE(SUM('SALES DATA'[NET]))";
      // sales benchmarks are model measures; order benchmarks replicate their DATEADD logic on COUNTROWS
      const benchExpr = orders
        ? (q.hbench === "yesterday" ? "CALCULATE(COUNTROWS('SALES DATA'), DATEADD('DateTable'[Date], -1, DAY))"
          : q.hbench === "lastweek" ? "CALCULATE(COUNTROWS('SALES DATA'), DATEADD('DateTable'[Date], -7, DAY))"
          : "AVERAGEX({-7, -14, -21, -28}, CALCULATE(COUNTROWS('SALES DATA'), DATEADD('DateTable'[Date], [Value], DAY)))")
        : (q.hbench === "yesterday" ? "CALCULATE('BUSY TIME'[Sales_ByHour_LastDay])"
          : q.hbench === "lastweek" ? "CALCULATE('BUSY TIME'[Sales_ByHour_LastWeek])"
          : "CALCULATE('BUSY TIME'[Sales_ByHour_Last4Weeks_Avg])");
      return `DEFINE${dayFilters(r)}${x.def}
  VAR __t = FILTER(SUMMARIZECOLUMNS(${dim}, __date, __brand, ${x.args}FILTER(ALL('SALES DATA'[HOUR]), 'SALES DATA'[HOUR] = ${hr}),
    "Net", ${valExpr},
    "Avg", ${benchExpr}), [Net] > 0 || [Avg] > 0)
EVALUATE TOPN(12, SELECTCOLUMNS(__t, "label", ${dim}, "net", [Net], "avg", [Avg]), ABS([net] - [avg]), DESC)
ORDER BY [net] DESC`;
    },
    cols: [["label", "[label]"], ["net", "[net]"], ["avg", "[avg]"]],
  },
  // Sales Analysis section takeaways — one DAX sentence per section (period-adaptive).
  ov_sections: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${insDefs("Section_When_q", "Section_Where_q", "Section_How_q", "Section_HowMuch_q")}${periodVars(r)}${x.def}
EVALUATE ROW(
  "WhenT", CALCULATE([Section_When_q], __cur, __brand),
  "WhereT", CALCULATE([Section_Where_q], __cur, __brand),
  "HowT", CALCULATE([Section_How_q], __cur, __brand),
  "HowMuchT", CALCULATE([Section_HowMuch_q], __cur, __brand))`; },
    cols: [["when", "[WhenT]"], ["where", "[WhereT]"], ["how", "[HowT]"], ["howmuch", "[HowMuchT]"]],
  },

  // ================= SALES ANALYSIS (Overview rebuild) — Section 1: WHEN ======
  // Hourly curve + overlays (DAY mode hero). No true hourly forecast exists in the
  // model, so overlays are same-weekday-last-week and the 4-week typical profile.
  ov_hourly: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __date, __brand, ${x.args}
  "Net", CALCULATE(SUM('SALES DATA'[NET])),
  "LastWeek", 'BUSY TIME'[Sales_ByHour_LastWeek],
  "Last4Avg", 'BUSY TIME'[Sales_ByHour_Last4Weeks_Avg])
ORDER BY 'SALES DATA'[HOUR]`; },
    cols: [["x", "SALES DATA[HOUR]"], ["value", "[Net]"], ["lastWeek", "[LastWeek]"], ["last4", "[Last4Avg]"]],
  },
  // Average-day profile: current-period hourly totals + previous equal-length period
  // (the "ghost"). Client divides by day count to get the typical hourly shape.
  ov_profile: {
    dax: (r, q) => { const x = xf(q); const pr = shiftRange(r, -dayCount(r)); return `DEFINE${periodVars(r)}${x.def}
  VAR __prev = FILTER(ALL('DATETABLE'[DATE]), ${betweenBody(pr)})
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], __brand, ${x.args}
  "NetCur", CALCULATE(SUM('SALES DATA'[NET]), __cur),
  "NetPrev", CALCULATE(SUM('SALES DATA'[NET]), __prev))
ORDER BY 'SALES DATA'[HOUR]`; },
    cols: [["x", "SALES DATA[HOUR]"], ["cur", "[NetCur]"], ["prev", "[NetPrev]"]],
  },
  // Daily series — net, target, orders (drives daily trend, 7-day MA, cumulative pace).
  ov_daily: {
    // Per-day overlays via DATEADD on the row's own date: same day last week (-7),
    // same day last month (-28, weekday-aligned), and the 4-weekday average.
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('DATETABLE'[DATE], __date, __brand, ${x.args}
  "Net", CALCULATE(SUM('SALES DATA'[NET])),
  "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target])),
  "Orders", 'Append1'[Count of Orders],
  "NetLW", CALCULATE(SUM('SALES DATA'[NET]), DATEADD('DATETABLE'[DATE], -7, DAY)),
  "NetLM", CALCULATE(SUM('SALES DATA'[NET]), DATEADD('DATETABLE'[DATE], -28, DAY)),
  "Net4WD", AVERAGEX({-7, -14, -21, -28}, CALCULATE(SUM('SALES DATA'[NET]), DATEADD('DATETABLE'[DATE], [Value], DAY))))
ORDER BY 'DATETABLE'[DATE]`; },
    cols: [["x", "DATETABLE[DATE]"], ["net", "[Net]"], ["target", "[Target]"], ["orders", "[Orders]"], ["lw", "[NetLW]"], ["lm", "[NetLM]"], ["avg4", "[Net4WD]"]],
  },
  // Section 2: WHERE — per-branch net, WoW, target, orders, AOV (ranked table + treemap + scatter)
  ov_branches: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], 'LocationMaster'[Location], __brand, ${x.args}
    "Net", CALCULATE(SUM('SALES DATA'[NET]), __cur),
    "Net_W", CALCULATE(SUM('SALES DATA'[NET]), __w),
    "Net_M", CALCULATE(SUM('SALES DATA'[NET]), __m),
    "Net_Y", CALCULATE(SUM('SALES DATA'[NET]), __y),
    "Target", CALCULATE(SUM('FORECAST BRANCH'[Daily Target]), __cur),
    "Orders", CALCULATE('Append1'[Count of Orders], __cur),
    "Orders_W", CALCULATE('Append1'[Count of Orders], __w),
    "Orders_M", CALCULATE('Append1'[Count of Orders], __m),
    "Orders_Y", CALCULATE('Append1'[Count of Orders], __y),
    "AOV", CALCULATE('Append1'[AOV], __cur))
  VAR __f = FILTER(__core, [Net] > 0)
EVALUATE __f ORDER BY [Net] DESC`; },
    cols: [["brand", "Brand Table[Brand Full Name]"], ["label", "LocationMaster[Location]"], ["net", "[Net]"], ["net_w", "[Net_W]"], ["net_m", "[Net_M]"], ["net_y", "[Net_Y]"], ["target", "[Target]"], ["orders", "[Orders]"], ["orders_w", "[Orders_W]"], ["orders_m", "[Orders_M]"], ["orders_y", "[Orders_Y]"], ["aov", "[AOV]"]],
  },
  // Hour x weekday heatmap (peak windows).
  ov_heatmap: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], 'DATETABLE'[DayName], 'DATETABLE'[WeekdayNo], __date, __brand, ${x.args}
  "Net", CALCULATE(SUM('SALES DATA'[NET])))
ORDER BY 'DATETABLE'[WeekdayNo], 'SALES DATA'[HOUR]`; },
    cols: [["row", "SALES DATA[HOUR]"], ["col", "DATETABLE[DayName]"], ["wd", "DATETABLE[WeekdayNo]"], ["value", "[Net]"]],
  },

  // Location × Day-of-week matrix — sales + orders per branch per weekday, for
  // operational planning (which stores are busy on which days). AOV is derived
  // client-side (sales/orders). WeekdayNo sorts Sun→Sat.
  ov_loc_day: {
    dax: (r, q) => { const x = xf(q); const d = opsDim(); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(${d}, 'DATETABLE'[DayName], 'DATETABLE'[WeekdayNo], __date, __brand, ${x.args}
    "Net", CALCULATE(SUM('SALES DATA'[NET])),
    "Orders", CALCULATE(COUNTROWS('SALES DATA')))
EVALUATE SELECTCOLUMNS(__core, "Loc", ${d}, "day", 'DATETABLE'[DayName], "wd", 'DATETABLE'[WeekdayNo], "Net", [Net], "Orders", [Orders]) ORDER BY [Loc], [wd]`; },
    cols: [["loc", "[Loc]"], ["day", "[day]"], ["wd", "[wd]"], ["sales", "[Net]"], ["orders", "[Orders]"]],
  },
  // Location × Hour — the day-mode twin of ov_loc_day. On a single day the weekday
  // column is meaningless (everything is one weekday), so we break the day down by
  // trading hour instead: which branch is busy at which hour.
  ov_loc_hour: {
    // Dimension adapts: BRAND when all-brands is selected (no single branch is meaningful),
    // LOCATION when one brand is scoped. Aliased to a fixed "Loc" column either way.
    dax: (r, q) => { const x = xf(q); const d = opsDim(); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(${d}, 'SALES DATA'[HOUR], __date, __brand, ${x.args}
    "Net", CALCULATE(SUM('SALES DATA'[NET])),
    "Orders", CALCULATE(COUNTROWS('SALES DATA')))
EVALUATE SELECTCOLUMNS(__core, "Loc", ${d}, "hour", 'SALES DATA'[HOUR], "Net", [Net], "Orders", [Orders]) ORDER BY [Loc], [hour]`; },
    cols: [["loc", "[Loc]"], ["hour", "[hour]"], ["sales", "[Net]"], ["orders", "[Orders]"]],
  },
  // Order Source × Hour — channel demand curve for staffing/kitchen planning:
  // which order source peaks at which hour (delivery vs walk-in vs aggregator).
  ov_src_hour: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('BusinessesTable'[OrdersourceName], 'SALES DATA'[HOUR], __date, __brand, ${x.args}
  "Net", CALCULATE(SUM('SALES DATA'[NET])),
  "Orders", CALCULATE(COUNTROWS('SALES DATA'))), NOT ISBLANK([Net]))
ORDER BY 'BusinessesTable'[OrdersourceName], 'SALES DATA'[HOUR]`; },
    cols: [["src", "BusinessesTable[OrdersourceName]"], ["hour", "SALES DATA[HOUR]"], ["sales", "[Net]"], ["orders", "[Orders]"]],
  },

  // ================= COMPARE PAGE — two arbitrary date ranges =================
  // Takes TWO explicit ranges (aStart/aEnd vs bStart/bEnd) instead of the global
  // date picker, and breaks both down by one dimension. The dimension column is
  // aliased to "label" via SELECTCOLUMNS so the cols map stays fixed as q.dim varies.
  cmp_two: {
    dax: (r, q) => {
      const DIMS = {
        location: "'LocationMaster'[Location]",
        source: "'BusinessesTable'[OrdersourceName]",
        day: "'DATETABLE'[DayName]",
        brand: "'Brand Table'[Brand Full Name]",
      };
      const dim = DIMS[q.dim] || DIMS.location;
      const isDay = (q.dim || "") === "day";
      const win = (s, e) => { const a = s.split("-").map(Number), b = addDays(e, 1).split("-").map(Number);
        return `FILTER(ALL('DATETABLE'[DATE]), 'DATETABLE'[DATE] >= DATE(${a[0]},${a[1]},${a[2]}) && 'DATETABLE'[DATE] < DATE(${b[0]},${b[1]},${b[2]}))`; };
      // §6 same-hour cutoff: when Period A ends on a partial day, restrict BOTH
      // periods to the same hours so a part-day is never scored against a full one.
      const cut = Number(q.cutHour);
      const hourCut = isFinite(cut) && cut >= 0 && cut < 24
        ? `\n  VAR __hr = FILTER(ALL('SALES DATA'[HOUR]), 'SALES DATA'[HOUR] <= ${Math.floor(cut)})` : "";
      const hc = hourCut ? ", KEEPFILTERS(__hr)" : "";
      return `DEFINE
  VAR __a = ${win(q.aStart, q.aEnd)}
  VAR __b = ${win(q.bStart, q.bEnd)}${hourCut}
  VAR __brand = ${brandFilterVar()}
  VAR __t = SUMMARIZECOLUMNS(${dim}${isDay ? ", 'DATETABLE'[WeekdayNo]" : ""}, __brand,
    "aSales", CALCULATE(SUM('SALES DATA'[NET]), KEEPFILTERS(__a)${hc}),
    "aOrders", CALCULATE(COUNTROWS('SALES DATA'), KEEPFILTERS(__a)${hc}),
    "bSales", CALCULATE(SUM('SALES DATA'[NET]), KEEPFILTERS(__b)${hc}),
    "bOrders", CALCULATE(COUNTROWS('SALES DATA'), KEEPFILTERS(__b)${hc}))
  VAR __f = FILTER(__t, NOT ISBLANK([aSales]) || NOT ISBLANK([bSales]))
EVALUATE SELECTCOLUMNS(__f, "label", ${dim}, "wd", ${isDay ? "'DATETABLE'[WeekdayNo]" : "0"},
  "aSales", [aSales], "aOrders", [aOrders], "bSales", [bSales], "bOrders", [bOrders])`;
    },
    cols: [["label", "[label]"], ["wd", "[wd]"], ["aSales", "[aSales]"], ["aOrders", "[aOrders]"], ["bSales", "[bSales]"], ["bOrders", "[bOrders]"]],
  },
  // Daily series for ONE arbitrary range (the page calls it once per period and
  // aligns them by day index, since the two ranges rarely share dates).
  cmp_trend: {
    dax: (r, q) => {
      const a = String(q.tStart).split("-").map(Number), b = addDays(q.tEnd, 1).split("-").map(Number);
      const cut = Number(q.cutHour);
      const hourCut = isFinite(cut) && cut >= 0 && cut < 24
        ? `\n  VAR __hr = FILTER(ALL('SALES DATA'[HOUR]), 'SALES DATA'[HOUR] <= ${Math.floor(cut)})` : "";
      const hc = hourCut ? ", __hr" : "";
      return `DEFINE
  VAR __d = FILTER(ALL('DATETABLE'[DATE]), 'DATETABLE'[DATE] >= DATE(${a[0]},${a[1]},${a[2]}) && 'DATETABLE'[DATE] < DATE(${b[0]},${b[1]},${b[2]}))${hourCut}
  VAR __brand = ${brandFilterVar()}
EVALUATE SUMMARIZECOLUMNS('DATETABLE'[DATE], __d, __brand${hc},
  "Net", CALCULATE(SUM('SALES DATA'[NET])),
  "Orders", CALCULATE(COUNTROWS('SALES DATA')))
ORDER BY 'DATETABLE'[DATE]`;
    },
    cols: [["date", "DATETABLE[DATE]"], ["sales", "[Net]"], ["orders", "[Orders]"]],
  },
  // §6 data-coverage probe: the last hour that actually carries data on a given
  // day. Detects a partial day (and late-arriving data) instead of assuming the
  // day is complete because the calendar says so.
  cmp_coverage: {
    single: true,
    dax: (r, q) => {
      const d = String(q.day || "").split("-").map(Number);
      if (d.length !== 3 || d.some((n) => !isFinite(n))) return `EVALUATE ROW("lastHour", -1, "sales", 0)`;
      return `DEFINE
  VAR __d = FILTER(ALL('DATETABLE'[DATE]), 'DATETABLE'[DATE] = DATE(${d[0]},${d[1]},${d[2]}))
  VAR __brand = ${brandFilterVar()}
  VAR __h = SUMMARIZECOLUMNS('SALES DATA'[HOUR], __d, __brand, "Net", CALCULATE(SUM('SALES DATA'[NET])))
  VAR __live = FILTER(__h, [Net] > 0)
EVALUATE ROW("lastHour", MAXX(__live, 'SALES DATA'[HOUR]), "sales", SUMX(__live, [Net]))`;
    },
    cols: [["lastHour", "[lastHour]"], ["sales", "[sales]"]],
  },

  // ================= SALES ANALYSIS — Section 3: HOW (channels) ================
  // Ranked channels: Net (WoW/MoM/YoY quad) + Orders + AOV. Powers the channel
  // table, the AOV-by-channel bars and the channel-share donut. Order source is a
  // cross-brand dimension, so it stays flat — the global brand filter still scopes it.
  ov_channels: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS('BusinessesTable'[OrdersourceName], __brand, ${x.args}${quad("Net", "SUM('SALES DATA'[NET])")},${quad("Orders", "'Append1'[Count of Orders]")},
    "AOV", CALCULATE('Append1'[AOV], __cur))
  VAR __f = FILTER(__core, [Net] > 0)
EVALUATE __f ORDER BY [Net] DESC`; },
    cols: [["label", "BusinessesTable[OrdersourceName]"], ...quadCols("net", "Net"), ...quadCols("orders", "Orders"), ["aov", "[AOV]"]],
  },
  // Channel mix over time — DATE x channel net (period/long grains; client pivots to
  // a stacked area and aggregates to weekly for long-range).
  ov_channel_series: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('DATETABLE'[DATE], 'BusinessesTable'[OrdersourceName], __date, __brand, ${x.args}
  "Net", CALCULATE(SUM('SALES DATA'[NET])))
ORDER BY 'DATETABLE'[DATE]`; },
    cols: [["x", "DATETABLE[DATE]"], ["ch", "BusinessesTable[OrdersourceName]"], ["net", "[Net]"]],
  },
  // Channel mix over time — HOUR x channel net (DAY grain).
  ov_channel_hourly: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[HOUR], 'BusinessesTable'[OrdersourceName], __date, __brand, ${x.args}
  "Net", CALCULATE(SUM('SALES DATA'[NET])))
ORDER BY 'SALES DATA'[HOUR]`; },
    cols: [["x", "SALES DATA[HOUR]"], ["ch", "BusinessesTable[OrdersourceName]"], ["net", "[Net]"]],
  },

  // ================= SALES ANALYSIS — Section 4: HOW MUCH (ticket) =============
  // Order-value distribution — orders + net per NETSALES_BUCKET (the model's ticket-size
  // buckets). Client sorts by the bucket's natural numeric order and draws the histogram.
  ov_buckets: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('SALES DATA'[NETSALES_BUCKET], __date, __brand, ${x.args}
  "Orders", 'Append1'[Count of Orders],
  "Net", CALCULATE(SUM('SALES DATA'[NET])))`; },
    cols: [["label", "SALES DATA[NETSALES_BUCKET]"], ["orders", "[Orders]"], ["net", "[Net]"]],
  },

  // ================= SALES ANALYSIS — Section 5: COMPARISONS ===================
  // Three weekday-aligned comparison windows (same as the rest of the platform):
  //   same day last week (-7), last month (-28), last year (-364) — whole-week offsets
  //   so the weekday always lines up. Headline single-row: Net / Orders / AOV each in
  //   current + W/M/Y, plus current Target.
  ov_compare: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS(__brand, ${x.args}${quad("Net", "SUM('SALES DATA'[NET])")},${quad("Ord", "'Append1'[Count of Orders]")},${quad("Aov", "'Append1'[AOV]")},
  "TgtCur", CALCULATE(SUM('FORECAST BRANCH'[Daily Target]), __cur))`; },
    cols: [...quadCols("net", "Net"), ...quadCols("ord", "Ord"), ...quadCols("aov", "Aov"), ["tgtCur", "[TgtCur]"]],
  },
  // Per-dimension comparison — Brand at All Brands, Location when a brand is scoped.
  // SELECTCOLUMNS aliases the group column to a fixed "label" so the mapper is stable.
  ov_compare_dim: {
    dax: (r, q) => { const x = xf(q);
      const scoped = CURRENT.brand && CURRENT.brand !== "all";
      const dim = scoped ? "'LocationMaster'[Location]" : "'Brand Table'[Brand Full Name]";
      // periodVars() (via quad) drops the WoW column for ranges >7d, so the
      // internal references here must match what was actually emitted.
      const pv = periodVars(r);   // sets _cmp for this range
      const wSel = _cmp.w ? `, "Net_W", [Net_W]` : "";
      const wFilt = _cmp.w ? ` || [Net_W] > 0` : "";
      return `DEFINE${pv}${x.def}
  VAR __core = SUMMARIZECOLUMNS(${dim}, __brand, ${x.args}${quad("Net", "SUM('SALES DATA'[NET])")})
  VAR __f = FILTER(__core, [Net] > 0${wFilt} || [Net_M] > 0 || [Net_Y] > 0)
EVALUATE SELECTCOLUMNS(__f, "label", ${dim}, "Net", [Net]${wSel}, "Net_M", [Net_M], "Net_Y", [Net_Y]) ORDER BY [Net] DESC`; },
    cols: [["label", "[label]"], ["netCur", "[Net]"], ["netW", "[Net_W]"], ["netM", "[Net_M]"], ["netY", "[Net_Y]"]],
  },

  // ================= SALES ANALYSIS — Section 6: DEEP DIVE =====================
  // Composable pivot grid — client picks 1-4 dimensions (brand/channel/location/day);
  // dims aliased to d0..dN so the mapper stays stable. Capped for the DOM; note when hit.
  ov_deepdive: {
    dax: (r, q) => { const x = xf(q);
      const DIMS = { brand: "'Brand Table'[Brand Full Name]", channel: "'BusinessesTable'[OrdersourceName]", location: "'LocationMaster'[Location]", day: "'DATETABLE'[DATE]" };
      const sel = String(q.dims || "brand,channel,location").split(",").map((s) => s.trim()).filter((d) => DIMS[d]);
      const dims = sel.length ? sel : ["brand"];
      const groupCols = dims.map((d) => DIMS[d]).join(", ");
      const selectDims = dims.map((d, i) => `"d${i}", ${DIMS[d]}`).join(", ");
      return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(${groupCols}, __date, __brand, ${x.args}
    "Net", CALCULATE(SUM('SALES DATA'[NET])),
    "Orders", 'Append1'[Count of Orders],
    "AOV", 'Append1'[AOV])
  VAR __f = FILTER(__core, [Net] <> 0)
EVALUATE TOPN(3000, SELECTCOLUMNS(__f, ${selectDims}, "Net", [Net], "Orders", [Orders], "AOV", [AOV]), [Net], DESC) ORDER BY [Net] DESC`; },
    cols: [["d0", "[d0]"], ["d1", "[d1]"], ["d2", "[d2]"], ["d3", "[d3]"], ["Net", "[Net]"], ["Orders", "[Orders]"], ["AOV", "[AOV]"]],
  },

  // ================= OPERATIONS (recreated from the PBI Operations page) =======
  // KPI band: fulfillment speed + quality + availability, each with W/M/Q/Y so the
  // page can show period-adaptive comparisons (day->WoW+YoY, period->MoM+YoY, long->QoQ+YoY).
  ops_kpis: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS(__brand, ${x.args}${quint("Prep", "CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30)))")},${quint("Delivery", "'TALABAT_LOGISTICS'[Avg Delivery Time (min)]")},${quint("Complaint", "'Append1'[Complaint_to_Order_Ratio]")},${quint("Rating", "'Append1'[AverageRating]")},${quint("Offline", "'Append1'[TotalOfflineRate]")},${quint("Orders", "'Append1'[Count of Orders]")})`; },
    cols: [...quintCols("prep", "Prep"), ...quintCols("delivery", "Delivery"), ...quintCols("complaint", "Complaint"), ...quintCols("rating", "Rating"), ...quintCols("offline", "Offline"), ...quintCols("orders", "Orders")],
  },
  // Fulfillment trend — daily (period/long) and hourly (day mode). Prep, delivery, complaint ratio.
  ops_trend_daily: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('DATETABLE'[DATE], __date, __brand, ${x.args}
  "Prep", CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))),
  "Delivery", 'TALABAT_LOGISTICS'[Avg Delivery Time (min)],
  "Complaint", 'Append1'[Complaint_to_Order_Ratio],
  "Complaints", 'Append1'[Count of Complaints],
  "Rating", 'Append1'[AverageRating])
ORDER BY 'DATETABLE'[DATE]`; },
    cols: [["x", "DATETABLE[DATE]"], ["prep", "[Prep]"], ["delivery", "[Delivery]"], ["complaint", "[Complaint]"], ["complaints", "[Complaints]"], ["rating", "[Rating]"]],
  },
  // fulfillment by hour uses TALABAT_LOGISTICS' own Hour column (prep/delivery live there)
  ops_trend_hourly: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('TALABAT_LOGISTICS'[Hour], __date, __brand, ${x.args}
  "Prep", CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))),
  "Delivery", 'TALABAT_LOGISTICS'[Avg Delivery Time (min)]), NOT ISBLANK([Prep]) || NOT ISBLANK([Delivery]))
ORDER BY 'TALABAT_LOGISTICS'[Hour]`; },
    cols: [["x", "TALABAT_LOGISTICS[Hour]"], ["prep", "[Prep]"], ["delivery", "[Delivery]"]],
  },
  // complaints by hour use the Complaints table's own Hour column (count + ratio, like PBI)
  ops_complaints_hourly: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('Complaints'[Hour], __date, __brand, ${x.args}
  "Complaints", 'Append1'[Count of Complaints], "Ratio", 'Append1'[Complaint_to_Order_Ratio]), [Complaints] > 0)
ORDER BY 'Complaints'[Hour]`; },
    cols: [["x", "Complaints[Hour]"], ["complaints", "[Complaints]"], ["ratio", "[Ratio]"]],
  },
  // ---- exact PBI structures (Step 2) ----
  // Prep / Delivery HEATMAP: Location (rows) x Hour (cols) x avg time
  ops_prep_heatmap: {
    // rows adapt: BRAND at all-brands, LOCATION when one brand is scoped (aliased to "Loc")
    dax: (r, q) => { const x = xf(q); const d = opsDim(); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(${d}, 'TALABAT_LOGISTICS'[Hour], __date, __brand, ${x.args}"V", CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))))
EVALUATE FILTER(SELECTCOLUMNS(__core, "Loc", ${d}, "hour", 'TALABAT_LOGISTICS'[Hour], "V", [V]), NOT ISBLANK([V]))`; },
    cols: [["loc", "[Loc]"], ["hour", "[hour]"], ["v", "[V]"]],
  },
  ops_delivery_heatmap: {
    dax: (r, q) => { const x = xf(q); const d = opsDim(); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(${d}, 'TALABAT_LOGISTICS'[Hour], __date, __brand, ${x.args}"V", 'TALABAT_LOGISTICS'[Avg Delivery Time (min)])
EVALUATE FILTER(SELECTCOLUMNS(__core, "Loc", ${d}, "hour", 'TALABAT_LOGISTICS'[Hour], "V", [V]), NOT ISBLANK([V]))`; },
    cols: [["loc", "[Loc]"], ["hour", "[hour]"], ["v", "[V]"]],
  },
  // delivery daily line: DATE x Avg Delivery + Avg Rider Waiting (PBI lineChart)
  ops_delivery_daily: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('DATETABLE'[DATE], __date, __brand, ${x.args}
  "Delivery", 'TALABAT_LOGISTICS'[Avg Delivery Time (min)], "RiderWait", 'TALABAT_LOGISTICS'[Avg Rider Waiting Time (min)])
ORDER BY 'DATETABLE'[DATE]`; },
    cols: [["x", "DATETABLE[DATE]"], ["delivery", "[Delivery]"], ["riderWait", "[RiderWait]"]],
  },
  // complaints category pivot: ComplaintCategories > Complaint Type > Item Name + counts + refund
  ops_complaint_pivot: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('Complaints'[ComplaintCategories], 'Complaints'[Complaint Type], 'Complaints'[Complaint Reason], __date, __brand, ${x.args}
  "Count", 'Append1'[Count of Complaints], "Valid", CALCULATE(COUNTROWS('Complaints'), 'Complaints'[Validation] = "Valid"), "Invalid", CALCULATE(COUNTROWS('Complaints'), 'Complaints'[Validation] = "Invalid"), "Refund", 'Complaints'[Refund Amount Final]), [Count] > 0) ORDER BY [Count] DESC`; },
    cols: [["category", "Complaints[ComplaintCategories]"], ["type", "Complaints[Complaint Type]"], ["reason", "Complaints[Complaint Reason]"], ["count", "[Count]"], ["valid", "[Valid]"], ["invalid", "[Invalid]"], ["refund", "[Refund]"]],
  },
  // complaints by branch (PBI ComplaintsCount by Location)
  ops_complaints_branch: {
    dax: (r, q) => { const x = xf(q); const d = opsDim(); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS(${d}, __date, __brand, ${x.args}"Count", 'Append1'[Count of Complaints])
  VAR __out = SELECTCOLUMNS(FILTER(__core, [Count] > 0), "Label", ${d}, "Count", [Count])
EVALUATE __out ORDER BY [Count] DESC`; },
    cols: [["label", "[Label]"], ["value", "[Count]"]],
  },
  // Prep-time bucket distribution (order counts per PrepTimeBucket) — % computed on the client
  ops_prep_buckets: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('TALABAT_LOGISTICS'[PrepTimeBucket], __date, __brand, ${x.args}"Cnt", COUNTROWS('TALABAT_LOGISTICS')), NOT ISBLANK('TALABAT_LOGISTICS'[PrepTimeBucket]) && [Cnt] > 0)`; },
    cols: [["bucket", "TALABAT_LOGISTICS[PrepTimeBucket]"], ["count", "[Cnt]"]],
  },
  // Delivery-time bucket distribution — buckets derived from Actual Delivery Time (min)
  ops_delivery_buckets: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE
  VAR __t = CALCULATETABLE(
    ADDCOLUMNS(FILTER('TALABAT_LOGISTICS', NOT ISBLANK('TALABAT_LOGISTICS'[Actual Delivery Time])),
      "Bucket", SWITCH(TRUE(),
        'TALABAT_LOGISTICS'[Actual Delivery Time] <= 20, "15-20",
        'TALABAT_LOGISTICS'[Actual Delivery Time] <= 25, "20-25",
        'TALABAT_LOGISTICS'[Actual Delivery Time] <= 30, "25-30",
        'TALABAT_LOGISTICS'[Actual Delivery Time] <= 35, "30-35",
        'TALABAT_LOGISTICS'[Actual Delivery Time] <= 40, "35-40", "40+")),
    __date, __brand)
  RETURN GROUPBY(__t, [Bucket], "Cnt", SUMX(CURRENTGROUP(), 1))`; },
    cols: [["bucket", "[Bucket]"], ["count", "[Cnt]"]],
  },
  // reviews table: Comments + rating
  ops_reviews: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE TOPN(500, FILTER(SUMMARIZECOLUMNS('Append1'[Comments], __date, __brand, ${x.args}"Rating", 'Append1'[AverageRating]), NOT ISBLANK('Append1'[Comments])), [Rating], ASC)`; },
    cols: [["text", "Append1[Comments]"], ["rating", "[Rating]"]],
  },
  // order journey by brand
  ops_journey_brand: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('Brand Table'[Brand], __date, __brand, ${x.args}"Journey", 'Append1'[AverageOrderJourney]), NOT ISBLANK([Journey])) ORDER BY [Journey] DESC`; },
    cols: [["label", "Brand Table[Brand]"], ["value", "[Journey]"]],
  },
  // hidden trend by HIDEN date
  ops_hidden_trend: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS('HIDEN'[Date], __date, __brand, ${x.args}"V", 'Append1'[Hiden]) ORDER BY 'HIDEN'[Date]`; },
    cols: [["x", "HIDEN[Date]"], ["value", "[V]"]],
  },
  // busy trend by Busy Date (duration seconds)
  ops_busy_trend: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('BUSY TIME'[Busy Date], __date, __brand, ${x.args}"Dur", SUM('BUSY TIME'[DurationInSeconds])), [Dur] > 0) ORDER BY 'BUSY TIME'[Busy Date]`; },
    cols: [["x", "BUSY TIME[Busy Date]"], ["value", "[Dur]"]],
  },
  // OFFLINE LOG — exact PBI columns: Brand, Location, Date, From, To, Durations, Comment
  ops_offline_log: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('BUSY TIME'[Brand], 'LocationMaster'[Location], 'DATETABLE'[DATE], 'BUSY TIME'[From], 'BUSY TIME'[To], 'BUSY TIME'[Durations], 'BUSY TIME'[Comment], __date, __brand, ${x.args}
  "Dur", SUM('BUSY TIME'[DurationInSeconds])), [Dur] > 0) ORDER BY [Dur] DESC`; },
    cols: [["brand", "BUSY TIME[Brand]"], ["branch", "LocationMaster[Location]"], ["date", "DATETABLE[DATE]"], ["from", "BUSY TIME[From]"], ["to", "BUSY TIME[To]"], ["durations", "BUSY TIME[Durations]"], ["comment", "BUSY TIME[Comment]"], ["dur", "[Dur]"]],
  },
  // Per-branch operations detail (AG-Grid table + location bars, cross-filter source).
  ops_by_location: {
    dax: (r, q) => { const x = xf(q); const d = opsDim(); const b = locBridge(); const AP = "Append1[Branch_Clean_Append1]", TL = "'TALABAT_LOGISTICS'[Location_Clean]"; return `DEFINE${dayFilters(r)}${x.def}${b.def}
  VAR __core = SUMMARIZECOLUMNS(${d}, __date, __brand, ${x.args}
    "Prep", ${locFold("CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30)))", AP, b.active)},
    "Delivery", ${locFold("'TALABAT_LOGISTICS'[Avg Delivery Time (min)]", TL, b.active)},
    "Complaint", ${locFold("'Append1'[Complaint_to_Order_Ratio]", AP, b.active)},
    "Rating", ${locFold("'Append1'[AverageRating]", AP, b.active)},
    "Offline", ${locFold("'Append1'[TotalOfflineRate]", AP, b.active)},
    "Orders", ${locFold("'Append1'[Count of Orders]", AP, b.active)},
    "Net", CALCULATE(SUM('SALES DATA'[NET])))
  VAR __out = SELECTCOLUMNS(FILTER(__core, [Net] > 0), "Label", ${d}, "Prep", [Prep], "Delivery", [Delivery], "Complaint", [Complaint], "Rating", [Rating], "Offline", [Offline], "Orders", [Orders], "Net", [Net])
EVALUATE __out ORDER BY [Net] DESC`; },
    cols: [["label", "[Label]"], ["prep", "[Prep]"], ["delivery", "[Delivery]"], ["complaint", "[Complaint]"], ["rating", "[Rating]"], ["offline", "[Offline]"], ["orders", "[Orders]"], ["net", "[Net]"]],
  },
  // Per-store metrics for the Locations map — Brand × Location, prep/delivery/rating
  // + sales, so each pin can show operational detail and flag slow-delivery stores.
  ops_store_metrics: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], 'LocationMaster'[Location], __date, __brand, ${x.args}
    "Prep", CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))),
    "Delivery", 'TALABAT_LOGISTICS'[Avg Delivery Time (min)],
    "Rating", 'Append1'[AverageRating],
    "Net", CALCULATE(SUM('SALES DATA'[NET])),
    "Orders", 'Append1'[Count of Orders],
    "AOV", 'Append1'[AOV])
EVALUATE FILTER(__core, [Net] > 0) ORDER BY [Net] DESC`; },
    cols: [["brand", "Brand Table[Brand Full Name]"], ["location", "LocationMaster[Location]"], ["prep", "[Prep]"], ["delivery", "[Delivery]"], ["rating", "[Rating]"], ["net", "[Net]"], ["orders", "[Orders]"], ["aov", "[AOV]"]],
  },
  // Complaints by channel (quality bar chart).
  ops_channel_complaints: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS('BusinessesTable'[OrdersourceName], __date, __brand, ${x.args}
    "Complaints", 'Append1'[Count of Complaints],
    "Ratio", 'Append1'[Complaint_to_Order_Ratio])
  VAR __f = FILTER(__core, [Complaints] > 0)
EVALUATE __f ORDER BY [Complaints] DESC`; },
    cols: [["label", "BusinessesTable[OrdersourceName]"], ["complaints", "[Complaints]"], ["ratio", "[Ratio]"]],
  },
  // Three DAX-generated section insights (Fulfillment / Quality / Availability).
  ops_sections: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${periodVars(r)}${x.def}
  VAR PrepCur = CALCULATE(CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))), __cur)
  VAR PrepW = CALCULATE(CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))), __w)
  VAR PrepD = DIVIDE(PrepCur - PrepW, PrepW)
  VAR DelCur = CALCULATE('TALABAT_LOGISTICS'[Avg Delivery Time (min)], __cur)
  VAR DelW = CALCULATE('TALABAT_LOGISTICS'[Avg Delivery Time (min)], __w)
  VAR DelD = DIVIDE(DelCur - DelW, DelW)
  VAR CompCur = CALCULATE('Append1'[Complaint_to_Order_Ratio], __cur)
  VAR CompW = CALCULATE('Append1'[Complaint_to_Order_Ratio], __w)
  VAR CompD = DIVIDE(CompCur - CompW, CompW)
  VAR RateCur = CALCULATE('Append1'[AverageRating], __cur)
  VAR OffCur = CALCULATE('Append1'[TotalOfflineRate], __cur)
  VAR LocsPrep = ADDCOLUMNS(VALUES('LocationMaster'[Location]), "P", CALCULATE(CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30))), __cur))
  VAR SlowN = COUNTROWS(FILTER(LocsPrep, [P] > PrepCur))
  VAR TotN = COUNTROWS(FILTER(LocsPrep, NOT ISBLANK([P])))
  VAR Fulfil = "Avg prep " & FORMAT(PrepCur, "0.0") & " min (" & FORMAT(PrepD, "+0.0%;-0.0%") & " vs last week); delivery " & FORMAT(DelCur, "0.0") & " min (" & FORMAT(DelD, "+0.0%;-0.0%") & "). " & SlowN & " of " & TotN & " branches above the average prep time."
  VAR Quality = "Complaint ratio " & FORMAT(CompCur, "0.00%") & " (" & FORMAT(CompD, "+0.0%;-0.0%") & " vs last week); average rating " & FORMAT(RateCur, "0.00") & "."
  VAR Availability = "Offline rate " & FORMAT(OffCur, "0.0%") & " across the selected period."
EVALUATE ROW("Fulfillment", Fulfil, "Quality", Quality, "Availability", Availability)`; },
    cols: [["fulfillment", "[Fulfillment]"], ["quality", "[Quality]"], ["availability", "[Availability]"]],
  },

  // ---- extra Operations report data --------------------------------------
  ops_complaint_cat: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('Complaints'[Complaint Type], __date, __brand, ${x.args}"Count", 'Append1'[Count of Complaints])
EVALUATE FILTER(__c, [Count] > 0) ORDER BY [Count] DESC`; },
    cols: [["label", "Complaints[Complaint Type]"], ["value", "[Count]"]],
  },
  // complaints grouped by who's responsible (for the AI assistant / suggestions)
  ops_complaint_resp: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('Complaints'[Responsible Party], __date, __brand, ${x.args}"Count", 'Append1'[Count of Complaints])
EVALUATE FILTER(__c, [Count] > 0 && NOT ISBLANK('Complaints'[Responsible Party])) ORDER BY [Count] DESC`; },
    cols: [["label", "Complaints[Responsible Party]"], ["value", "[Count]"]],
  },
  ops_complaints_detail: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('Complaints'[Complaint Type], 'LocationMaster'[Location], 'BusinessesTable'[OrdersourceName], __date, __brand, ${x.args}"Count", 'Append1'[Count of Complaints])
EVALUATE FILTER(__c, [Count] > 0) ORDER BY [Count] DESC`; },
    cols: [["reason", "Complaints[Complaint Type]"], ["branch", "LocationMaster[Location]"], ["channel", "BusinessesTable[OrdersourceName]"], ["count", "[Count]"]],
  },
  ops_busy_reason: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('BUSY TIME'[Reason Category], __date, __brand, ${x.args}"Count", 'BUSY TIME'[BusyCount], "Duration", SUM('BUSY TIME'[DurationInSeconds]))
EVALUATE FILTER(__c, [Count] > 0) ORDER BY [Duration] DESC`; },
    cols: [["label", "BUSY TIME[Reason Category]"], ["value", "[Count]"], ["duration", "[Duration]"]],
  },
  ops_hidden_loc: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('HIDEN'[Branch], __date, __brand, ${x.args}"Times", COUNTROWS('HIDEN'), "Minutes", SUM('HIDEN'[HiddenMinutes]), "Items", DISTINCTCOUNT('HIDEN'[Hidden Items]))
EVALUATE FILTER(__c, [Times] > 0) ORDER BY [Times] DESC`; },
    cols: [["label", "HIDEN[Branch]"], ["times", "[Times]"], ["minutes", "[Minutes]"], ["items", "[Items]"]],
  },
  ops_hidden_items: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('HIDEN'[Hidden Items], __date, __brand, ${x.args}"Times", COUNTROWS('HIDEN'), "Minutes", SUM('HIDEN'[HiddenMinutes]))
EVALUATE TOPN(10, FILTER(__c, [Times] > 0), [Times], DESC) ORDER BY [Times] DESC`; },
    cols: [["label", "HIDEN[Hidden Items]"], ["times", "[Times]"], ["minutes", "[Minutes]"]],
  },
  // hidden-item COUNT per brand (for the all-brands tile view)
  ops_hidden_brand: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], __date, __brand, ${x.args}"Times", COUNTROWS('HIDEN'), "Minutes", SUM('HIDEN'[HiddenMinutes]))
EVALUATE FILTER(__c, [Times] > 0) ORDER BY [Times] DESC`; },
    cols: [["label", "Brand Table[Brand Full Name]"], ["times", "[Times]"], ["minutes", "[Minutes]"]],
  },
  // detail logs for the See-More modals
  ops_busy_log: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('DATETABLE'[DATE], 'LocationMaster'[Location], 'BUSY TIME'[Reason Category], __date, __brand, ${x.args}
    "Duration", SUM('BUSY TIME'[DurationInSeconds]), "Events", 'BUSY TIME'[BusyCount])
EVALUATE FILTER(__c, [Duration] > 0) ORDER BY [Duration] DESC`; },
    cols: [["date", "DATETABLE[DATE]"], ["branch", "LocationMaster[Location]"], ["reason", "BUSY TIME[Reason Category]"], ["duration", "[Duration]"], ["events", "[Events]"]],
  },
  ops_hidden_detail: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __c = SUMMARIZECOLUMNS('HIDEN'[Hidden Items], 'HIDEN'[Branch], __date, __brand, ${x.args}
    "Times", COUNTROWS('HIDEN'), "Minutes", SUM('HIDEN'[HiddenMinutes]))
EVALUATE FILTER(__c, [Times] > 0) ORDER BY [Times] DESC`; },
    cols: [["item", "HIDEN[Hidden Items]"], ["branch", "HIDEN[Branch]"], ["times", "[Times]"], ["minutes", "[Minutes]"]],
  },
  // Order journey / ratings supplementary single-row KPIs
  ops_extra_kpis: {
    single: true,
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
EVALUATE SUMMARIZECOLUMNS(__date, __brand, ${x.args}
  "P90Prep", 'Append1'[P90 Prep Time (min)],
  "RiderWait", 'TALABAT_LOGISTICS'[Avg Rider Waiting Time (min)],
  "Pickup", 'TALABAT_LOGISTICS'[Avg Pickup to Delivery Time (min)],
  "Complaints", 'Append1'[Count of Complaints],
  "HiddenItems", DISTINCTCOUNT('HIDEN'[Hidden Items]),
  "HiddenMinutes", SUM('HIDEN'[HiddenMinutes]),
  "ValidCount", CALCULATE(COUNTROWS('Complaints'), 'Complaints'[Validation] = "Valid"),
  "InvalidCount", CALCULATE(COUNTROWS('Complaints'), 'Complaints'[Validation] = "Invalid"),
  "RefundOrders", 'Complaints'[Refund Order Count],
  "OfflineDur", SUM('BUSY TIME'[DurationInSeconds]))`; },
    cols: [["p90prep", "[P90Prep]"], ["riderWait", "[RiderWait]"], ["pickup", "[Pickup]"], ["complaints", "[Complaints]"], ["hiddenItems", "[HiddenItems]"], ["hiddenMinutes", "[HiddenMinutes]"], ["validCount", "[ValidCount]"], ["invalidCount", "[InvalidCount]"], ["refundOrders", "[RefundOrders]"], ["offlineDur", "[OfflineDur]"]],
  },
  // OFFLINE RATE building block: per brand+branch, the busy minutes and the number
  // of days that branch actually TRADED (had sales) in the period. The server pairs
  // this with admin-entered working hours to compute a real offline rate =
  // busy minutes / (working hours × 60 × trading days). No offline-rate DAX measure.
  ops_offline_calc: {
    dax: (r, q) => { const x = xf(q); return `DEFINE${dayFilters(r)}${x.def}
  VAR __core = SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], 'LocationMaster'[Location], __date, __brand, ${x.args}
    "BusyMin", DIVIDE(SUM('BUSY TIME'[DurationInSeconds]), 60),
    "SalesDays", COUNTROWS(FILTER(VALUES('DATETABLE'[DATE]), CALCULATE(SUM('SALES DATA'[NET])) > 0)))
EVALUATE FILTER(__core, [SalesDays] > 0 || [BusyMin] > 0) ORDER BY 'Brand Table'[Brand Full Name], 'LocationMaster'[Location]`; },
    cols: [["brand", "Brand Table[Brand Full Name]"], ["location", "LocationMaster[Location]"], ["busyMin", "[BusyMin]"], ["salesDays", "[SalesDays]"]],
  },

  // ============================ PRODUCT MIX (2nd model) ====================
  // KPIs: Net Sales / Quantity / Orders / AOV / Discount, with adaptive WoW/MoM/YoY
  pm_kpis: {
    model: "productmix", single: true,
    dax: (r, q) => { const p = pmPeriods(r); const sc = pmScope(q); const a = sc.args; return `DEFINE${p.def}${sc.def}
EVALUATE ROW(${pmQuad("sales", "[Net Sales]", p.w, a)},${pmQuad("qty", "[QUANTITY]", p.w, a)},${pmQuad("orders", "[Orders]", p.w, a)},
  "aov", DIVIDE(CALCULATE([Net Sales], __d${a}), CALCULATE([Orders], __d${a})),
  "gross", CALCULATE([Gross Sales], __d${a}),
  "disc", CALCULATE([Discount %], __d${a}),
  "discamt", CALCULATE([Discount Amount], __d${a}))`; },
    cols: [...pmQuadCols("sales"), ...pmQuadCols("qty"), ...pmQuadCols("orders"), ["aov", "[aov]"], ["gross", "[gross]"], ["disc", "[disc]"], ["discamt", "[discamt]"]],
  },
  // Category performance — sales, quantity, mix %, with sales comparison
  pm_category: {
    model: "productmix",
    dax: (r, q) => { const p = pmPeriods(r); const sc = pmScope(q); const a = sc.args; return `DEFINE${p.def}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[Category], __d${a},${pmQuad("sales", "[Item Sales]", p.w, a)},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}), "mix", CALCULATE([Item Sales Mix %], __d${a}), "orders", CALCULATE([Item Orders], __d${a})), [sales] > 0)
ORDER BY [sales] DESC`; },
    cols: [["label", "LINE[Category]"], ...pmQuadCols("sales"), ["qty", "[qty]"], ["mix", "[mix]"], ["orders", "[orders]"]],
  },
  // Bestsellers — top items by sales
  pm_bestsellers: {
    model: "productmix",
    dax: (r, q) => { const p = pmPeriods(r); const sc = pmScope(q); const a = sc.args; return `DEFINE${p.def}${sc.def}
EVALUATE TOPN(20, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], 'LINE'[Category], __d${a},
  "sales", CALCULATE([Item Sales], __d${a}), "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}), "mix", CALCULATE([Item Sales Mix %], __d${a}), "vel", CALCULATE([Item Velocity], __d${a})), [sales] > 0), [sales], DESC)
ORDER BY [sales] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["category", "LINE[Category]"], ["sales", "[sales]"], ["qty", "[qty]"], ["mix", "[mix]"], ["vel", "[vel]"]],
  },
  // Hero items — TOP items for the SELECTED PERIOD (penetration × velocity), respects page filters + admin exclusions
  pm_hero: {
    model: "productmix",
    dax: (r, q) => { const sc = pmScope(q); const a = sc.args; const ex = pmExclPredicate(loadPmExcl().hero); return `DEFINE VAR __d = ${pmDateFilter(r)}${sc.def}
EVALUATE TOPN(12, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], 'LINE'[Category], __d${a},
  "sales", CALCULATE([Item Sales], __d${a}), "orders", CALCULATE([Item Orders], __d${a}), "pen", CALCULATE([Item Penetration %], __d${a}), "vel", CALCULATE([Item Velocity], __d${a})), [sales] > 0${ex}), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["category", "LINE[Category]"], ["sales", "[sales]"], ["orders", "[orders]"], ["pen", "[pen]"], ["vel", "[vel]"]],
  },
  // New Item Launch — uses the model's EXACT [Is New Item] logic (first-ever sale
  // within [SelectedPeriodStart-30, SelectedPeriodEnd] & no orders before lookback).
  // Date filter is on LINE[VoucherDate] so [Selected Period Start/End] = the range.
  pm_launch_detail: {
    model: "productmix",
    dax: (r, q) => { const sc = pmScope(q); const a = sc.args;
      const s = r.start.split("-").map(Number), e = r.end.split("-").map(Number), lb = addDays(r.start, -30).split("-").map(Number);
      const dLine = `FILTER(ALL('LINE'[VoucherDate]), 'LINE'[VoucherDate] >= DATE(${s[0]},${s[1]},${s[2]}) && 'LINE'[VoucherDate] < DATE(${e[0]},${e[1]},${e[2]}) + 1)`;
      const pLine = `FILTER(ALL('LINE'[VoucherDate]), ${pmBetween(shiftRange(r, -dayCount(r)), "'LINE'[VoucherDate]")})`;
      return `DEFINE VAR __d = ${dLine}${sc.def}
  VAR __first = SUMMARIZE(ALL('LINE'), 'LINE'[ProductName_Fixed_Option], "f", MIN('LINE'[VoucherDate]))
  VAR __new = SELECTCOLUMNS(FILTER(__first, [f] >= DATE(${lb[0]},${lb[1]},${lb[2]}) && [f] <= DATE(${e[0]},${e[1]},${e[2]})), "p", 'LINE'[ProductName_Fixed_Option], "launch", [f])
EVALUATE TOPN(24, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], 'LINE'[Category], 'LINE'[Brand], __d${a},
  KEEPFILTERS(TREATAS(SELECTCOLUMNS(__new, "p", [p]), 'LINE'[ProductName_Fixed_Option])),
  "launch", CALCULATE(MINX(FILTER(__new, [p] = SELECTEDVALUE('LINE'[ProductName_Fixed_Option])), [launch])),
  "sales", CALCULATE([Item Sales], __d${a}), "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "orders", CALCULATE([Item Orders], __d${a}), "vel", CALCULATE([Item Velocity], __d${a}),
  "pen", CALCULATE([Item Penetration %], __d${a}),
  "salesprev", CALCULATE([Item Sales], ${pLine}${a})),
  [sales] > 0), [sales], DESC)
ORDER BY [sales] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["category", "LINE[Category]"], ["brand", "LINE[Brand]"], ["launch", "[launch]"], ["sales", "[sales]"], ["qty", "[qty]"], ["orders", "[orders]"], ["vel", "[vel]"], ["pen", "[pen]"], ["salesprev", "[salesprev]"]],
  },
  // Category → Item monthly mix (drill-down for the Category Sales Mix matrix)
  pm_cat_month_items: {
    model: "productmix",
    dax: (r, q) => { const mo = pmMonths(r); const cat = (q.pmdrillcat || "").replace(/"/g, '""'); const sc = pmScope(q); const a = sc.args;
      const catf = cat ? `, FILTER(ALL('LINE'[Category]), 'LINE'[Category] = "${cat}")` : "";
      return `DEFINE VAR __d = ${pmDateFilter(r)}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], __d${a}${catf},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SaleAmount]), ${m.filter})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SaleAmount]), __d)), [tot] > 0)
ORDER BY [tot] DESC`; },
    cols: [["label", "LINE[ProductName_Fixed_Option]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  // Product list for the item selector (all products, non-blank)
  pm_products: {
    model: "productmix",
    dax: () => `EVALUATE FILTER(VALUES('Product Selector'[ProductName_Fixed_Option]), NOT ISBLANK('Product Selector'[ProductName_Fixed_Option])) ORDER BY 'Product Selector'[ProductName_Fixed_Option]`,
    cols: [["item", "Product Selector[ProductName_Fixed_Option]"]],
  },
  // === VISUAL 1 — FREQUENTLY BOUGHT TOGETHER (Product Selector slicer) ===
  // Card: Selected Item Orders (Append1[Selected Item Orders])
  pm_selected: {
    model: "productmix", single: true,
    dax: (r, q) => { const f = pmItemFilter(q); if (!f) return `EVALUATE ROW("orders", BLANK())`;
      return `EVALUATE ROW("orders", CALCULATE([Selected Item Orders], ${f}, ${pmDateFilter(r)}))`; },
    cols: [["orders", "[orders]"]],
  },
  // Bars: LINE[ProductName_Fixed_Option] × Penetration %, filter Orders Together Filtered > 0, sort Penetration % DESC
  pm_together: {
    model: "productmix",
    dax: (r, q) => { const f = pmItemFilter(q); if (!f) return `EVALUATE ROW("item", BLANK(), "pen", BLANK(), "tip", BLANK())`;
      return `DEFINE VAR __d = ${pmDateFilter(r)}
EVALUATE TOPN(30, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], __d,
  "pen", CALCULATE([Penetration %], ${f}), "tip", CALCULATE([Orders Together Filtered], ${f})), [tip] > 0 && [pen] > 0), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["pen", "[pen]"], ["tip", "[tip]"]],
  },
  // === VISUALS 2 & 3 — CROSS-SELL / ATTACH (MAIN_ITEM slicer, default All) ===
  // MAIN_ITEM list for the slicer
  pm_mainitems: {
    model: "productmix",
    dax: () => `EVALUATE FILTER(VALUES('LINE'[MAIN_ITEM]), NOT ISBLANK('LINE'[MAIN_ITEM])) ORDER BY 'LINE'[MAIN_ITEM]`,
    cols: [["item", "LINE[MAIN_ITEM]"]],
  },
  // Cards: Cross Sell Opportunity % + Attach Opportunity % (respond to MAIN_ITEM filter)
  pm_xa_cards: {
    model: "productmix", single: true,
    dax: (r, q) => { const mf = pmMainFilter(q); const scope = [pmDateFilter(r), mf].filter(Boolean).join(", ");
      return `EVALUATE ROW("cross", CALCULATE([Cross Sell Opportunity %], ${scope}), "attach", CALCULATE([Attach Opportunity %], ${scope}))`; },
    cols: [["cross", "[cross]"], ["attach", "[attach]"]],
  },
  // Cross-sell items bar — Add On Penetration % where ITEM_ROLE = "CROSS-SELL"
  pm_crosssell_items: {
    model: "productmix",
    dax: (r, q) => { const mf = pmMainFilter(q); const m = mf ? `, ${mf}` : "";
      return `DEFINE VAR __d = ${pmDateFilter(r)}
  VAR __catx = FILTER(ALL('LINE'[Category]), NOT('LINE'[Category] IN {"Extras", "OTHERS"}))
EVALUATE TOPN(30, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], __d, __catx,
  "pen", CALCULATE([Add On Penetration %], 'LINE'[ITEM_ROLE] = "CROSS-SELL"${m}), "tip", CALCULATE([Orders with Add On], 'LINE'[ITEM_ROLE] = "CROSS-SELL"${m})),
  [pen] > 0), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["pen", "[pen]"], ["tip", "[tip]"]],
  },
  // Attach items bar — Add On Penetration % where ITEM_ROLE = "ATTACH"
  pm_attach_items: {
    model: "productmix",
    dax: (r, q) => { const mf = pmMainFilter(q); const m = mf ? `, ${mf}` : "";
      return `DEFINE VAR __d = ${pmDateFilter(r)}
  VAR __catx = FILTER(ALL('LINE'[Category]), NOT('LINE'[Category] IN {"Extras", "OTHERS"}))
EVALUATE TOPN(30, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], __d, __catx,
  "pen", CALCULATE([Add On Penetration %], 'LINE'[ITEM_ROLE] = "ATTACH"${m})),
  [pen] > 0), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["pen", "[pen]"]],
  },
  // === VISUAL 4 — CATEGORY SALES MIX matrix (Category × Month, Item Sales Mix %) ===
  // returns raw category sales per month (cheap); mix % = share of column total (client-side, == Item Sales Mix %)
  pm_cat_month: {
    model: "productmix",
    dax: (r, q) => { const mo = pmMonths(r); const sc = pmScope(q); const a = sc.args; return `DEFINE VAR __d = ${pmDateFilter(r)}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[Category], __d${a},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SaleAmount]), ${m.filter}${a})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SaleAmount]), __d${a})), [tot] > 0)
ORDER BY [tot] DESC`; },
    cols: [["label", "LINE[Category]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  // === VISUAL 5 — CATEGORY DETAIL matrix (Item Sales Mix % | Amount | Total Qty | Qty Mix | Cannibalisation %) ===
  // ROLLUP so category subtotals + grand total carry the measures at their own grain (Cannibalisation % is not additive)
  pm_cat_detail: {
    model: "productmix",
    dax: (r, q) => { const p = pmPeriods(r); const sc = pmScope(q); const a = sc.args; return `DEFINE${p.def}${sc.def}
EVALUATE SUMMARIZECOLUMNS(
  ROLLUPADDISSUBTOTAL('LINE'[Category], "isCat", 'LINE'[ProductName_Fixed_Option], "isItem"),
  __d${a},
  "mix", CALCULATE([Item Sales Mix %], __d${a}),${pmQuad("amt", "[Item Sales]", p.w, a)},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "cann", CALCULATE([Cannibalisation %], __d${a}))
ORDER BY 'LINE'[Category], [amt] DESC`; },
    cols: [["category", "LINE[Category]"], ["item", "LINE[ProductName_Fixed_Option]"], ["isCat", "[isCat]"], ["isItem", "[isItem]"], ["mix", "[mix]"], ...pmQuadCols("amt"), ["qty", "[qty]"], ["cann", "[cann]"]],
  },
  // === VISUAL 6 — CATEGORY × NETSALES_BUCKET matrix (% of column, distinct order KEY) ===
  pm_cat_bucket: {
    model: "productmix",
    dax: (r, q) => { const sc = pmScope(q); const a = sc.args; return `DEFINE VAR __d = ${pmDateFilter(r)}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[Category], 'SALES DATA'[NETSALES_BUCKET], __d${a},
  "cnt", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a})),
  NOT('LINE'[Category] IN {"Catering", "DIY Boxes", "Extras", "Make it a Meal", "MODIFIER", "OTHERS"}) && [cnt] > 0)`; },
    cols: [["category", "LINE[Category]"], ["bucket", "SALES DATA[NETSALES_BUCKET]"], ["cnt", "[cnt]"]],
  },
  // Day-part split — sales + orders by daypart
  pm_daypart: {
    model: "productmix",
    dax: (r, q) => { const p = pmPeriods(r); const sc = pmScope(q); const a = sc.args; return `DEFINE${p.def}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('SALES DATA'[DAY_PART], __d${a}, "sales", CALCULATE(SUM('SALES DATA'[Net]), __d${a}), "orders", CALCULATE([Orders], __d${a})), [sales] > 0)
ORDER BY [sales] DESC`; },
    cols: [["label", "SALES DATA[DAY_PART]"], ["sales", "[sales]"], ["orders", "[orders]"]],
  },
  // filter-bar value lists (Category / Order Source / Location)
  pm_categories: { model: "productmix", dax: () => `EVALUATE FILTER(VALUES('LINE'[Category]), NOT ISBLANK('LINE'[Category])) ORDER BY 'LINE'[Category]`, cols: [["v", "LINE[Category]"]] },
  // Order Source + Location come from the ORDER-level 'SALES DATA' (not the line table).
  // LINE[KEY] ↔ 'SALES DATA'[KEY] is bi-directional, so these still filter the product mix.
  // SELECTCOLUMNS aliases to "[v]" — models declare these columns with different casing
  // (BBT: LOCATIONID, MM: LocationID) and Power BI echoes back the declared name.
  // CALCULATETABLE scopes each list to the selected date range, so the dropdown only
  // offers values that actually have orders in that window (no all-time leftovers).
  pm_sources: { model: "productmix", dax: (r) => `EVALUATE SELECTCOLUMNS(FILTER(CALCULATETABLE(VALUES('SALES DATA'[OrderSource]), ${pmDateFilter(r)}), NOT ISBLANK('SALES DATA'[OrderSource])), "v", 'SALES DATA'[OrderSource]) ORDER BY [v]`, cols: [["v", "[v]"]] },
  pm_locations: { model: "productmix", dax: (r) => `EVALUATE SELECTCOLUMNS(FILTER(CALCULATETABLE(VALUES('SALES DATA'[LOCATIONID]), ${pmDateFilter(r)}), NOT ISBLANK('SALES DATA'[LOCATIONID])), "v", 'SALES DATA'[LOCATIONID]) ORDER BY [v]`, cols: [["v", "[v]"]] },
  // Hourly velocity — sales + orders by hour of day
  // Hourly velocity — HOURLY SALES is a precomputed weekday×hour table with NO
  // date relationship, so it's an all-time hourly pattern (not date-filtered).
  pm_hourly: {
    model: "productmix",
    dax: () => `EVALUATE SUMMARIZECOLUMNS('HOURLY SALES'[HOUR], "sales", SUM('HOURLY SALES'[AVERAGE NET SALES]), "orders", SUM('HOURLY SALES'[ORDERS]))
ORDER BY 'HOURLY SALES'[HOUR]`,
    cols: [["hour", "HOURLY SALES[HOUR]"], ["sales", "[sales]"], ["orders", "[orders]"]],
  },
  // Cross-sell / attach — items with the biggest attach & cross-sell opportunity
  pm_crosssell: {
    model: "productmix",
    dax: (r) => { const p = pmPeriods(r); return `DEFINE${p.def}
EVALUATE TOPN(15, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], __d,
  "attach", CALCULATE([Attach Opportunity %], __d), "cross", CALCULATE([Cross Sell Opportunity %], __d), "addon", CALCULATE([Add On Penetration %], __d), "orders", CALCULATE([Item Orders], __d)), [orders] > 0), [orders], DESC)
ORDER BY [orders] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["attach", "[attach]"], ["cross", "[cross]"], ["addon", "[addon]"], ["orders", "[orders]"]],
  },
  // New launches — recently launched items with penetration + cannibalisation
  pm_launches: {
    model: "productmix",
    dax: (r) => { const p = pmPeriods(r); return `DEFINE${p.def}
EVALUATE TOPN(15, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], 'LINE'[Category], __d,
  "sales", CALCULATE([Item Sales], __d), "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d), "pen", CALCULATE([Item Penetration %], __d)),
  CALCULATE(MAX('LINE'[IS_NEW_ITEM_LINE]), __d) = 1 && [sales] > 0), [sales], DESC)
ORDER BY [sales] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["category", "LINE[Category]"], ["sales", "[sales]"], ["qty", "[qty]"], ["pen", "[pen]"]],
  },

  // ============================ YELO PRODUCT MIX (model: "yelo") ============================
  // Bespoke model — everything on 'LINE' + Calendar. date=LINE[VoucherDate], qty=SUM(AdjustedQuantity),
  // sales=SUM(SalesAmount), product=LINE[NewItemName]. Guards: SellingPrice>0 + exclude test locations.
  // Reuses pmQuad/pmQuadCols (same __d/__w/__m/__y period var names).
  yp_kpis: {
    model: "yelo", single: true,
    dax: (r, q) => { const p = ypPeriods(r); const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE${p.def}${ypGuardDef}${sc.def}
EVALUATE ROW(${pmQuad("qty", "SUM('LINE'[AdjustedQuantity])", p.w, a)},${pmQuad("sales", "SUM('LINE'[SalesAmount])", p.w, a)},${pmQuad("orders", "DISTINCTCOUNT('LINE'[KEY])", p.w, a)},
  "pizzaqty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}, 'LINE'[LINE_TYPE] = "PRODUCT"),
  "aov", DIVIDE(CALCULATE(SUM('LINE'[SalesAmount]), __d${a}), CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a})))`; },
    cols: [...pmQuadCols("qty"), ...pmQuadCols("sales"), ...pmQuadCols("orders"), ["pizzaqty", "[pizzaqty]"], ["aov", "[aov]"]],
  },
  // Hero items — TOP items for the SELECTED PERIOD sorted by penetration × velocity (same logic as BBT pm_hero)
  yp_hero: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; const ex = ypExclPredicate(loadYpExcl().hero); return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE TOPN(12, FILTER(SUMMARIZECOLUMNS('LINE'[NewItemName], 'LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME], __d${a},
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a}), "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}), "orders", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a}),
  "pen", ${ypPen(a)}, "vel", CALCULATE(DIVIDE(DISTINCTCOUNT('LINE'[KEY]), DISTINCTCOUNT('LINE'[VoucherDate])), __d${a})), [sales] > 0${ex}), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[NewItemName]"], ["catdesc", "LINE[CategoryDescription]"], ["optparent", "LINE[OPTION_PARENT_CATEGORY_NAME]"], ["sales", "[sales]"], ["qty", "[qty]"], ["orders", "[orders]"], ["pen", "[pen]"], ["vel", "[vel]"]],
  },
  // New Item Launch — EXACT [Is New Item] logic: first-ever sale within [periodStart-30, periodEnd]
  yp_launch_detail: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args;
      const e = r.end.split("-").map(Number), lb = addDays(r.start, -30).split("-").map(Number);
      const pLine = `FILTER(ALL('LINE'[VoucherDate]), ${ypBetween(shiftRange(r, -dayCount(r)))})`;
      return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
  VAR __first = SUMMARIZE(ALL('LINE'), 'LINE'[NewItemName], "f", MIN('LINE'[VoucherDate]))
  VAR __new = SELECTCOLUMNS(FILTER(__first, [f] >= DATE(${lb[0]}, ${lb[1]}, ${lb[2]}) && [f] <= DATE(${e[0]}, ${e[1]}, ${e[2]})), "p", 'LINE'[NewItemName], "launch", [f])
EVALUATE TOPN(24, FILTER(SUMMARIZECOLUMNS('LINE'[NewItemName], 'LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME], __d${a},
  KEEPFILTERS(TREATAS(SELECTCOLUMNS(__new, "p", [p]), 'LINE'[NewItemName])),
  "launch", CALCULATE(MINX(FILTER(__new, [p] = SELECTEDVALUE('LINE'[NewItemName])), [launch])),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a}), "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "orders", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a}), "vel", CALCULATE(DIVIDE(DISTINCTCOUNT('LINE'[KEY]), DISTINCTCOUNT('LINE'[VoucherDate])), __d${a}),
  "pen", ${ypPen(a)},
  "salesprev", CALCULATE(SUM('LINE'[SalesAmount]), ${pLine}${a})),
  [sales] > 0), [sales], DESC)
ORDER BY [sales] DESC`; },
    cols: [["item", "LINE[NewItemName]"], ["catdesc", "LINE[CategoryDescription]"], ["optparent", "LINE[OPTION_PARENT_CATEGORY_NAME]"], ["launch", "[launch]"], ["sales", "[sales]"], ["qty", "[qty]"], ["orders", "[orders]"], ["vel", "[vel]"], ["pen", "[pen]"], ["salesprev", "[salesprev]"]],
  },
  // Frequently Bought Together — orders containing the selected item, penetration of co-purchased items
  yp_selected: {
    model: "yelo", single: true,
    dax: (r, q) => { const it = (q.ypitem || "").replace(/"/g, '""').trim(); if (!it) return `EVALUATE ROW("orders", BLANK())`;
      return `EVALUATE ROW("orders", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), 'LINE'[NewItemName] = "${it}", ${ypDateFilter(r)}))`; },
    cols: [["orders", "[orders]"]],
  },
  yp_together: {
    model: "yelo",
    dax: (r, q) => { const it = (q.ypitem || "").replace(/"/g, '""').trim(); if (!it) return `EVALUATE ROW("item", BLANK(), "pen", BLANK(), "tip", BLANK())`;
      return `DEFINE VAR __d = ${ypDateFilter(r)}
  VAR __sel = CALCULATETABLE(VALUES('LINE'[KEY]), 'LINE'[NewItemName] = "${it}", __d)
  VAR __n = COUNTROWS(__sel)
EVALUATE TOPN(30, FILTER(SUMMARIZECOLUMNS('LINE'[NewItemName], __d,
  "tip", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), 'LINE'[KEY] IN __sel), "pen", DIVIDE(CALCULATE(DISTINCTCOUNT('LINE'[KEY]), 'LINE'[KEY] IN __sel), __n)),
  'LINE'[NewItemName] <> "${it}" && [tip] > 0), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[NewItemName]"], ["pen", "[pen]"], ["tip", "[tip]"]],
  },
  // Cross-Sell & Attach — MAIN_ITEM slicer, model's own opportunity + add-on penetration measures
  yp_mainitems: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[MAIN_ITEM]), NOT ISBLANK('LINE'[MAIN_ITEM])) ORDER BY 'LINE'[MAIN_ITEM]`, cols: [["item", "LINE[MAIN_ITEM]"]] },
  // each MAIN_PRODUCT_NAME → its header category (category of the line where the item IS the main product)
  yp_main_cats: {
    model: "yelo",
    dax: () => `EVALUATE SUMMARIZE(FILTER(ALL('LINE'), 'LINE'[NewItemName] = 'LINE'[MAIN_PRODUCT_NAME] && NOT ISBLANK('LINE'[MAIN_PRODUCT_NAME])), 'LINE'[MAIN_PRODUCT_NAME], 'LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME])`,
    cols: [["main", "LINE[MAIN_PRODUCT_NAME]"], ["catdesc", "LINE[CategoryDescription]"], ["optparent", "LINE[OPTION_PARENT_CATEGORY_NAME]"]],
  },
  yp_xa_cards: {
    model: "yelo", single: true,
    dax: (r, q) => { const mf = (q.ypxamain || "").replace(/"/g, '""').trim(); const m = mf && mf !== "All" ? `, 'LINE'[MAIN_ITEM] = "${mf}"` : ""; const d = ypDateFilter(r);
      return `EVALUATE ROW("cross", CALCULATE([Cross Sell Opportunity %], ${d}${m}), "attach", CALCULATE([Attach Opportunity %], ${d}${m}))`; },
    cols: [["cross", "[cross]"], ["attach", "[attach]"]],
  },
  // cross-sell / attach items = share of orders (optionally with a chosen MAIN_ITEM) that
  // include this item in that role. Stable across the "Overall" view (unlike the model's
  // Add-On Penetration %, which needs a single MAIN_ITEM in context) — min 2 orders support.
  yp_crosssell_items: { model: "yelo", dax: (r, q) => ypRoleItems(r, q, "CROSS-SELL"), cols: [["item", "LINE[NewItemName]"], ["pen", "[pen]"], ["tip", "[tip]"]] },
  yp_attach_items: { model: "yelo", dax: (r, q) => ypRoleItems(r, q, "ATTACH"), cols: [["item", "LINE[NewItemName]"], ["pen", "[pen]"], ["tip", "[tip]"]] },
  // Product-mix detail table — NewItemName (size) with qty + WoW/MoM/YoY, amount, mix %, penetration, velocity, orders
  yp_products: {
    model: "yelo",
    // NOTE: no SellingPrice>0 guard here — combo COMPONENT lines are priced 0 but carry
    // real AdjustedQuantity, and the Power BI product-mix breakdown includes them.
    dax: (r, q) => { const p = ypPeriods(r); const sc = ypScope(q); const a = ", __gl" + sc.args; return `DEFINE${p.def}${ypGuardDef}${sc.def}
  VAR __ts = CALCULATE(SUM('LINE'[SalesAmount]), __d${a})
EVALUATE TOPN(3000, FILTER(SUMMARIZECOLUMNS('LINE'[NewItemName], 'LINE'[MAIN_PRODUCT_NAME], 'LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME], __d${a},${pmQuad("qty", "SUM('LINE'[AdjustedQuantity])", p.w, a)},
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a}),
  "mix", DIVIDE(CALCULATE(SUM('LINE'[SalesAmount]), __d${a}), __ts),
  "pen", ${ypPen(a)},
  "vel", CALCULATE(DIVIDE(DISTINCTCOUNT('LINE'[KEY]), DISTINCTCOUNT('LINE'[VoucherDate])), __d${a}),
  "orders", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a})), [qty] > 0), [qty], DESC)
ORDER BY [qty] DESC`; },
    cols: [["item", "LINE[NewItemName]"], ["main", "LINE[MAIN_PRODUCT_NAME]"], ["catdesc", "LINE[CategoryDescription]"], ["optparent", "LINE[OPTION_PARENT_CATEGORY_NAME]"], ...pmQuadCols("qty"), ["sales", "[sales]"], ["mix", "[mix]"], ["pen", "[pen]"], ["vel", "[vel]"], ["orders", "[orders]"]],
  },
  // Size Category (donut)
  yp_size: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[Category], __d${a}, "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}), "inc", CALCULATE([IncidenceRateSizeCategory], __d${a})), [qty] > 0 && NOT(ISBLANK('LINE'[Category])))
ORDER BY [qty] DESC`; },
    cols: [["label", "LINE[Category]"], ["qty", "[qty]"], ["inc", "[inc]"]],
  },
  // Pizza Type / crust (donut + used for trend)
  yp_pizzatype: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[PizzaCategory], __d${a}, "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}), "inc", CALCULATE([IncidenceRateCategory], __d${a})), [qty] > 0 && NOT(ISBLANK('LINE'[PizzaCategory])))
ORDER BY [qty] DESC`; },
    cols: [["label", "LINE[PizzaCategory]"], ["qty", "[qty]"], ["inc", "[inc]"]],
  },
  // Top pizza flavours
  yp_flavours: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE TOPN(15, FILTER(SUMMARIZECOLUMNS('LINE'[PizzaFlavour], __d${a}, "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}), "inc", CALCULATE([IncidenceRate], __d${a})), [qty] > 0 && NOT(ISBLANK('LINE'[PizzaFlavour]))), [qty], DESC)
ORDER BY [qty] DESC`; },
    cols: [["label", "LINE[PizzaFlavour]"], ["qty", "[qty]"], ["inc", "[inc]"]],
  },

  // ==================== PIZZA ANALYSIS (Yelo) ====================
  // The dimensions international pizza teams slice by:
  //   Flavour = 'LINE'[PizzaFlavour]   Size = 'LINE'[Category]   Dough/Crust = 'LINE'[PizzaCategory]
  // All respect the page filter bar via ypScope(q). Sales = SalesAmount, Qty = AdjustedQuantity.
  //
  // Flavour analysis — qty, sales and incidence (share of pizza orders) per flavour.
  yp_pz_flavour: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
  VAR __pz = FILTER(ALL('LINE'[PizzaCategory]), NOT ISBLANK('LINE'[PizzaCategory]))
EVALUATE TOPN(25, FILTER(SUMMARIZECOLUMNS('LINE'[PizzaFlavour], __d, __pz${a},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d, __pz${a}),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d, __pz${a}),
  "inc", CALCULATE([IncidenceRate], __d, __pz${a})), [qty] > 0 && NOT ISBLANK('LINE'[PizzaFlavour])), [sales], DESC)
ORDER BY [sales] DESC`; },
    cols: [["label", "LINE[PizzaFlavour]"], ["qty", "[qty]"], ["sales", "[sales]"], ["inc", "[inc]"]],
  },
  // Size mix — Category, pizza sizes only (Medium / Large / Half&Half…).
  yp_pz_size: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
  VAR __pz = FILTER(ALL('LINE'[PizzaCategory]), NOT ISBLANK('LINE'[PizzaCategory]))
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[Category], __d, __pz${a},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d, __pz${a}),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d, __pz${a})), [qty] > 0 && NOT ISBLANK('LINE'[Category]))
ORDER BY [sales] DESC`; },
    cols: [["label", "LINE[Category]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Crust / dough mix — PizzaCategory (Cheesy / Thin / All For One…).
  yp_pz_dough: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[PizzaCategory], __d${a},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [qty] > 0 && NOT ISBLANK('LINE'[PizzaCategory]))
ORDER BY [sales] DESC`; },
    cols: [["label", "LINE[PizzaCategory]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Flavour × Size — flat rows, pivoted into a matrix client-side.
  yp_pz_flav_size: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[PizzaFlavour], 'LINE'[Category], __d${a},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [qty] > 0 && NOT ISBLANK('LINE'[PizzaFlavour]) && NOT ISBLANK('LINE'[Category]) && CONTAINSSTRING('LINE'[Category], "Pizza"))
ORDER BY [sales] DESC`; },
    cols: [["flavour", "LINE[PizzaFlavour]"], ["size", "LINE[Category]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Flavour × Size × Dough — the three-level breakdown.
  yp_pz_fsd: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[PizzaFlavour], 'LINE'[Category], 'LINE'[PizzaCategory], __d${a},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [qty] > 0 && NOT ISBLANK('LINE'[PizzaFlavour]) && NOT ISBLANK('LINE'[Category]) && NOT ISBLANK('LINE'[PizzaCategory]))
ORDER BY [sales] DESC`; },
    cols: [["flavour", "LINE[PizzaFlavour]"], ["size", "LINE[Category]"], ["dough", "LINE[PizzaCategory]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Pizza grid at full grain (Item × Flavour × Size × Crust) — powers a user-
  // reorderable drilldown (any of Flavour/Size/Crust in any order) AND the flat
  // all-pizzas table. Includes Half&Half (blank flavour → "(Half & Half)").
  yp_pz_grid: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE
  VAR __core = SUMMARIZECOLUMNS('LINE'[NewItemName], 'LINE'[PizzaFlavour], 'LINE'[Category], 'LINE'[PizzaCategory], __d${a},
    "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
    "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a}))
  // a line is a PIZZA when it has a crust: PizzaCategory is not blank. The model
  // only fills PizzaCategory for real pizzas (matches a crust keyword) and leaves
  // it blank for pasta and sides — so this cleanly includes every crust and
  // excludes garlic bread / wedges / wings.
  VAR __f = FILTER(__core, [qty] > 0 && NOT ISBLANK('LINE'[PizzaCategory]))
RETURN SELECTCOLUMNS(__f,
  "item", 'LINE'[NewItemName],
  "flavour", IF(ISBLANK('LINE'[PizzaFlavour]), "—", 'LINE'[PizzaFlavour]),
  "size", IF(ISBLANK('LINE'[Category]), "—", 'LINE'[Category]),
  "crust", IF(ISBLANK('LINE'[PizzaCategory]), "—", 'LINE'[PizzaCategory]),
  "qty", [qty], "sales", [sales])
ORDER BY [sales] DESC`; },
    cols: [["item", "[item]"], ["flavour", "[flavour]"], ["size", "[size]"], ["crust", "[crust]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Half & Half combinations — the two chosen flavours (PIZZA_CHOICE_NAME) on
  // half-and-half pizzas, which don't carry a single PizzaFlavour.
  yp_pz_halfhalf: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[PIZZA_CHOICE_NAME], __d${a},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [qty] > 0 && NOT ISBLANK('LINE'[PIZZA_CHOICE_NAME]) && CONTAINSSTRING('LINE'[Category], "Half"))
ORDER BY [qty] DESC`; },
    cols: [["label", "LINE[PIZZA_CHOICE_NAME]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Flavour-wise daily trend (pizzas only) — DATE × PizzaFlavour, client pivots to
  // a line per flavour.
  yp_pz_flav_trend: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(ypTrailing(r, 30))}${ypGuardDef}${sc.def}
  VAR __pz = FILTER(ALL('LINE'[PizzaCategory]), NOT ISBLANK('LINE'[PizzaCategory]))
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[VoucherDate], 'LINE'[PizzaFlavour], __d, __pz${a},
  "qty", SUM('LINE'[AdjustedQuantity]),
  "sales", SUM('LINE'[SalesAmount])), [qty] > 0 && NOT ISBLANK('LINE'[PizzaFlavour]))
ORDER BY 'LINE'[VoucherDate]`; },
    cols: [["x", "LINE[VoucherDate]"], ["flavour", "LINE[PizzaFlavour]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Crust × Flavour matrix (pizzas only) — for the heatmap.
  yp_pz_flav_crust: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[PizzaFlavour], 'LINE'[PizzaCategory], __d${a},
  "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "sales", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [qty] > 0 && NOT ISBLANK('LINE'[PizzaFlavour]) && NOT ISBLANK('LINE'[PizzaCategory]))`; },
    cols: [["flavour", "LINE[PizzaFlavour]"], ["crust", "LINE[PizzaCategory]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },

  // Menu Item Category breakdown (derived: CategoryDescription → OPTION_PARENT_CATEGORY_NAME when blank)
  yp_menucat: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
  VAR __g = SUMMARIZECOLUMNS('LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME], __d${a}, "q", CALCULATE(SUM('LINE'[AdjustedQuantity])), "s", CALCULATE(SUM('LINE'[SalesAmount])))
  VAR __mic = ADDCOLUMNS(__g, "mic", ${YP_MIC})
  VAR __agg = GROUPBY(__mic, [mic], "qty", SUMX(CURRENTGROUP(), [q]), "sales", SUMX(CURRENTGROUP(), [s]))
EVALUATE TOPN(40, FILTER(__agg, [qty] > 0 && NOT ISBLANK([mic]) && [mic] <> ""), [qty], DESC)
ORDER BY [qty] DESC`; },
    cols: [["label", "[mic]"], ["qty", "[qty]"], ["sales", "[sales]"]],
  },
  // Category Sales Mix — CategoryDescription (menu category) × month, sales-mix % (client-side share of column)
  yp_cat_month: {
    model: "yelo",
    dax: (r, q) => { const mo = ypMonths(r); const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME], __d${a},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SalesAmount]), ${m.filter}${a})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [tot] > 0)
ORDER BY [tot] DESC`; },
    cols: [["catdesc", "LINE[CategoryDescription]"], ["optparent", "LINE[OPTION_PARENT_CATEGORY_NAME]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  // drill level 2: Category → MAIN_PRODUCT_NAME
  yp_cat_month_mains: {
    model: "yelo",
    dax: (r, q) => { const mo = ypMonths(r); const cat = (q.ypdrillcat || "").replace(/"/g, '""'); const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args;
      const catf = cat ? `, FILTER(ALL('LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME]), ${YP_MIC} = "${cat}")` : "";
      return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[MAIN_PRODUCT_NAME], __d${a}${catf},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SalesAmount]), ${m.filter}${a})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [tot] > 0)
ORDER BY [tot] DESC`; },
    cols: [["label", "LINE[MAIN_PRODUCT_NAME]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  // drill level 3: Category (+ Main Product) → NewItemName
  yp_cat_month_items: {
    model: "yelo",
    dax: (r, q) => { const mo = ypMonths(r); const cat = (q.ypdrillcat || "").replace(/"/g, '""'); const main = (q.ypdrillmain || "").replace(/"/g, '""'); const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args;
      const catf = cat ? `, FILTER(ALL('LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME]), ${YP_MIC} = "${cat}")` : "";
      const mainf = main ? `, FILTER(ALL('LINE'[MAIN_PRODUCT_NAME]), 'LINE'[MAIN_PRODUCT_NAME] = "${main}")` : "";
      return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[NewItemName], __d${a}${catf}${mainf},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SalesAmount]), ${m.filter}${a})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SalesAmount]), __d${a})), [tot] > 0)
ORDER BY [tot] DESC`; },
    cols: [["label", "LINE[NewItemName]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  // Combos (ItemGroup)
  yp_combos: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE TOPN(15, FILTER(SUMMARIZECOLUMNS('LINE'[ItemGroup], __d${a}, "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a})), [qty] > 0 && NOT(ISBLANK('LINE'[ItemGroup]))), [qty], DESC)
ORDER BY [qty] DESC`; },
    cols: [["label", "LINE[ItemGroup]"], ["qty", "[qty]"]],
  },
  // Cross-sell / attach gauges
  yp_xsell: {
    model: "yelo", single: true,
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE ROW("crosssell", CALCULATE([Cross Sell Opportunity %], __d${a}), "attach", CALCULATE([Attach Opportunity %], __d${a}), "target", 1)`; },
    cols: [["crosssell", "[crosssell]"], ["attach", "[attach]"], ["target", "[target]"]],
  },
  // Add-on penetration by product (cross-sell page)
  yp_addon: {
    model: "yelo",
    dax: (r, q) => { const sc = ypScope(q); const a = YP_GUARD_ARGS + sc.args; return `DEFINE VAR __d = ${ypDateFilter(r)}${ypGuardDef}${sc.def}
EVALUATE TOPN(20, FILTER(SUMMARIZECOLUMNS('LINE'[NewItemName], __d${a}, "qty", CALCULATE(SUM('LINE'[AdjustedQuantity]), __d${a}),
  "orders", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a}), "pen", CALCULATE([Add On Penetration %], __d${a}),
  "vel", CALCULATE(DIVIDE(DISTINCTCOUNT('LINE'[KEY]), DISTINCTCOUNT('LINE'[VoucherDate])), __d${a})), [qty] > 0), [qty], DESC)
ORDER BY [qty] DESC`; },
    cols: [["item", "LINE[NewItemName]"], ["qty", "[qty]"], ["orders", "[orders]"], ["pen", "[pen]"], ["vel", "[vel]"]],
  },
  // filter-bar value lists (all Yelo slicers)
  yp_l_products: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[NewItemName]), NOT ISBLANK('LINE'[NewItemName])) ORDER BY 'LINE'[NewItemName]`, cols: [["v", "LINE[NewItemName]"]] },
  yp_l_sizes: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[Category]), NOT ISBLANK('LINE'[Category])) ORDER BY 'LINE'[Category]`, cols: [["v", "LINE[Category]"]] },
  yp_l_crusts: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[PizzaCategory]), NOT ISBLANK('LINE'[PizzaCategory])) ORDER BY 'LINE'[PizzaCategory]`, cols: [["v", "LINE[PizzaCategory]"]] },
  yp_l_flavours: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[PizzaFlavour]), NOT ISBLANK('LINE'[PizzaFlavour])) ORDER BY 'LINE'[PizzaFlavour]`, cols: [["v", "LINE[PizzaFlavour]"]] },
  yp_l_sources: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[Ordersource]), NOT ISBLANK('LINE'[Ordersource])) ORDER BY 'LINE'[Ordersource]`, cols: [["v", "LINE[Ordersource]"]] },
  yp_l_types: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[Ordertype]), NOT ISBLANK('LINE'[Ordertype])) ORDER BY 'LINE'[Ordertype]`, cols: [["v", "LINE[Ordertype]"]] },
  yp_l_locations: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[LocationId]), NOT ISBLANK('LINE'[LocationId]) && NOT('LINE'[LocationId] IN {"CAT", "COOP", "CT2"})) ORDER BY 'LINE'[LocationId]`, cols: [["v", "LINE[LocationId]"]] },
  yp_l_groups: { model: "yelo", dax: () => `EVALUATE FILTER(VALUES('LINE'[ItemGroup]), NOT ISBLANK('LINE'[ItemGroup])) ORDER BY 'LINE'[ItemGroup]`, cols: [["v", "LINE[ItemGroup]"]] },
  yp_l_menucats: { model: "yelo", dax: () => `EVALUATE FILTER(DISTINCT(SELECTCOLUMNS(SUMMARIZE('LINE', 'LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME]), "v", ${YP_MIC})), NOT ISBLANK([v]) && [v] <> "") ORDER BY [v]`, cols: [["v", "[v]"]] },

  // ============================ SHARED (ETC PMIX) — one model, many brands via HEADER[CHAINID] ============================
  sh_kpis: {
    model: "shared", single: true,
    dax: (r, q) => { const p = shPeriods(r); const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE${p.def}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE ROW(${pmQuad("qty", "SUM('LINE'[QUANTITY])", p.w, a)},${pmQuad("sales", "SUM('LINE'[SALESAMOUNT])", p.w, a)},${pmQuad("orders", "DISTINCTCOUNT('HEADER'[KEY])", p.w, a)},
  "aov", DIVIDE(CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a}), CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a})),
  "disc", DIVIDE(CALCULATE(SUM('HEADER'[COTDISCOUNTAMOUNT]), __d${a}), CALCULATE(SUM('HEADER'[SUBTOTAL_PRICE]), __d${a})))`; },
    cols: [...pmQuadCols("qty"), ...pmQuadCols("sales"), ...pmQuadCols("orders"), ["aov", "[aov]"], ["disc", "[disc]"]],
  },
  sh_hero: {
    model: "shared",
    dax: (r, q) => { const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
  VAR __to = CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a})
  VAR __ts = CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a})
EVALUATE TOPN(12, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], 'LINE'[Category], __d${a},
  "sales", CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a}), "qty", CALCULATE(SUM('LINE'[QUANTITY]), __d${a}), "orders", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a}),
  "mix", DIVIDE(CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a}), __ts),
  "pen", DIVIDE(CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a}), __to), "vel", CALCULATE(DIVIDE(DISTINCTCOUNT('HEADER'[KEY]), DISTINCTCOUNT('HEADER'[VOUCHERDATE])), __d${a})), [sales] > 0), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["category", "LINE[Category]"], ["sales", "[sales]"], ["qty", "[qty]"], ["orders", "[orders]"], ["mix", "[mix]"], ["pen", "[pen]"], ["vel", "[vel]"]],
  },
  sh_launch_detail: {
    model: "shared",
    dax: (r, q) => { const sc = shScope(q); const a = ", __brand" + sc.args; const e = r.end.split("-").map(Number), lb = addDays(r.start, -30).split("-").map(Number);
      const pLine = `FILTER(ALL('HEADER'[VOUCHERDATE]), ${shBetween(shiftRange(r, -dayCount(r)))})`;
      return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
  VAR __first = SUMMARIZE(ALL('LINE'), 'LINE'[ProductName_Fixed_Option], "f", MIN('LINE'[BUSINESS_DATE]))
  VAR __new = SELECTCOLUMNS(FILTER(__first, [f] >= DATE(${lb[0]}, ${lb[1]}, ${lb[2]}) && [f] <= DATE(${e[0]}, ${e[1]}, ${e[2]})), "p", 'LINE'[ProductName_Fixed_Option], "launch", [f])
EVALUATE TOPN(24, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], 'LINE'[Category], __d${a},
  KEEPFILTERS(TREATAS(SELECTCOLUMNS(__new, "p", [p]), 'LINE'[ProductName_Fixed_Option])),
  "launch", CALCULATE(MINX(FILTER(__new, [p] = SELECTEDVALUE('LINE'[ProductName_Fixed_Option])), [launch])),
  "sales", CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a}), "qty", CALCULATE(SUM('LINE'[QUANTITY]), __d${a}),
  "orders", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a}), "vel", CALCULATE(DIVIDE(DISTINCTCOUNT('HEADER'[KEY]), DISTINCTCOUNT('HEADER'[VOUCHERDATE])), __d${a}),
  "salesprev", CALCULATE(SUM('LINE'[SALESAMOUNT]), ${pLine}${a})),
  [sales] > 0), [sales], DESC)
ORDER BY [sales] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["category", "LINE[Category]"], ["launch", "[launch]"], ["sales", "[sales]"], ["qty", "[qty]"], ["orders", "[orders]"], ["vel", "[vel]"], ["salesprev", "[salesprev]"]],
  },
  // detail (Category → Main Product → Item) — includes 0-price combo components (no price guard)
  sh_products: {
    model: "shared",
    dax: (r, q) => { const p = shPeriods(r); const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE${p.def}${shBrandDef(q)}${sc.def}
  VAR __ts = CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a})
  VAR __tq = CALCULATE(SUM('LINE'[QUANTITY]), __d${a})
EVALUATE TOPN(3000, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], 'LINE'[MAIN_PRODUCT_NAME], 'LINE'[Category], __d${a},
  "mix", DIVIDE(CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a}), __ts),${pmQuad("amt", "SUM('LINE'[SALESAMOUNT])", p.w, a)},
  "qty", CALCULATE(SUM('LINE'[QUANTITY]), __d${a}),
  "qtymix", DIVIDE(CALCULATE(SUM('LINE'[QUANTITY]), __d${a}), __tq)), [qty] > 0), [qty], DESC)
ORDER BY [qty] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["main", "LINE[MAIN_PRODUCT_NAME]"], ["category", "LINE[Category]"], ["mix", "[mix]"], ...pmQuadCols("amt"), ["qty", "[qty]"], ["qtymix", "[qtymix]"]],
  },
  // each MAIN_PRODUCT_NAME → its header category (category of the line where item = main product name)
  sh_main_cats: {
    model: "shared",
    dax: (r, q) => `EVALUATE SUMMARIZE(FILTER(ALL('LINE'), 'LINE'[ProductName_Fixed_Option] = 'LINE'[MAIN_PRODUCT_NAME] && NOT ISBLANK('LINE'[MAIN_PRODUCT_NAME])), 'LINE'[MAIN_PRODUCT_NAME], 'LINE'[Category])`,
    cols: [["main", "LINE[MAIN_PRODUCT_NAME]"], ["category", "LINE[Category]"]],
  },
  sh_menucat: {
    model: "shared",
    dax: (r, q) => { const p = shPeriods(r); const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE${p.def}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE TOPN(40, FILTER(SUMMARIZECOLUMNS('LINE'[Category], __d${a}, "qty", CALCULATE(SUM('LINE'[QUANTITY]), __d${a}),${pmQuad("sales", "SUM('LINE'[SALESAMOUNT])", p.w, a)}, "orders", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a})), [qty] > 0 && NOT ISBLANK('LINE'[Category])), [sales], DESC)
ORDER BY [sales] DESC`; },
    cols: [["label", "LINE[Category]"], ["qty", "[qty]"], ...pmQuadCols("sales"), ["orders", "[orders]"]],
  },
  // Category × Order-Value Bucket (% of orders per NETSALES_BUCKET column)
  sh_cat_bucket: {
    model: "shared",
    dax: (r, q) => { const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[Category], 'HEADER'[NETSALES_BUCKET], __d${a}, "cnt", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a})), [cnt] > 0 && NOT ISBLANK('LINE'[Category]))`; },
    cols: [["category", "LINE[Category]"], ["bucket", "HEADER[NETSALES_BUCKET]"], ["cnt", "[cnt]"]],
  },
  // Category Sales Mix month matrix + 2 drills (Category → Main Product → Item)
  sh_cat_month: {
    model: "shared",
    dax: (r, q) => { const mo = shMonths(r); const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[Category], __d${a},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SALESAMOUNT]), ${m.filter}${a})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a})), [tot] > 0 && NOT ISBLANK('LINE'[Category]))
ORDER BY [tot] DESC`; },
    cols: [["label", "LINE[Category]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  sh_cat_month_mains: {
    model: "shared",
    dax: (r, q) => { const mo = shMonths(r); const cat = (q.shdrillcat || "").replace(/"/g, '""'); const sc = shScope(q); const a = ", __brand" + sc.args;
      const catf = cat ? `, FILTER(ALL('LINE'[Category]), 'LINE'[Category] = "${cat}")` : "";
      return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[MAIN_PRODUCT_NAME], __d${a}${catf},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SALESAMOUNT]), ${m.filter}${a})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a})), [tot] > 0)
ORDER BY [tot] DESC`; },
    cols: [["label", "LINE[MAIN_PRODUCT_NAME]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  sh_cat_month_items: {
    model: "shared",
    dax: (r, q) => { const mo = shMonths(r); const cat = (q.shdrillcat || "").replace(/"/g, '""'); const main = (q.shdrillmain || "").replace(/"/g, '""'); const sc = shScope(q); const a = ", __brand" + sc.args;
      const catf = cat ? `, FILTER(ALL('LINE'[Category]), 'LINE'[Category] = "${cat}")` : "";
      const mainf = main ? `, FILTER(ALL('LINE'[MAIN_PRODUCT_NAME]), 'LINE'[MAIN_PRODUCT_NAME] = "${main}")` : "";
      return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], __d${a}${catf}${mainf},
  ${mo.map((m) => `"${m.key}", CALCULATE(SUM('LINE'[SALESAMOUNT]), ${m.filter}${a})`).join(",\n  ")},
  "tot", CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a})), [tot] > 0)
ORDER BY [tot] DESC`; },
    cols: [["label", "LINE[ProductName_Fixed_Option]"], ...Array.from({ length: 12 }, (_, i) => [`m${i}`, `[m${i}]`]), ["tot", "[tot]"]],
  },
  // HEADER-driven extras (this model has them, unlike Yelo)
  sh_daypart: {
    model: "shared",
    dax: (r, q) => { const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('HEADER'[DAY_PART], __d${a}, "sales", CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a}), "orders", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a})), [sales] > 0)
ORDER BY [sales] DESC`; },
    cols: [["label", "HEADER[DAY_PART]"], ["sales", "[sales]"], ["orders", "[orders]"]],
  },
  sh_buckets: {
    model: "shared",
    dax: (r, q) => { const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('HEADER'[NETSALES_BUCKET], __d${a}, "orders", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a}), "net", CALCULATE(SUM('HEADER'[NET]), __d${a})), [orders] > 0)
ORDER BY 'HEADER'[NETSALES_BUCKET]`; },
    cols: [["label", "HEADER[NETSALES_BUCKET]"], ["orders", "[orders]"], ["net", "[net]"]],
  },
  sh_hourly: {
    model: "shared",
    dax: (r, q) => { const sc = shScope(q); const a = ", __brand" + sc.args; return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}${shPriceGuardDef}${sc.def}
EVALUATE FILTER(SUMMARIZECOLUMNS('HEADER'[HOUR], __d${a}, "orders", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), __d${a}), "sales", CALCULATE(SUM('LINE'[SALESAMOUNT]), __d${a})), [orders] > 0)
ORDER BY 'HEADER'[HOUR]`; },
    cols: [["hour", "HEADER[HOUR]"], ["orders", "[orders]"], ["sales", "[sales]"]],
  },
  // Frequently Bought Together
  sh_selected: {
    model: "shared", single: true,
    dax: (r, q) => { const it = (q.shitem || "").replace(/"/g, '""').trim(); if (!it) return `EVALUATE ROW("orders", BLANK())`;
      return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}
EVALUATE ROW("orders", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), 'LINE'[ProductName_Fixed_Option] = "${it}", __d, __brand))`; },
    cols: [["orders", "[orders]"]],
  },
  sh_together: {
    model: "shared",
    dax: (r, q) => { const it = (q.shitem || "").replace(/"/g, '""').trim(); if (!it) return `EVALUATE ROW("item", BLANK(), "pen", BLANK(), "tip", BLANK())`;
      return `DEFINE VAR __d = ${shDateFilter(r)}${shBrandDef(q)}
  VAR __sel = CALCULATETABLE(VALUES('HEADER'[KEY]), 'LINE'[ProductName_Fixed_Option] = "${it}", __d, __brand)
  VAR __n = COUNTROWS(__sel)
EVALUATE TOPN(30, FILTER(SUMMARIZECOLUMNS('LINE'[ProductName_Fixed_Option], __d, __brand,
  "tip", CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), 'HEADER'[KEY] IN __sel), "pen", DIVIDE(CALCULATE(DISTINCTCOUNT('HEADER'[KEY]), 'HEADER'[KEY] IN __sel), __n)),
  'LINE'[ProductName_Fixed_Option] <> "${it}" && [tip] > 0), [pen], DESC)
ORDER BY [pen] DESC`; },
    cols: [["item", "LINE[ProductName_Fixed_Option]"], ["pen", "[pen]"], ["tip", "[tip]"]],
  },
  // filter-bar value lists (brand-scoped)
  sh_l_products: { model: "shared", dax: (r, q) => `EVALUATE FILTER(DISTINCT(CALCULATETABLE(VALUES('LINE'[ProductName_Fixed_Option]), ${shBrandDefT(q)})), NOT ISBLANK('LINE'[ProductName_Fixed_Option])) ORDER BY 'LINE'[ProductName_Fixed_Option]`, cols: [["v", "LINE[ProductName_Fixed_Option]"]] },
  sh_l_cats: { model: "shared", dax: (r, q) => `EVALUATE FILTER(DISTINCT(CALCULATETABLE(VALUES('LINE'[Category]), ${shBrandDefT(q)})), NOT ISBLANK('LINE'[Category])) ORDER BY 'LINE'[Category]`, cols: [["v", "LINE[Category]"]] },
  sh_l_sources: { model: "shared", dax: (r, q) => `EVALUATE FILTER(DISTINCT(CALCULATETABLE(VALUES('HEADER'[ORDERSOURCE]), ${shBrandDefT(q)})), NOT ISBLANK('HEADER'[ORDERSOURCE])) ORDER BY 'HEADER'[ORDERSOURCE]`, cols: [["v", "HEADER[ORDERSOURCE]"]] },
  sh_l_types: { model: "shared", dax: (r, q) => `EVALUATE FILTER(DISTINCT(CALCULATETABLE(VALUES('HEADER'[ORDERTYPE]), ${shBrandDefT(q)})), NOT ISBLANK('HEADER'[ORDERTYPE])) ORDER BY 'HEADER'[ORDERTYPE]`, cols: [["v", "HEADER[ORDERTYPE]"]] },
  sh_l_locations: { model: "shared", dax: (r, q) => `EVALUATE FILTER(DISTINCT(CALCULATETABLE(VALUES('HEADER'[LOCATIONID]), ${shBrandDefT(q)})), NOT ISBLANK('HEADER'[LOCATIONID])) ORDER BY 'HEADER'[LOCATIONID]`, cols: [["v", "HEADER[LOCATIONID]"]] },
  sh_l_dayparts: { model: "shared", dax: (r, q) => `EVALUATE FILTER(DISTINCT(CALCULATETABLE(VALUES('HEADER'[DAY_PART]), ${shBrandDefT(q)})), NOT ISBLANK('HEADER'[DAY_PART])) ORDER BY 'HEADER'[DAY_PART]`, cols: [["v", "HEADER[DAY_PART]"]] },
  sh_l_buckets: { model: "shared", dax: (r, q) => `EVALUATE FILTER(DISTINCT(CALCULATETABLE(VALUES('HEADER'[NETSALES_BUCKET]), ${shBrandDefT(q)})), NOT ISBLANK('HEADER'[NETSALES_BUCKET])) ORDER BY 'HEADER'[NETSALES_BUCKET]`, cols: [["v", "HEADER[NETSALES_BUCKET]"]] },
};

// ---- Yelo Product Mix DAX helpers (model "yelo": LINE + Calendar, date=LINE[VoucherDate]) ----
const ypBetween = (r) => { const s = r.start.split("-").map(Number), e = r.end.split("-").map(Number); return `'LINE'[VoucherDate] >= DATE(${s[0]}, ${s[1]}, ${s[2]}) && 'LINE'[VoucherDate] < DATE(${e[0]}, ${e[1]}, ${e[2]}) + 1`; };
const ypDateFilter = (r) => `FILTER(ALL('LINE'[VoucherDate]), ${ypBetween(r)})`;
// a trailing N-day window ending at the selected range's end — used by the daily
// trend so it always shows a real line even when the slicer is a single day.
function ypTrailing(r, days) {
  const e = new Date(r.end + "T00:00:00Z");
  const s = new Date(e); s.setUTCDate(s.getUTCDate() - (days - 1));
  return { start: s.toISOString().slice(0, 10), end: r.end };
}
// Item penetration % — SAME logic as BBT's [Item Penetration %] = [Item Orders] / [Total Orders],
// i.e. orders containing the item ÷ total orders in the period (ignoring item/category filters).
// (Yelo's model [IncidenceRate] is a summarizeBy:sum column, so CALCULATE([IncidenceRate]) sums the
//  per-slice rates across day/order-type/order-source and massively over-states it.)
const ypPen = (a) => `DIVIDE(CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a}), CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${a}, REMOVEFILTERS('LINE'[NewItemName], 'LINE'[MAIN_PRODUCT_NAME], 'LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME])))`;
function ypPeriods(range) {
  const n = dayCount(range), cal = calType(range);
  const wR = shiftRange(range, -7), mR = cal ? shiftMonthsR(range, -1) : shiftRange(range, -28), yR = (cal || n >= 30) ? shiftYearsR(range, -1) : shiftRange(range, -364);
  const mk = (nm, rr) => `  VAR ${nm} = ${ypDateFilter(rr)}`;
  return { def: "\n" + [mk("__d", range), mk("__w", wR), mk("__m", mR), mk("__y", yR)].join("\n"), w: n <= 7 };
}
// always-on guards: positive selling price + exclude test/catering locations
// Yelo guard: exclude non-trading locations only. (The SellingPrice > 0 filter was
// removed per request — bundle/component lines with 0 price now count too.)
const ypGuardDef = `\n  VAR __gl = FILTER(ALL('LINE'[LocationId]), NOT('LINE'[LocationId] IN {"CAT", "COOP", "CT2"}))`;
const YP_GUARD_ARGS = ", __gl";
// derived "Menu Item Category" = CategoryDescription, else OPTION_PARENT_CATEGORY_NAME when blank
const YP_MIC = `IF(ISBLANK('LINE'[CategoryDescription]) || TRIM('LINE'[CategoryDescription]) = "", 'LINE'[OPTION_PARENT_CATEGORY_NAME], 'LINE'[CategoryDescription])`;
// Yelo Hero exclusions (admin, same feature as BBT) + NewItemName exclusion predicate
const YP_EXCL_FILE = path.join(__dirname, "data", "yp-exclusions.json");
function loadYpExcl() { try { return JSON.parse(fs.readFileSync(YP_EXCL_FILE, "utf8")); } catch { return { hero: [] }; } }
function saveYpExcl(x) { try { fs.mkdirSync(path.dirname(YP_EXCL_FILE), { recursive: true }); fs.writeFileSync(YP_EXCL_FILE, JSON.stringify(x, null, 2)); } catch {} }
const ypExclPredicate = (list) => (list && list.length ? ` && NOT('LINE'[NewItemName] IN {${list.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(", ")}})` : "");
// every calendar month intersecting the range (capped 12) with a LINE[VoucherDate] filter
function ypMonths(range) {
  const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [sy, sm] = range.start.split("-").map(Number), [ey, em] = range.end.split("-").map(Number);
  const out = []; let y = sy, m = sm, i = 0;
  while ((y < ey || (y === ey && m <= em)) && i < 12) {
    const lo = `DATE(${y},${m},1)`, hi = m === 12 ? `DATE(${y + 1},1,1)` : `DATE(${y},${m + 1},1)`;
    out.push({ key: `m${i}`, label: `${MN[m - 1]} ${y}`, filter: `FILTER(ALL('LINE'[VoucherDate]), 'LINE'[VoucherDate] >= ${lo} && 'LINE'[VoucherDate] < ${hi})` });
    m++; if (m > 12) { m = 1; y++; } i++;
  }
  return out;
}
// ============================ SHARED (ETC PMIX) — multi-brand, model "shared" ============================
// LINE + HEADER, join LINE[ORDER_ID]→HEADER[KEY] (bidirectional). Brand = HEADER[CHAINID].
// date = HEADER[VOUCHERDATE]; qty = SUM(LINE[QUANTITY]); sales = SUM(LINE[SALESAMOUNT]);
// product = LINE[ProductName_Fixed_Option]; category = LINE[Category]; orders = DISTINCTCOUNT(HEADER[KEY]).
// No native PMIX/role measures — everything computed here.
const SH_CHAINS = { "Chilli Pepper": "CHP", "Just C": "BUR", "Pattie Pattie": "PAT", "Slice": "SLC" };
const shBetween = (r) => { const s = r.start.split("-").map(Number), e = r.end.split("-").map(Number); return `'HEADER'[VOUCHERDATE] >= DATE(${s[0]}, ${s[1]}, ${s[2]}) && 'HEADER'[VOUCHERDATE] < DATE(${e[0]}, ${e[1]}, ${e[2]}) + 1`; };
const shDateFilter = (r) => `FILTER(ALL('HEADER'[VOUCHERDATE]), ${shBetween(r)})`;
function shPeriods(range) {
  const n = dayCount(range), cal = calType(range);
  const wR = shiftRange(range, -7), mR = cal ? shiftMonthsR(range, -1) : shiftRange(range, -28), yR = (cal || n >= 30) ? shiftYearsR(range, -1) : shiftRange(range, -364);
  const mk = (nm, rr) => `  VAR ${nm} = ${shDateFilter(rr)}`;
  return { def: "\n" + [mk("__d", range), mk("__w", wR), mk("__m", mR), mk("__y", yR)].join("\n"), w: n <= 7 };
}
// brand (CHAINID) filter — always applied for the selected brand
const shBrandDef = (q) => { const code = (q.shchain || "").replace(/"/g, '""').trim(); return `\n  VAR __brand = FILTER(ALL('HEADER'[CHAINID]), 'HEADER'[CHAINID] = "${code}")`; };
const shBrandDefT = (q) => { const code = (q.shchain || "").replace(/"/g, '""').trim(); return `'HEADER'[CHAINID] = "${code}"`; };
const shPriceGuardDef = `\n  VAR __gp = FILTER(ALL('LINE'[UNIT_PRICE]), 'LINE'[UNIT_PRICE] > 0)`;   // exclude 0-price component lines (revenue visuals only)
function shScope(q) {
  const vars = [], args = [];
  const add = (nm, col, val) => { const v = (val || "").replace(/"/g, '""').trim(); if (v && v !== "All") { vars.push(`  VAR ${nm} = FILTER(ALL(${col}), ${col} = "${v}")`); args.push(nm); } };
  add("__fprod", "'LINE'[ProductName_Fixed_Option]", q.shprod);
  add("__fcat", "'LINE'[Category]", q.shcat);
  add("__fsrc", "'HEADER'[ORDERSOURCE]", q.shsrc);
  add("__ftype", "'HEADER'[ORDERTYPE]", q.shtype);
  add("__floc", "'HEADER'[LOCATIONID]", q.shloc);
  add("__fdp", "'HEADER'[DAY_PART]", q.shdp);
  add("__fbucket", "'HEADER'[NETSALES_BUCKET]", q.shbucket);
  add("__fmain", "'LINE'[MAIN_PRODUCT_NAME]", q.shmain);
  const lo = q.shpmin !== undefined && q.shpmin !== "" ? Number(q.shpmin) : null;
  const hi = q.shpmax !== undefined && q.shpmax !== "" ? Number(q.shpmax) : null;
  if ((lo != null && isFinite(lo)) || (hi != null && isFinite(hi))) {
    const cond = [lo != null ? `'LINE'[UNIT_PRICE] >= ${lo}` : "", hi != null ? `'LINE'[UNIT_PRICE] <= ${hi}` : ""].filter(Boolean).join(" && ");
    vars.push(`  VAR __fprice = FILTER(ALL('LINE'[UNIT_PRICE]), ${cond})`); args.push("__fprice");
  }
  return { def: vars.length ? "\n" + vars.join("\n") : "", args: args.length ? ", " + args.join(", ") : "" };
}
const shMonths = (range) => ypMonthsCol(range, "'HEADER'[VOUCHERDATE]");
// generic month builder used by both Yelo & shared (col-parameterised)
function ypMonthsCol(range, col) {
  const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [sy, sm] = range.start.split("-").map(Number), [ey, em] = range.end.split("-").map(Number);
  const out = []; let y = sy, m = sm, i = 0;
  while ((y < ey || (y === ey && m <= em)) && i < 12) {
    const lo = `DATE(${y},${m},1)`, hi = m === 12 ? `DATE(${y + 1},1,1)` : `DATE(${y},${m + 1},1)`;
    out.push({ key: `m${i}`, label: `${MN[m - 1]} ${y}`, filter: `FILTER(ALL(${col}), ${col} >= ${lo} && ${col} < ${hi})` });
    m++; if (m > 12) { m = 1; y++; } i++;
  }
  return out;
}

// cross-sell / attach items list: % of orders (optionally with a chosen MAIN_ITEM) that
// include this NewItemName in the given ITEM_ROLE, sorted DESC, min-2-order support.
function ypRoleItems(r, q, roleVal) {
  const mf = (q.ypxamain || "").replace(/"/g, '""').trim();
  const mainVar = mf && mf !== "All" ? `\n  VAR __m = FILTER(ALL('LINE'[MAIN_ITEM]), 'LINE'[MAIN_ITEM] = "${mf}")` : "";
  const marg = mf && mf !== "All" ? ", __m" : "";
  return `DEFINE VAR __d = ${ypDateFilter(r)}${mainVar}
  VAR __tot = CALCULATE(DISTINCTCOUNT('LINE'[KEY]), __d${marg}, 'LINE'[SellingPrice] > 0)
EVALUATE TOPN(15, FILTER(SUMMARIZECOLUMNS('LINE'[NewItemName], __d${marg},
  "tip", CALCULATE(DISTINCTCOUNT('LINE'[KEY]), 'LINE'[ITEM_ROLE] = "${roleVal}", 'LINE'[SellingPrice] > 0),
  "pen", DIVIDE(CALCULATE(DISTINCTCOUNT('LINE'[KEY]), 'LINE'[ITEM_ROLE] = "${roleVal}", 'LINE'[SellingPrice] > 0), __tot)),
  [tip] >= 2 && [pen] > 0), [pen], DESC)
ORDER BY [pen] DESC`;
}
// Yelo filter bar → DEFINE VARs + a ", __f.." arg string (all on LINE columns)
function ypScope(q) {
  const vars = [], args = [];
  const add = (nm, col, val) => { const v = (val || "").replace(/"/g, '""').trim(); if (v && v !== "All") { vars.push(`  VAR ${nm} = FILTER(ALL(${col}), ${col} = "${v}")`); args.push(nm); } };
  add("__fprod", "'LINE'[NewItemName]", q.ypprod);
  add("__fsize", "'LINE'[Category]", q.ypsize);
  add("__fcrust", "'LINE'[PizzaCategory]", q.ypcrust);
  add("__fflav", "'LINE'[PizzaFlavour]", q.ypflav);
  add("__fsrc", "'LINE'[Ordersource]", q.ypsrc);
  add("__ftype", "'LINE'[Ordertype]", q.yptype);
  add("__floc", "'LINE'[LocationId]", q.yploc);
  add("__fgrp", "'LINE'[ItemGroup]", q.ypgrp);
  add("__fmain", "'LINE'[MAIN_ITEM]", q.ypmain);
  // Menu Item Category is a derived (CategoryDescription→OPTION fallback) → filter over both columns
  const mv = (q.ypmenucat || "").replace(/"/g, '""').trim();
  if (mv && mv !== "All") { vars.push(`  VAR __fmenu = FILTER(ALL('LINE'[CategoryDescription], 'LINE'[OPTION_PARENT_CATEGORY_NAME]), ${YP_MIC} = "${mv}")`); args.push("__fmenu"); }
  const lo = q.yppmin !== undefined && q.yppmin !== "" ? Number(q.yppmin) : null;
  const hi = q.yppmax !== undefined && q.yppmax !== "" ? Number(q.yppmax) : null;
  if ((lo != null && isFinite(lo)) || (hi != null && isFinite(hi))) {
    const cond = [lo != null ? `'LINE'[SellingPrice] >= ${lo}` : "", hi != null ? `'LINE'[SellingPrice] <= ${hi}` : ""].filter(Boolean).join(" && ");
    vars.push(`  VAR __fprice = FILTER(ALL('LINE'[SellingPrice]), ${cond})`); args.push("__fprice");
  }
  return { def: vars.length ? "\n" + vars.join("\n") : "", args: args.length ? ", " + args.join(", ") : "" };
}

function mapViz(v, rows) {
  const one = (r) => Object.fromEntries(v.cols.map(([as, key]) => [as, r[key]]));
  return v.single ? (rows[0] ? one(rows[0]) : {}) : rows.map(one);
}
// map result rows to the clean shape AND pass through any EXTRA measure columns the
// admin added via the visual editor (columns present in the DAX result but not in v.cols).
// Returns { mapped, extraCols } so the frontend can render newly-added measures live.
function mapVizDynamic(v, rows) {
  const known = new Set(v.cols.map((c) => c[1]));
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const extras = keys.filter((k) => !known.has(k) && k.startsWith("[") && !k.startsWith("[__VFM")); // measure aliases, minus hidden filter-only cols
  const clean = (k) => k.replace(/^\[|\]$/g, "");
  const one = (r) => {
    const o = Object.fromEntries(v.cols.map(([as, key]) => [as, r[key]]));
    for (const k of extras) o[clean(k)] = r[k];
    return o;
  };
  const mapped = v.single ? (rows[0] ? one(rows[0]) : {}) : rows.map(one);
  return { mapped, extraCols: extras.map((k) => ({ key: clean(k), label: clean(k) })) };
}

// ================================ ROUTES ====================================
app.get("/api/status", (_req, res) => res.json({ source: LIVE ? "live" : "mock" }));

// resolve a preset/range server-side (so the UI label matches the query window)
app.get("/api/range", (req, res) => res.json(rangeFromReq(req.query)));

// brands the logged-in user may pick — restricted to their scope (server-enforced).
app.get("/api/brands", requireAuth, async (req, res) => {
  try {
    const scope = allowedBrands(req.user);
    if (scope !== "all") return res.json({ brands: scope });   // exactly their brands, nothing else
    if (!LIVE) return res.json({ brands: [] });
    const dax = `EVALUATE FILTER(VALUES('Brand Table'[Brand Full Name]), NOT('Brand Table'[Brand Full Name] IN {BLANK()})) ORDER BY 'Brand Table'[Brand Full Name]`;
    const rows = await runDax(dax);
    res.json({ brands: rows.map((r) => r["Brand Table[Brand Full Name]"]).filter(Boolean) });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// brand → locations tree for the admin scoping UI (unscoped list of the whole model).
app.get("/api/admin/scopetree", requireAdmin, async (_req, res) => {
  try {
    if (!LIVE) return res.json({ tree: [] });
    CURRENT.user = { role: "admin", scope: { brands: "all", locations: "all" } };
    CURRENT.brand = null;
    const dax = `EVALUATE FILTER(SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], 'LocationMaster'[Location], "N", CALCULATE(SUM('SALES DATA'[NET]))), [N] > 0) ORDER BY 'Brand Table'[Brand Full Name], 'LocationMaster'[Location]`;
    const rows = await runDax(dax);
    const map = {};
    for (const r of rows) {
      const b = r["Brand Table[Brand Full Name]"], l = r["LocationMaster[Location]"];
      if (!b || !l) continue;
      (map[b] = map[b] || []).push(l);
    }
    res.json({ tree: Object.entries(map).map(([brand, locations]) => ({ brand, locations })) });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// ============================================================================
//  MATERIALIZED VIZ CACHE — stale-while-revalidate + background sync
//  Power BI serializes executeQueries at ~0.7s each, so querying it on the user
//  request path is the fundamental bottleneck. Instead we treat Power BI as a
//  slow source of truth and serve every read from an in-memory materialized
//  cache:
//    • A read returns the cached payload INSTANTLY (even if stale) and, if the
//      entry is past its freshness window, schedules a background refresh.
//    • A background worker keeps "hot" keys (used recently) fresh, so an active
//      user's views are refreshed for them before they ask again.
//    • The cache is persisted to disk, so a restart reloads warm instead of
//      cold, and the hot keys are re-synced in the background on boot.
//  Net effect: after the first time a (visual, range, brand, scope) combo is
//  ever seen, every subsequent read is a <10ms memory hit — Power BI is never
//  on the user's critical path again.
//  (This is the "Materialized Cache → Fast API → React" architecture; an
//  external Redis would be the same pattern but with a network hop — only worth
//  it for multi-instance/shared deployments. See notes at the endpoints.)
// ============================================================================
const VIZ_FRESH_MS = Number(process.env.VIZ_FRESH_MS) || 5 * 60_000;   // refresh in background once older than this
const VIZ_HOT_MS = Number(process.env.VIZ_HOT_MS) || 60 * 60_000;      // keep syncing keys used within the last hour
const VIZ_SYNC_EVERY = Number(process.env.VIZ_SYNC_EVERY) || 90_000;   // background sweep cadence
const VIZ_MAX_ENTRIES = Number(process.env.VIZ_MAX_ENTRIES) || 4000;
const VIZ_REFRESH_CONCURRENCY = Number(process.env.VIZ_REFRESH_CONCURRENCY) || 2;   // gentle on Power BI (it serializes anyway)
// Power BI serializes executeQueries (6 concurrent ≈ 6 sequential; higher
// throttles), so batch fan-out uses a small pool — it just avoids the >6 penalty.
const VIZ_BATCH_CONCURRENCY = Number(process.env.VIZ_BATCH_CONCURRENCY) || 4;
const PREWARM_HOUR = Number(process.env.PREWARM_HOUR ?? 6);   // local hour to pre-warm before business
const CACHE_FILE = path.join(__dirname, "data", `viz-cache.v${CACHE_VERSION}.json`);
const persistence = createPersistence({ diskFile: CACHE_FILE, redisUrl: process.env.REDIS_URL, log: console.log });

const vizCache = new Map();       // key -> { key, payload, ts, lastHit, hits, lastError, lastMs, meta }
const vizInflight = new Map();    // key -> Promise<payload> (cold-miss dedup)
// priority queue for background work — lower prio number runs first:
//   PRIO.HOT (0) user-triggered SWR refresh · PRIO.PREWARM (5) scheduled warm-up
const PRIO = { HOT: 0, PREWARM: 5 };
const refreshQ = [];              // [{ key, prio, meta, attempts }]
const queued = new Set();
let refreshActive = 0;
let liveInflight = 0;             // # of user-facing cold-miss queries running right now
// ---- observability -------------------------------------------------------
const perf = {
  hits: 0, misses: 0, refreshes: 0, refreshFails: 0,
  slowest: new Map(),             // name -> { maxMs, lastMs, count }
  apiMs: [],                      // ring buffer of recent API response times
  lastRefreshAt: null, lastError: null,
  prewarm: { total: 0, done: 0, startedAt: null, finishedAt: null, running: false, lastRunLabel: null },
};
const recordApiMs = (ms) => { perf.apiMs.push(ms); if (perf.apiMs.length > 300) perf.apiMs.shift(); };
const recordQueryMs = (name, ms) => { const s = perf.slowest.get(name) || { maxMs: 0, lastMs: 0, count: 0 }; s.lastMs = ms; s.count++; if (ms > s.maxMs) s.maxMs = ms; perf.slowest.set(name, s); };

// Two users with the same data scope share cache entries — and pre-warming
// (run as a synthetic all-brands admin) thereby warms the cache for every real
// admin/CEO user. Captures exactly what changes DAX results (brand/location
// filter + role class). RLS is the token owner's for everyone (device-code), so
// scope is the only per-user differentiator.
function scopeSig(user) {
  const roleClass = user.role === "area" ? "area" : (user.role === "gm" || user.role === "marketing") ? "brand" : "all";
  const brands = user.scope && user.scope.brands && user.scope.brands !== "all" ? [...user.scope.brands].sort().join(",") : "all";
  const locs = user.scope && user.scope.locations && user.scope.locations !== "all" ? JSON.stringify(user.scope.locations) : "all";
  return `${roleClass}|${brands}|${locs}`;
}

// The effective model for a request. Product Mix visuals are multi-brand: the
// brand dropdown (or an explicit &model=) selects which brand's semantic model
// to query. All other visuals always use their own model.
function effModel(name, query) {
  const base = (VIZ[name] && VIZ[name].model) || "main";
  if (base !== "productmix") return base;
  const bm = brandModels();
  const byBrand = query && query.brand && bm[query.brand];
  const byParam = query && query.model && MODELS[query.model] ? query.model : null;
  return byBrand || byParam || base;
}

// short hash of a visual's definition (dax source + columns), computed once. Baked
// into the cache key so that EDITING a query automatically invalidates its cached
// results — no more manual cache clears / stale numbers after a query change.
const _vizDefHash = new Map();
function vizDefHash(name) {
  if (_vizDefHash.has(name)) return _vizDefHash.get(name);
  const v = VIZ[name];
  const src = v ? String(v.dax || "") + "|" + JSON.stringify(v.cols || "") : "";
  let h = 0; for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  const hx = (h >>> 0).toString(36);
  _vizDefHash.set(name, hx);
  return hx;
}
function vizKey(name, user, query) {
  const roleKey = user.role === "area" ? "area" : (user.role === "gm" || user.role === "marketing") ? "gm" : "ceo";
  const asRole = (user.role === "admin" && query.asRole) ? query.asRole : roleKey;
  const range = rangeFromReq(query);
  // include EVERY result-affecting param (cross-filters, dims, etc.), sorted, so
  // a filtered view never collides with an unfiltered one. Date/role captured
  // via range/asRole; scope captured via scopeSig — skip their raw forms.
  const skip = new Set(["preset", "start", "end", "date", "asRole", "names", "brand"]);
  const xf = Object.keys(query).filter((p) => !skip.has(p) && query[p] != null && query[p] !== "").sort()
    .map((p) => `${p}=${query[p]}`).join("&");
  const model = effModel(name, query);   // prefix so the brands/datasets never collide in cache
  return { key: `${model}::${name}|${vizDefHash(name)}|${scopeSig(user)}|${asRole}|${range.start}|${range.end}|${query.brand || ""}|${xf}`, asRole, range };
}

// the actual Power BI work for one visual — NO caching. Throws on failure.
async function vizWork(name, user, query, asRole, range, priority = 0) {
  const v = VIZ[name];
  if (!v) throw new Error("unknown visual");
  if (!LIVE) return v.single ? { row: {} } : { rows: [] };
  const t0 = Date.now();
  CURRENT.user = user;                 // set synchronously right before the (sync) DAX build
  CURRENT.brand = query.brand || null;
  const ovr = getVizOverride(name, asRole);
  const dax = ovr ? refreshOverrideScope(ovr, range) : v.dax(range, query);
  const model = effModel(name, query);
  if (process.env.LOG_VIZ) console.log(`[viz] ${name} ${range.start}→${range.end}${ovr ? " (override)" : ""}${model !== "productmix" && model !== "main" ? " model=" + model : ""}${query.brand ? " brand=" + query.brand : ""}`);
  const rows = await runDax(dax, model, { priority });
  const { mapped, extraCols } = mapVizDynamic(v, rows);
  recordQueryMs(name, Date.now() - t0);
  return v.single ? { row: mapped, extraCols } : { rows: mapped, extraCols };
}

function cacheSet(key, payload, meta) {
  const e = vizCache.get(key) || { key, hits: 0 };
  e.payload = payload; e.ts = Date.now(); e.lastHit = e.lastHit || Date.now(); e.meta = meta; e.lastError = null;
  vizCache.set(key, e);
  if (vizCache.size > VIZ_MAX_ENTRIES) {           // evict least-recently-hit
    const oldest = [...vizCache.values()].sort((a, b) => a.lastHit - b.lastHit).slice(0, vizCache.size - VIZ_MAX_ENTRIES);
    for (const o of oldest) vizCache.delete(o.key);
  }
}

// ---- priority background queue with retry/backoff ------------------------
function enqueue(key, prio, meta) {
  const existing = refreshQ.find((it) => it.key === key);
  if (existing) { if (prio < existing.prio) existing.prio = prio; return; }  // upgrade priority if hotter
  if (queued.has(key)) return;
  queued.add(key); refreshQ.push({ key, prio, meta: meta || null, attempts: 0 });
  drainRefresh();
}
function takeNext() {                                // pick the lowest-prio (hottest) item
  if (!refreshQ.length) return null;
  let bi = 0; for (let i = 1; i < refreshQ.length; i++) if (refreshQ[i].prio < refreshQ[bi].prio) bi = i;
  return refreshQ.splice(bi, 1)[0];
}
function drainRefresh() {
  while (refreshActive < VIZ_REFRESH_CONCURRENCY && refreshQ.length) {
    // Yield to live users: while any user-facing (cold-miss) query is running,
    // don't start background PREWARM work — it competes for Power BI capacity and
    // makes on-demand loads (e.g. a fresh month/all range) crawl. HOT refreshes
    // still run. Deferred prewarm resumes when liveInflight returns to 0.
    if (liveInflight > 0) {
      const hottest = refreshQ.reduce((m, it) => (it.prio < m ? it.prio : m), Infinity);
      if (hottest >= PRIO.PREWARM) break;
    }
    const item = takeNext(); if (!item) break;
    queued.delete(item.key);
    const meta = item.meta || (vizCache.get(item.key) && vizCache.get(item.key).meta);
    if (!meta) continue;
    const { name, user, query } = meta;
    // Recompute the key HERE, not at enqueue time: for preset queries (yesterday/
    // today/…) the resolved date range — and thus the cache key — can change between
    // when the job was queued and when it runs (e.g. the date rolls past midnight).
    // The value is computed for the current range, so it MUST be stored under the
    // current key, or a preset ends up serving the wrong day's cached data.
    const { key: freshKey, asRole, range } = vizKey(name, user, query);
    refreshActive++;
    vizWork(name, user, query, asRole, range, 5)   // background: capped so it never starves live users
      .then((payload) => { cacheSet(freshKey, payload, meta); perf.refreshes++; perf.lastRefreshAt = Date.now(); })
      .catch((err) => {
        perf.refreshFails++; perf.lastError = String(err.message).slice(0, 200);
        const e = vizCache.get(freshKey); if (e) e.lastError = perf.lastError;
        if (item.attempts < 3) {                     // retry with exponential backoff (throttling-friendly)
          item.attempts++;
          setTimeout(() => { queued.add(item.key); refreshQ.push(item); drainRefresh(); }, 1000 * 2 ** item.attempts).unref();
        }
      })
      .finally(() => { refreshActive--; drainRefresh(); });
  }
}

// PUBLIC getter — stale-while-revalidate. Instant on any previously-seen key.
async function computeViz(name, user, query) {
  if (!VIZ[name]) throw new Error("unknown visual");
  const { key } = vizKey(name, user, query);
  const e = vizCache.get(key);
  if (e && e.payload !== undefined) {
    e.lastHit = Date.now(); e.hits = (e.hits || 0) + 1; perf.hits++;
    if (Date.now() - e.ts > VIZ_FRESH_MS) enqueue(key, PRIO.HOT);   // refresh behind the scenes, high priority
    return e.payload;                                               // serve immediately, even if stale
  }
  perf.misses++;
  if (vizInflight.has(key)) return await vizInflight.get(key);      // dedupe concurrent cold misses
  const { asRole, range } = vizKey(name, user, query);
  liveInflight++;                                                   // signal prewarm to back off
  const work = vizWork(name, user, query, asRole, range)
    .then((payload) => { cacheSet(key, payload, { name, user, query }); return payload; })
    .finally(() => { vizInflight.delete(key); liveInflight--; if (liveInflight === 0) drainRefresh(); });
  vizInflight.set(key, work);
  return await work;
}

// Drop every cached scope/role/date entry for a visual so the next request
// recomputes it fresh (with a newly-saved/reverted override). The `|` after the
// name prevents matching longer names (e.g. pm_cat vs pm_cat_month).
function invalidateViz(name) {
  let n = 0;
  for (const key of [...vizCache.keys()]) if (key.includes(`::${name}|`)) { vizCache.delete(key); queued.delete(key); n++; }
  const idx = refreshQ.length; for (let i = idx - 1; i >= 0; i--) if (refreshQ[i].key.includes(`::${name}|`)) refreshQ.splice(i, 1);
  if (n) cachePersist();   // keep disk snapshot in sync so a reboot won't reload stale
  return n;
}

// ---- persistence (disk or Redis) ----------------------------------------
async function cachePersist() {
  const hot = [...vizCache.values()].filter((e) => Date.now() - e.lastHit < VIZ_HOT_MS)
    .map((e) => ({ key: e.key, payload: e.payload, ts: e.ts, lastHit: e.lastHit, hits: e.hits, meta: e.meta }));
  await persistence.persist(hot);
}
async function cacheLoad() {
  try {
    const arr = await persistence.load();
    // Do NOT reload cached values whose date range touches TODAY or YESTERDAY: a value
    // captured while that day was still filling in stays partial (e.g. yesterday reading
    // 646 instead of 87k once the day completed). Drop them so they recompute fresh.
    const today = kuwaitToday(), yest = addDays(today, -1);
    const recent = (key) => key.includes("|" + today + "|") || key.includes("|" + yest + "|");
    let skipped = 0;
    for (const e of arr) { if (recent(e.key)) { skipped++; continue; } vizCache.set(e.key, e); }
    console.log(`  [cache] warm-loaded ${vizCache.size} visuals from ${persistence.backend}${skipped ? ` (skipped ${skipped} today/yesterday entries → recompute fresh)` : ""}`);
    if (LIVE) for (const e of vizCache.values()) enqueue(e.key, PRIO.PREWARM);   // re-sync gently on boot
  } catch { /* no cache yet */ }
}

// ============================================================================
//  PRE-WARMING — make the app fast BEFORE users arrive
//  Runs as a synthetic all-brands admin (whose scopeSig matches real admins/CEOs)
//  over the critical pages × common date ranges. Enqueued at PREWARM priority so
//  real user requests always preempt it. Runs on boot and daily before business.
// ============================================================================
const PREWARM_USER = { id: "__prewarm", email: "prewarm@system", name: "Prewarm", role: "admin", scope: { brands: "all", locations: "all" } };
const PREWARM_PAGES = {
  landing: ["landing_head", "landing_ops", "landing_hourly", "landing_brand_matrix", "landing_channel_matrix", "landing_story", "landing_ops_branches", "landing_branch_matrix", "landing_ops_matrix"],
  overview: ["landing_head", "ov_hourly", "ov_profile", "ov_daily", "ov_heatmap", "ov_branches", "ov_channels", "ov_channel_series", "ov_channel_hourly", "ov_buckets", "ov_compare", "ov_compare_dim", "ov_sections", "ov_deepdive"],
  operations: ["ops_kpis", "ops_extra_kpis", "ops_trend_hourly", "ops_trend_daily", "ops_by_location", "ops_channel_complaints", "ops_complaint_cat", "ops_prep_buckets", "ops_delivery_buckets", "ops_delivery_daily", "ops_busy_reason", "ops_hidden_items", "ops_hidden_loc", "ops_hidden_brand", "ops_complaints_hourly"],
  runrate: ["rr_kpis", "rr_daily"],
  productmix: ["pm_kpis", "pm_launch_detail", "pm_hero", "pm_category", "pm_bestsellers", "pm_daypart", "pm_hourly", "pm_cat_month", "pm_cat_detail", "pm_cat_bucket", "pm_xa_cards", "pm_products", "pm_mainitems", "pm_categories", "pm_sources", "pm_locations"],
};
function prewarmMonthRange() {
  const t = kuwaitToday(), y = +t.slice(0, 4), m = +t.slice(5, 7), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p2 = (x) => String(x).padStart(2, "0");
  return { start: `${y}-${p2(m)}-01`, end: `${y}-${p2(m)}-${p2(last)}` };
}
// the common ranges (bounded — Power BI serializes, so the full cross-product of
// every range×brand is infeasible; we warm the defaults + most-used windows).
function prewarmRanges() {
  // warm EVERY calendar preset so any picker choice is already cached (≤2s), plus
  // the current full-month range used by Runrate.
  return [
    { label: "yesterday", q: { preset: "yesterday" } },
    { label: "today", q: { preset: "today" } },
    { label: "last7", q: { preset: "last7" } },
    { label: "thisWeek", q: { preset: "thisWeek" } },
    { label: "lastWeek", q: { preset: "lastWeek" } },
    { label: "thisMonth", q: { preset: "thisMonth" } },
    { label: "lastMonth", q: { preset: "lastMonth" } },
    { label: "currentMonth", q: { preset: "custom", ...prewarmMonthRange() } },
  ];
}
// Distinct data scopes across real users. Two users with the same scope share
// cache entries, so warming ONE synthetic user per distinct scope warms the
// cache for all 300 users — not just the all-brands admin. Bounded so a large
// tenant can't fan out into thousands of Power BI queries.
const PREWARM_MAX_SCOPES = Number(process.env.PREWARM_MAX_SCOPES) || 6;
function prewarmUsers() {
  const users = [PREWARM_USER];         // always warm the all-brands (CEO/GM/admin) scope
  try {
    const seen = new Set([scopeSig(PREWARM_USER)]);
    for (const u of activeUsers()) {
      const su = { id: u.id, email: u.email, name: "prewarm", role: u.role, scope: u.scope || {} };
      const sig = scopeSig(su);
      if (seen.has(sig)) continue;      // this scope is already covered
      seen.add(sig);
      users.push(su);
      if (users.length >= PREWARM_MAX_SCOPES) break;
    }
  } catch { /* users store unavailable — warm the default scope only */ }
  return users;
}
// distinct brand names (the landing brand dropdown). Fetched once and reused so
// we can warm each brand's landing view — otherwise every brand switch is a cold
// open (each brand is its own cache key via query.brand).
let _prewarmBrands = null;
async function prewarmBrands() {
  if (_prewarmBrands) return _prewarmBrands;
  try {
    CURRENT.user = PREWARM_USER; CURRENT.brand = null;
    const rows = await runDax(`EVALUATE FILTER(VALUES('Brand Table'[Brand Full Name]), NOT('Brand Table'[Brand Full Name] IN {BLANK()})) ORDER BY 'Brand Table'[Brand Full Name]`);
    _prewarmBrands = rows.map((r) => r["Brand Table[Brand Full Name]"]).filter(Boolean);
  } catch { _prewarmBrands = []; }
  return _prewarmBrands;
}
function buildPrewarmJobs(brands = []) {
  const jobs = [];
  const ranges = prewarmRanges();
  const users = prewarmUsers();
  for (const user of users) {
    if (user === PREWARM_USER) {
      // the all-brands scope (CEO/GM/admin) gets the FULL warm across every page.
      // Warm the pages users hit first (landing, operations) BEFORE the rest, and
      // the default "yesterday" range before other ranges, so the common views are
      // ready soonest instead of waiting behind overview/productmix.
      const pageOrder = ["landing", "operations", "runrate", "overview", "productmix"];
      const rangeOrder = ["yesterday", "today", "last7", "thisMonth", "thisWeek", "lastWeek", "lastMonth", "currentMonth"];
      const sortedRanges = [...ranges].sort((a, b) => rangeOrder.indexOf(a.label) - rangeOrder.indexOf(b.label));
      // Product Mix is ALWAYS brand-scoped (each brand → its own Power BI model), so
      // warm it PER BRAND — otherwise only the default model (BBT) ever gets cached and
      // every other brand's pmix is a cold ~11s open. Limit to the ranges that carry
      // data so we don't burn the slow pmix models on empty windows.
      const pmBrands = Object.entries(brandModels()).filter(([, mdl]) => ["productmix", "mm", "tabel", "shakir"].includes(mdl)).map(([b]) => b);
      const pmRangeLabels = new Set(["yesterday", "thisMonth", "currentMonth", "last7"]);
      for (const page of pageOrder) {
        const names = PREWARM_PAGES[page]; if (!names) continue;
        if (page === "productmix") {
          const pmRanges = sortedRanges.filter((r) => pmRangeLabels.has(r.label));
          for (const brand of pmBrands) for (const r of pmRanges) for (const name of names) jobs.push({ name, query: { ...r.q, brand }, user });
          continue;
        }
        const useRanges = page === "runrate" ? sortedRanges.filter((r) => r.label === "currentMonth") : sortedRanges;
        for (const r of useRanges) for (const name of names) jobs.push({ name, query: r.q, user });
      }
      // Warm every brand's LANDING page at the default (yesterday) + this-month
      // ranges. A brand switch is the most common CEO/GM action and each brand is
      // a distinct cache key (query.brand), so without this each switch is a cold
      // open. Bounded to two ranges × landing so it can't fan out into thousands.
      const brandRangeLabels = new Set(["yesterday", "thisMonth"]);
      const brandRanges = sortedRanges.filter((r) => brandRangeLabels.has(r.label));
      for (const brand of brands) for (const r of brandRanges) for (const name of PREWARM_PAGES.landing)
        jobs.push({ name, query: { ...r.q, brand }, user });
      // Warm the main pages (landing + operations + overview) for each of the last N
      // individual days (all-brands) so picking a recent specific date off the calendar
      // is instant on ANY dashboard, not just landing. Operations is the heaviest page,
      // so warming it here is where users feel the delay most. Bounded to N days × the
      // recent-day page set; low priority, so the reserved-slot gate keeps live users
      // unaffected while these warm in the background.
      const RECENT_DAYS = Number(process.env.PREWARM_RECENT_DAYS) || 14;
      const RECENT_PAGES = ["landing", "operations", "overview"];
      const recentNames = [...new Set(RECENT_PAGES.flatMap((p) => PREWARM_PAGES[p] || []))];
      const t0 = kuwaitToday();
      for (let i = 1; i <= RECENT_DAYS; i++) {
        const d = addDays(t0, -i);
        for (const name of recentNames) jobs.push({ name, query: { preset: "custom", start: d, end: d }, user });
      }
    } else {
      // Per-user scopes get only the LANDING page at the default (yesterday) range —
      // the first thing they see. Warming every page × range for each scope on boot
      // floods Power BI (it serializes ~0.7s/query) and throttles live traffic.
      const dflt = ranges.find((r) => r.label === "yesterday") || ranges[0];
      for (const name of PREWARM_PAGES.landing) jobs.push({ name, query: dflt.q, user });
    }
  }
  return jobs;
}
async function runPrewarm(label = "boot") {
  if (!LIVE || perf.prewarm.running) return;
  const brands = await prewarmBrands();
  const jobs = buildPrewarmJobs(brands);
  perf.prewarm = { total: jobs.length, done: 0, startedAt: Date.now(), finishedAt: null, running: true, lastRunLabel: label };
  console.log(`  [prewarm] ${label}: warming ${jobs.length} visual×range combos in background…`);
  for (const j of jobs) {
    const u = j.user || PREWARM_USER;
    const { key } = vizKey(j.name, u, j.query);
    const meta = { name: j.name, user: u, query: j.query };
    // only warm if missing or stale (don't re-fetch fresh entries)
    const e = vizCache.get(key);
    if (e && e.payload !== undefined && Date.now() - e.ts < VIZ_FRESH_MS) { perf.prewarm.done++; continue; }
    enqueue(key, PRIO.PREWARM, meta);
  }
  // mark finished when the queue drains (poll cheaply)
  const check = setInterval(() => {
    perf.prewarm.done = Math.min(perf.prewarm.total, Math.max(0, perf.prewarm.total - refreshQ.filter((it) => it.prio === PRIO.PREWARM).length));
    if (!refreshQ.some((it) => it.prio === PRIO.PREWARM) && refreshActive === 0) {
      perf.prewarm.running = false; perf.prewarm.finishedAt = Date.now(); perf.prewarm.done = perf.prewarm.total;
      clearInterval(check);
      console.log(`  [prewarm] ${label}: complete in ${Math.round((perf.prewarm.finishedAt - perf.prewarm.startedAt) / 1000)}s`);
    }
  }, 2000);
  check.unref();
}

if (LIVE) {
  setInterval(() => {                                  // background sweep + persist
    const now = Date.now();
    for (const e of vizCache.values())
      if (now - e.lastHit < VIZ_HOT_MS && now - e.ts > VIZ_FRESH_MS) enqueue(e.key, PRIO.HOT);
    cachePersist();
  }, VIZ_SYNC_EVERY).unref();
  // scheduled daily pre-warm before business hours (checks every 10 min)
  let lastPrewarmDay = "";
  let lastSeenDay = kuwaitToday();
  setInterval(() => {
    const now = new Date(), hr = Number(now.toLocaleString("en-US", { timeZone: "Asia/Kuwait", hour: "2-digit", hour12: false }));
    const day = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kuwait" });
    // On the midnight rollover, drop any cached entry for the new today/yesterday — the
    // old "today" was partial and must not be served as the completed "yesterday".
    if (day !== lastSeenDay) {
      lastSeenDay = day; const yest = addDays(day, -1);
      for (const key of [...vizCache.keys()]) if (key.includes("|" + day + "|") || key.includes("|" + yest + "|")) { vizCache.delete(key); queued.delete(key); }
      console.log(`  [cache] date rolled to ${day} — cleared today/yesterday entries`);
    }
    if (hr === PREWARM_HOUR && day !== lastPrewarmDay) { lastPrewarmDay = day; runPrewarm("scheduled"); }
  }, 10 * 60_000).unref();
  cacheLoad().then(() => setTimeout(() => runPrewarm("boot"), 4000));   // warm shortly after boot
}

// bounded-concurrency map so a batch never fires more than `limit` DAX queries
// at Power BI at once (avoids capacity throttling).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// Tab 2 / Runrate visuals. GET /api/viz/:name?preset=|start=&end=|brand=
// private: results are RLS-scoped, so never let a shared proxy/CDN cache them.
// A short max-age lets each browser serve repeat navigations from its own cache
// (0 network) while stale-while-revalidate keeps it feeling instant — this is the
// biggest lever for 300 users, who navigate the same pages repeatedly.
const VIZ_HTTP_CACHE = process.env.VIZ_HTTP_CACHE || "private, max-age=20, stale-while-revalidate=120";
app.get("/api/viz/:name", requireAuth, async (req, res) => {
  if (!VIZ[req.params.name]) return res.status(400).json({ error: "unknown visual" });
  const t0 = Date.now();
  try { res.set("Cache-Control", VIZ_HTTP_CACHE); res.json(await computeViz(req.params.name, req.user, req.query)); recordApiMs(Date.now() - t0); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Batched fetch — one HTTP request for many visuals. Collapses a page's ~26
// widget fetches into a single round-trip (dodging the browser's ~6
// connections-per-origin limit) and fans them out server-side with a
// concurrency cap. Cold visuals return { cold: true } so the client can show a
// skeleton for just that section and poll, instead of blocking the whole page.
// GET /api/viz-batch?names=a,b,c&preset=…|start=&end=|brand=[&nowait=1]
app.get("/api/viz-batch", requireAuth, async (req, res) => {
  const names = String(req.query.names || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
  if (!names.length) return res.status(400).json({ error: "no names" });
  const t0 = Date.now();
  const results = {};
  await mapLimit(names, VIZ_BATCH_CONCURRENCY, async (n) => {
    try { results[n] = await computeViz(n, req.user, req.query); }
    catch (e) { results[n] = { error: String(e.message) }; }
  });
  recordApiMs(Date.now() - t0);
  res.set("Cache-Control", VIZ_HTTP_CACHE);
  res.json({ results });
});

// ---- observability & cache control (admin) -------------------------------
function perfSnapshot() {
  const total = perf.hits + perf.misses;
  const apiMs = perf.apiMs;
  const avg = apiMs.length ? Math.round(apiMs.reduce((a, b) => a + b, 0) / apiMs.length) : 0;
  const sorted = [...apiMs].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  const slowest = [...perf.slowest.entries()].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.maxMs - a.maxMs).slice(0, 12);
  const topKeys = [...vizCache.values()].sort((a, b) => (b.hits || 0) - (a.hits || 0)).slice(0, 15)
    .map((e) => ({ key: e.key, hits: e.hits || 0, ageMs: Date.now() - e.ts, err: e.lastError || null }));
  const failing = [...vizCache.values()].filter((e) => e.lastError).slice(0, 10).map((e) => ({ key: e.key, err: e.lastError }));
  return {
    version: CACHE_VERSION, backend: persistence.backend, entries: vizCache.size,
    hits: perf.hits, misses: perf.misses, hitRate: total ? +(perf.hits / total * 100).toFixed(1) : 0,
    bgRefreshes: perf.refreshes, refreshFails: perf.refreshFails, lastError: perf.lastError,
    queued: refreshQ.length, refreshing: refreshActive,
    lastRefreshAt: perf.lastRefreshAt, avgApiMs: avg, p95ApiMs: p95, sampledRequests: apiMs.length,
    prewarm: perf.prewarm, config: { VIZ_FRESH_MS, VIZ_HOT_MS, VIZ_SYNC_EVERY, VIZ_REFRESH_CONCURRENCY, PREWARM_HOUR },
    slowestQueries: slowest, topKeys, failing,
    models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, {
      workspaceId: m.workspaceId, datasetId: m.datasetId || null,
      cachedEntries: [...vizCache.keys()].filter((k) => k.startsWith(id + "::")).length,
    }])),
  };
}
app.get("/api/admin/perf", requireAdmin, (_req, res) => res.json(perfSnapshot()));
app.get("/api/admin/cache-stats", requireAdmin, (_req, res) => res.json(perfSnapshot()));  // legacy alias

// ---- BUSINESS EVENT CALENDAR (§7) ----------------------------------------
// Powers occasion-day alignment (Eid Day 1 vs Eid Day 1) instead of raw Gregorian
// dates. Seeded dates are marked "estimated" and MUST be confirmed by an admin
// before the UI treats them as authoritative — an unconfirmed Eid date silently
// shifting a year-on-year comparison is exactly the kind of error that destroys
// trust in the numbers.
const EVENTS_FILE = path.join(__dirname, "data", "business-events.json");
function loadEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8")); } catch { return { events: SEED_EVENTS }; }
}
function saveEvents(x) {
  try { fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true }); fs.writeFileSync(EVENTS_FILE, JSON.stringify(x, null, 2)); } catch {}
}
// Seeded from published Kuwait observance dates. ALL start as estimated.
const SEED_EVENTS = [
  { id: "eid-fitr-2026", name: "Eid Al Fitr", type: "Religious", country: "KW", year: 2026, start: "2026-03-20", end: "2026-03-22", status: "estimated", notes: "", active: true },
  { id: "eid-fitr-2025", name: "Eid Al Fitr", type: "Religious", country: "KW", year: 2025, start: "2025-03-30", end: "2025-04-01", status: "estimated", notes: "", active: true },
  { id: "eid-adha-2026", name: "Eid Al Adha", type: "Religious", country: "KW", year: 2026, start: "2026-05-27", end: "2026-05-30", status: "estimated", notes: "", active: true },
  { id: "eid-adha-2025", name: "Eid Al Adha", type: "Religious", country: "KW", year: 2025, start: "2025-06-06", end: "2025-06-09", status: "estimated", notes: "", active: true },
  { id: "ramadan-2026", name: "Ramadan", type: "Religious", country: "KW", year: 2026, start: "2026-02-18", end: "2026-03-19", status: "estimated", notes: "", active: true },
  { id: "ramadan-2025", name: "Ramadan", type: "Religious", country: "KW", year: 2025, start: "2025-03-01", end: "2025-03-29", status: "estimated", notes: "", active: true },
  { id: "national-2026", name: "National & Liberation Day", type: "National", country: "KW", year: 2026, start: "2026-02-25", end: "2026-02-26", status: "estimated", notes: "", active: true },
  { id: "national-2025", name: "National & Liberation Day", type: "National", country: "KW", year: 2025, start: "2025-02-25", end: "2025-02-26", status: "estimated", notes: "", active: true },
];
const eventDays = (e) => Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86400000) + 1;

// any signed-in user can READ the calendar (the Compare page needs it)
app.get("/api/events", requireAuth, (_req, res) => {
  const { events } = loadEvents();
  res.json({ events: (events || []).filter((e) => e.active !== false).map((e) => ({ ...e, days: eventDays(e) })) });
});
// admin-only write
app.get("/api/admin/events", requireAdmin, (_req, res) => {
  const { events } = loadEvents();
  res.json({ events: (events || []).map((e) => ({ ...e, days: eventDays(e) })) });
});
app.put("/api/admin/events", requireAdmin, (req, res) => {
  const list = Array.isArray(req.body?.events) ? req.body.events : null;
  if (!list) return res.status(400).json({ error: "events array required" });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const e of list) {
    if (!e.id || !e.name || !iso.test(e.start || "") || !iso.test(e.end || "")) {
      return res.status(400).json({ error: `invalid event: ${e.id || e.name || "unnamed"} — id, name and ISO start/end are required` });
    }
    if (Date.parse(e.end) < Date.parse(e.start)) return res.status(400).json({ error: `${e.name}: end date is before start date` });
    if (!["estimated", "confirmed"].includes(e.status)) e.status = "estimated";
  }
  saveEvents({ events: list });
  logAudit(req.user?.email || "admin", "business-events", `${list.length} events`, `${list.filter((e) => e.status === "confirmed").length} confirmed`);
  res.json({ ok: true, events: list.map((e) => ({ ...e, days: eventDays(e) })) });
});

// ---- multi-model discovery / schema (admin) ------------------------------
app.get("/api/admin/models", requireAdmin, (_req, res) => res.json({ models: MODELS }));
// update a model's dataset ID (Power BI dataset GUID) from the website + test the connection
app.put("/api/admin/models/:model", requireAdmin, async (req, res) => {
  const key = req.params.model; const m = MODELS[key];
  if (!m) return res.status(400).json({ error: "unknown model" });
  const ds = String((req.body && req.body.datasetId) || "").trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(ds))
    return res.status(400).json({ error: "Dataset ID must be a GUID (e.g. 4926d818-0098-4699-8384-29a2bd435630)" });
  const prev = m.datasetId; m.datasetId = ds; saveModelsConfig();
  vizCache.clear(); await persistence.clear();                    // new dataset → drop cached results
  logAudit(req.user.email, "model-dataset", key, `${prev || "—"} → ${ds}`);
  let test = { ok: true };
  try { await runDax(`EVALUATE ROW("ok", 1)`, key); } catch (e) { test = { ok: false, error: String(e.message || e) }; }
  res.json({ ok: true, model: key, datasetId: ds, test });
});
// discover a model's schema (tables / measures / columns) — used to map the
// Product Mix page to real measures before writing DAX
app.get("/api/admin/model-schema/:model", requireAdmin, async (req, res) => {
  const model = req.params.model;
  if (!MODELS[model]) return res.status(400).json({ error: "unknown model" });
  try {
    const datasetId = await discoverDataset(model);
    // INFO.VIEW.* returns friendly names; fall back to INFO.* if unavailable
    const tryDax = async (dax) => { try { return await runDax(dax, model); } catch { return null; } };
    const tv = await tryDax("EVALUATE INFO.VIEW.TABLES()") || await tryDax("EVALUATE INFO.TABLES()") || [];
    const mv = await tryDax("EVALUATE INFO.VIEW.MEASURES()") || await tryDax("EVALUATE INFO.MEASURES()") || [];
    const cv = await tryDax("EVALUATE INFO.VIEW.COLUMNS()") || [];
    const pick = (row, ...keys) => { for (const k of keys) if (row["[" + k + "]"] != null) return row["[" + k + "]"]; return null; };
    res.json({
      model, workspaceId: MODELS[model].workspaceId, datasetId,
      tables: tv.map((t) => pick(t, "Name")).filter(Boolean),
      measures: mv.map((m) => ({ name: pick(m, "Name"), table: pick(m, "Table", "TableID"), expr: String(pick(m, "Expression") || "").replace(/\s+/g, " ").slice(0, 240) })).filter((m) => m.name),
      columns: cv.map((c) => ({ table: pick(c, "Table"), name: pick(c, "Name", "ExplicitName"), type: pick(c, "Data Type", "DataType") })).filter((c) => c.name),
    });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// run an arbitrary EVALUATE against a model (admin, for schema exploration/testing)
app.post("/api/admin/model-dax/:model", requireAdmin, async (req, res) => {
  if (!MODELS[req.params.model]) return res.status(400).json({ error: "unknown model" });
  try { res.json({ rows: await runDax(req.body && req.body.dax, req.params.model) }); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// Product Mix admin exclusions (e.g. Hero list) — saved globally, applied for all users
app.get("/api/admin/pm-exclusions", requireAdmin, (_req, res) => res.json(loadPmExcl()));
app.post("/api/admin/pm-exclusions", requireAdmin, (req, res) => {
  const x = { hero: Array.isArray(req.body && req.body.hero) ? req.body.hero.slice(0, 500) : [] };
  savePmExcl(x);
  for (const key of [...vizCache.keys()]) if (key.startsWith("productmix::pm_hero")) vizCache.delete(key);   // apply immediately
  res.json({ ok: true, ...x });
});
app.get("/api/admin/yp-exclusions", requireAdmin, (_req, res) => res.json(loadYpExcl()));
app.post("/api/admin/yp-exclusions", requireAdmin, (req, res) => {
  const x = { hero: Array.isArray(req.body && req.body.hero) ? req.body.hero.slice(0, 500) : [] };
  saveYpExcl(x);
  for (const key of [...vizCache.keys()]) if (key.startsWith("yelo::yp_hero")) vizCache.delete(key);   // apply immediately
  res.json({ ok: true, ...x });
});
// ---- LocationMaster mapping: audit every raw branch value across the 7 source tables ----
app.get("/api/admin/locations/audit", requireAdmin, async (_req, res) => {
  try {
    const mrows = await runDax(`EVALUATE SELECTCOLUMNS(LocationMaster, "id", LocationMaster[LocationID], "loc", LocationMaster[Location])`, "main");
    const master = mrows.map((r) => ({ id: String(r["[id]"] ?? "").trim(), loc: String(r["[loc]"] ?? "").trim() })).filter((m) => m.id || m.loc);
    const masterIds = new Set(master.map((m) => m.id.toLowerCase()));
    const masterLocs = new Set(master.map((m) => m.loc.toLowerCase()));
    const store = loadLocMap();
    const ov = normalizedOverrides();
    const added = Array.isArray(store.added) ? store.added : [];
    const allLocs = [...master, ...added].filter((v, i, a) => a.findIndex((x) => x.id.toLowerCase() === v.id.toLowerCase()) === i);
    const findLoc = (pred) => allLocs.find(pred) || null;
    const rows = [];
    for (const s of LOC_SOURCES) {
      let drows = [];
      try { drows = await runDax(`EVALUATE SUMMARIZECOLUMNS(${s.col}, "n", CALCULATE(COUNTROWS(${s.table})))`, "main"); }
      catch { drows = []; }
      for (const r of drows) {
        const valKey = Object.keys(r).find((k) => k !== "[n]");
        const raw = r[valKey];
        if (raw == null || String(raw).trim() === "") continue;
        const v = String(raw).trim();
        const matched = s.type === "id" ? masterIds.has(v.toLowerCase()) : masterLocs.has(v.toLowerCase());
        const ovId = ov[`${s.type}::${v.toLowerCase()}`] || null;
        const mappedTo = ovId ? findLoc((x) => x.id.toLowerCase() === ovId.toLowerCase())
          : (matched ? (s.type === "id" ? findLoc((x) => x.id.toLowerCase() === v.toLowerCase()) : findLoc((x) => x.loc.toLowerCase() === v.toLowerCase())) : null);
        rows.push({ source: s.key, sourceLabel: s.label, type: s.type, value: v, count: Number(r["[n]"]) || 0, modelMatch: matched, overrideId: ovId, mapped: !!(matched || ovId), mappedTo });
      }
    }
    rows.sort((a, b) => (a.mapped - b.mapped) || (b.count - a.count));   // unmapped first, then by volume
    res.json({ master: allLocs, sources: LOC_SOURCES.map((s) => ({ key: s.key, label: s.label, type: s.type })), rows });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// assign / clear a mapping for one raw value (global: applies to every table that value appears in)
app.post("/api/admin/locations/map", requireAdmin, (req, res) => {
  const { type, value, locationId } = req.body || {};
  if (!type || value == null) return res.status(400).json({ error: "type + value required" });
  const store = loadLocMap(); store.overrides = store.overrides || {};
  const k = `${type}::${String(value).trim().toLowerCase()}`;
  if (locationId) store.overrides[k] = String(locationId); else delete store.overrides[k];
  saveLocMap(store);
  logAudit(req.user.email, "location-map", `${type}:${value}`, locationId ? `→ ${locationId}` : "cleared");
  res.json({ ok: true });
});
// Apply: activate the app-side aliases and clear the cache so location visuals recompute.
// NOTE: nothing is ever written to LocationMaster — aliases live only in this app.
app.post("/api/admin/locations/apply", requireAdmin, async (req, res) => {
  try {
    const store = loadLocMap();
    const count = Object.keys(store.overrides || {}).length;
    vizCache.clear(); await persistence.clear();   // drop cached visuals so they re-query with aliases applied
    logAudit(req.user?.email || "admin", "location-apply", `${count} aliases`, "cache cleared");
    res.json({ ok: true, count });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// add a new canonical location (app-side; used in the mapping dropdown)
app.post("/api/admin/locations/add", requireAdmin, (req, res) => {
  const id = String((req.body && req.body.locationId) || "").trim();
  const loc = String((req.body && req.body.location) || "").trim();
  if (!id || !loc) return res.status(400).json({ error: "LocationID and Location name required" });
  const store = loadLocMap(); store.added = Array.isArray(store.added) ? store.added : [];
  if (store.added.some((a) => a.id.toLowerCase() === id.toLowerCase())) return res.status(400).json({ error: "That LocationID already exists" });
  store.added.push({ id, loc }); saveLocMap(store);
  logAudit(req.user.email, "location-add", id, loc);
  res.json({ ok: true, id, loc });
});

// ---- Home pins: visuals a user pinned to their home from the ⋮ menu ----------
const HOME_PINS_FILE = path.join(__dirname, "data", "home-pins.json");
function loadHomePins() { try { return JSON.parse(fs.readFileSync(HOME_PINS_FILE, "utf8")); } catch { return {}; } }
function saveHomePins(x) { try { fs.mkdirSync(path.dirname(HOME_PINS_FILE), { recursive: true }); fs.writeFileSync(HOME_PINS_FILE, JSON.stringify(x, null, 2)); } catch {} }
app.get("/api/home/pins", requireAuth, (req, res) => res.json({ pins: (loadHomePins()[req.user.id]) || [] }));
app.post("/api/home/pins", requireAuth, (req, res) => {
  const { viz, label, page, html, col, brand } = req.body || {};
  if (!viz) return res.status(400).json({ error: "viz required" });
  const all = loadHomePins(); let list = all[req.user.id] || [];
  // a pin is unique per (viz, brand) so BBT and Chilli Pepper of the same visual can coexist
  const key = `${viz}::${brand || "all"}`;
  const rec = { viz: String(viz), key, label: String(label || viz), page: page || null, brand: brand || "all", col: [4, 6, 8, 12].includes(col) ? col : 12, html: typeof html === "string" ? html.slice(0, 220000) : "" };
  list = list.filter((p) => (p.key || `${p.viz}::${p.brand || "all"}`) !== key);   // re-pin refreshes
  list.unshift(rec);
  all[req.user.id] = list.slice(0, 40); saveHomePins(all);
  res.json({ ok: true });
});
app.delete("/api/home/pins/:key", requireAuth, (req, res) => {
  const k = req.params.key;
  const all = loadHomePins();
  all[req.user.id] = (all[req.user.id] || []).filter((p) => (p.key || `${p.viz}::${p.brand || "all"}`) !== k && p.viz !== k);
  saveHomePins(all);
  res.json({ ok: true });
});

// ---- Operational targets: Ops Director sets per-store, per-KPI targets --------
const OPS_KPIS = [
  { key: "prep", label: "Avg Prep Time", lower: true, unit: "min" },
  { key: "delivery", label: "Avg Delivery Time", lower: true, unit: "min" },
  { key: "complaint", label: "Complaint Ratio", lower: true, unit: "pct" },
  { key: "offline", label: "Offline Rate", lower: true, unit: "pct" },
  { key: "rating", label: "Rating", lower: false, unit: "num" },
];
const OPS_KPI_KEYS = new Set(OPS_KPIS.map((k) => k.key));
const OPS_TARGETS_FILE = path.join(__dirname, "data", "ops-targets.json");
function loadOpsTargets() { try { return JSON.parse(fs.readFileSync(OPS_TARGETS_FILE, "utf8")); } catch { return {}; } }
function saveOpsTargets(x) { try { fs.mkdirSync(path.dirname(OPS_TARGETS_FILE), { recursive: true }); fs.writeFileSync(OPS_TARGETS_FILE, JSON.stringify(x, null, 2)); } catch {} }
// anyone signed in can READ the targets (managers see them); only Ops Director/admin can SET
app.get("/api/ops-targets", requireAuth, (_req, res) => res.json({ kpis: OPS_KPIS, targets: loadOpsTargets() }));
app.put("/api/ops-targets", requireOpsDirector, (req, res) => {
  const { location, kpi, value } = req.body || {};
  if (!location || !OPS_KPI_KEYS.has(kpi)) return res.status(400).json({ error: "location + valid kpi required" });
  const all = loadOpsTargets(); const loc = String(location).trim();
  all[loc] = all[loc] || {};
  if (value === null || value === "" || value === undefined) delete all[loc][kpi];
  else { const n = Number(value); if (!isFinite(n) || n < 0) return res.status(400).json({ error: "value must be a non-negative number" }); all[loc][kpi] = n; }
  if (!Object.keys(all[loc]).length) delete all[loc];
  saveOpsTargets(all);
  logAudit(req.user.email, "ops-target", `${loc} · ${kpi}`, value == null || value === "" ? "cleared" : String(value));
  res.json({ ok: true, targets: all });
});

// ---- WORKING HOURS + computed OFFLINE RATE -------------------------------
// Admin/Ops-Director enter operating hours/day per brand+branch. The company
// offline rate = Σ busy minutes / Σ (hours × 60 × trading days) across every
// brand+branch that traded in the period. Branches with no hours entered use a
// configurable default (and are flagged) so the number is never blank.
const WORKING_HOURS_FILE = path.join(__dirname, "data", "working-hours.json");
const DEFAULT_WORKING_HOURS = 14;
function loadWorkingHours() { try { const j = JSON.parse(fs.readFileSync(WORKING_HOURS_FILE, "utf8")); return { hours: j.hours || {}, times: j.times || {}, default: Number(j.default) || DEFAULT_WORKING_HOURS }; } catch { return { hours: {}, times: {}, default: DEFAULT_WORKING_HOURS }; } }
function saveWorkingHours(x) { try { fs.mkdirSync(path.dirname(WORKING_HOURS_FILE), { recursive: true }); fs.writeFileSync(WORKING_HOURS_FILE, JSON.stringify(x, null, 2)); } catch {} }
const whKey = (brand, loc) => `${String(brand).trim()}::${String(loc).trim()}`;
// "12:00 PM" / "1:30 AM" -> decimal hour; open+close -> hours/day (crosses midnight).
function timeToHour(s) { const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp])[Mm]$/); if (!m) return null; let h = Number(m[1]) % 12; if (/p/i.test(m[3])) h += 12; return h + Number(m[2]) / 60; }
function hoursFromOpenClose(open, close) { const o = timeToHour(open), c0 = timeToHour(close); if (o == null || c0 == null) return null; let c = c0; if (c <= o) c += 24; return Math.round((c - o) * 2) / 2; }

app.get("/api/ops-working-hours", requireAuth, (_req, res) => res.json(loadWorkingHours()));
app.put("/api/ops-working-hours", requireOpsDirector, (req, res) => {
  const { brand, location, hours, open, close, default: def } = req.body || {};
  const wh = loadWorkingHours(); wh.times = wh.times || {};
  if (def !== undefined && def !== null && def !== "") {
    const n = Number(def); if (!isFinite(n) || n <= 0 || n > 24) return res.status(400).json({ error: "default must be 1-24 hours" });
    wh.default = n; saveWorkingHours(wh); logAudit(req.user.email, "working-hours-default", "default", String(n));
    return res.json({ ok: true, ...wh });
  }
  if (!brand || !location) return res.status(400).json({ error: "brand + location required" });
  const k = whKey(brand, location);
  if (open !== undefined || close !== undefined) {         // override by open/close times → derive hours
    if (!open && !close) { delete wh.hours[k]; delete wh.times[k]; }
    else {
      const h = hoursFromOpenClose(open, close);
      if (h == null || h <= 0 || h > 24) return res.status(400).json({ error: "invalid open/close times (use e.g. 11:00 AM / 03:30 AM)" });
      wh.hours[k] = h; wh.times[k] = { open, close };
    }
  } else if (hours === null || hours === "" || hours === undefined) { delete wh.hours[k]; delete wh.times[k]; }
  else { const n = Number(hours); if (!isFinite(n) || n <= 0 || n > 24) return res.status(400).json({ error: "hours must be 1-24" }); wh.hours[k] = n; delete wh.times[k]; }
  saveWorkingHours(wh);
  logAudit(req.user.email, "working-hours", k, open || close ? `${open || "?"}–${close || "?"}` : (hours == null || hours === "" ? "cleared" : String(hours)));
  res.json({ ok: true, ...wh });
});

// ---- Monthly AOV targets (per brand) — the base for deriving Orders targets.
// Orders Target = Sales Target (from the model) / AOV Target (set here). Stored as
// { months: { "YYYY-MM": { "<brand full name>": aov } } }. Ops-director/admin only.
const AOV_TARGETS_FILE = path.join(__dirname, "data", "aov-targets.json");
function loadAovTargets() { try { const j = JSON.parse(fs.readFileSync(AOV_TARGETS_FILE, "utf8")); return { months: j.months || {} }; } catch { return { months: {} }; } }
function saveAovTargets(x) { try { fs.mkdirSync(path.dirname(AOV_TARGETS_FILE), { recursive: true }); fs.writeFileSync(AOV_TARGETS_FILE, JSON.stringify(x, null, 2)); } catch {} }
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ""));

// key: brand-level = "<brand>"; channel override = "<brand>::<channel>"
const aovKey = (brand, channel) => (channel ? `${String(brand).trim()}::${String(channel).trim()}` : String(brand).trim());
app.get("/api/aov-targets", requireAuth, (_req, res) => res.json(loadAovTargets()));
app.put("/api/aov-targets", requireOpsDirector, (req, res) => {
  const { month, brand, channel, aov } = req.body || {};
  if (!isMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  if (!brand) return res.status(400).json({ error: "brand required" });
  const t = loadAovTargets();
  const m = t.months[month] || (t.months[month] = {});
  const k = aovKey(brand, channel);
  if (aov === null || aov === "" || aov === undefined) delete m[k];
  else { const n = Number(aov); if (!isFinite(n) || n <= 0 || n > 1000) return res.status(400).json({ error: "aov must be 0-1000" }); m[k] = n; }
  if (!Object.keys(m).length) delete t.months[month];
  saveAovTargets(t);
  logAudit(req.user.email, "aov-target", `${k} ${month}`, aov == null || aov === "" ? "cleared" : String(aov));
  res.json({ ok: true, ...t });
});

// trailing-6-month actual AOV per brand and per brand×channel — the default target
// baseline (admin overrides win). RLS auto-scopes to the user's brands. This query is
// heavy (~30s) and only changes daily, so results are cached in-memory per user+brand+day.
const _aovBaseCache = new Map();   // key -> { day, map }
app.get("/api/aov-baseline", requireAuth, async (req, res) => {
  if (!LIVE) return res.json({ map: {} });
  const brandParam = req.query.brand && req.query.brand !== "all" ? req.query.brand : "";
  const day = new Date().toISOString().slice(0, 10);
  const ckey = `${req.user.email}|${brandParam}`;
  const hit = _aovBaseCache.get(ckey);
  if (hit && hit.day === day) return res.json({ map: hit.map, cached: true });
  try {
    CURRENT.user = req.user;
    CURRENT.brand = brandParam || null;
    // Scope enforcement: brandFilterVar() restricts to the user's allowed brands (and
    // narrows to the requested brand within that scope) — an out-of-scope brand yields
    // nothing. Built synchronously here, before the await, so CURRENT can't interleave.
    const dax = `DEFINE
  VAR __end = TODAY()
  VAR __start = EDATE(TODAY(), -6)
  VAR __d = FILTER(ALL('DATETABLE'[DATE]), 'DATETABLE'[DATE] >= __start && 'DATETABLE'[DATE] <= __end)
  VAR __brand = ${brandFilterVar()}
EVALUATE SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], 'BusinessesTable'[OrdersourceName], __d, __brand,
  "N", CALCULATE(SUM('SALES DATA'[NET])), "O", CALCULATE('Append1'[Count of Orders]))`;
    const rows = await runDax(dax);
    const brandAgg = {}, cellAgg = {};
    for (const r of rows || []) {
      const b = r["Brand Table[Brand Full Name]"]; const c = r["BusinessesTable[OrdersourceName]"];
      const n = Number(r["[N]"]) || 0, o = Number(r["[O]"]) || 0;
      if (!b) continue;
      (brandAgg[b] = brandAgg[b] || { n: 0, o: 0 }); brandAgg[b].n += n; brandAgg[b].o += o;
      if (c) { const k = `${b}::${c}`; (cellAgg[k] = cellAgg[k] || { n: 0, o: 0 }); cellAgg[k].n += n; cellAgg[k].o += o; }
    }
    const map = {};
    for (const [b, v] of Object.entries(brandAgg)) if (v.o) map[b] = v.n / v.o;
    for (const [k, v] of Object.entries(cellAgg)) if (v.o) map[k] = v.n / v.o;
    for (const [k, v] of _aovBaseCache) if (v.day !== day) _aovBaseCache.delete(k);   // drop stale-day entries
    _aovBaseCache.set(ckey, { day, map });
    res.json({ map });
  } catch (e) { res.json({ map: {}, error: String(e && e.message || e) }); }
});

// distinct order-source channels (for the brand×channel target editor)
app.get("/api/channels", requireAuth, async (req, res) => {
  if (!LIVE) return res.json({ channels: [] });
  try {
    CURRENT.user = req.user; CURRENT.brand = null;
    const rows = await runDax(`EVALUATE DISTINCT(SELECTCOLUMNS('BusinessesTable', "v", 'BusinessesTable'[OrdersourceName])) ORDER BY [v]`);
    const channels = (rows || []).map((r) => r["[v]"]).filter(Boolean);
    res.json({ channels });
  } catch (e) { res.json({ channels: [], error: String(e && e.message || e) }); }
});

// computed offline rate for the current period + brand scope (RLS enforced)
app.get("/api/ops-offline", requireAuth, async (req, res) => {
  const wh = loadWorkingHours();
  if (!LIVE) return res.json({ rate: null, byBranch: [], missing: [], default: wh.default });
  try {
    CURRENT.user = req.user;                                                    // RLS
    CURRENT.brand = req.query.brand && req.query.brand !== "all" ? req.query.brand : null;
    const range = rangeFromReq(req.query);
    const v = VIZ.ops_offline_calc;
    const rows = mapViz(v, await runDax(v.dax(range, { rb: req.query.rb })));   // offline = BUSY TIME → only Responsible-Party(Busy) applies
    let totBusy = 0, totAvail = 0; const byBranch = []; const missing = [];
    // Availability is measured across EVERY available brand×location combination for the
    // whole selected period: working hours × 60 × (days in the selected period) — not just
    // the days a store happened to trade. So offline time on non-trading days counts too.
    const periodDays = dayCount(range);
    for (const r of rows) {
      const busyMin = Number(r.busyMin) || 0;
      const k = whKey(r.brand, r.location);
      const hasHours = wh.hours[k] != null;
      const hrs = hasHours ? Number(wh.hours[k]) : wh.default;
      const availMin = hrs * 60 * periodDays;
      if (!hasHours) missing.push({ brand: r.brand, location: r.location });
      totBusy += busyMin; totAvail += availMin;
      const tm = (wh.times || {})[k] || {};
      byBranch.push({ brand: r.brand, location: r.location, busyMin: Math.round(busyMin), days: periodDays, tradedDays: Number(r.salesDays) || 0, hours: hrs, open: tm.open || null, close: tm.close || null, defaulted: !hasHours, availMin: Math.round(availMin), rate: availMin > 0 ? busyMin / availMin : null });
    }
    byBranch.sort((a, b) => (b.rate || 0) - (a.rate || 0));
    res.json({ rate: totAvail > 0 ? totBusy / totAvail : null, totBusyMin: Math.round(totBusy), totAvailMin: Math.round(totAvail), byBranch, missing, default: wh.default });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// distinct values for the Operations page filters (Validation + Responsible Party)
let opsFiltersCache = null;
app.get("/api/ops-filters", requireAuth, async (req, res) => {
  if (!LIVE) return res.json({ validation: { complaints: ["Valid", "InValid"], hidden: [] }, responsible: { complaints: [], busy: [], hidden: [] } });
  if (opsFiltersCache && Date.now() - opsFiltersCache.ts < 10 * 60 * 1000) return res.json(opsFiltersCache.data);
  try {
    CURRENT.user = req.user; CURRENT.brand = null;
    const distinct = async (col) => {
      try { return (await runDax(`EVALUATE SELECTCOLUMNS(FILTER(VALUES(${col}), NOT ISBLANK(${col})), "v", ${col}) ORDER BY [v]`)).map((r) => r["[v]"]).filter((v) => v != null && String(v).trim() !== ""); }
      catch { return []; }
    };
    const [vComp, vHid, rComp, rBusy, rHid] = await Promise.all([
      distinct("'Complaints'[Validation]"), distinct("'HIDEN'[Validation]"),
      distinct("'Complaints'[Responsible Party]"), distinct("'BUSY TIME'[RESPONSIBLE_PARTY]"), distinct("'HIDEN'[Responsible Party]"),
    ]);
    const data = { validation: { complaints: vComp, hidden: vHid }, responsible: { complaints: rComp, busy: rBusy, hidden: rHid } };
    opsFiltersCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) { res.json({ validation: { complaints: ["Valid", "InValid"], hidden: [] }, responsible: { complaints: [], busy: [], hidden: [] }, error: String(e.message).slice(0, 160) }); }
});

// manual pre-warm trigger
app.post("/api/admin/cache/prewarm", requireAdmin, (_req, res) => { runPrewarm("manual"); res.json({ ok: true, prewarm: perf.prewarm }); });
// clear the cache (in-memory + persisted)
app.post("/api/admin/cache/clear", requireAdmin, async (_req, res) => { vizCache.clear(); await persistence.clear(); res.json({ ok: true }); });
// cache key inspector
app.get("/api/admin/cache/keys", requireAdmin, (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const keys = [...vizCache.values()].filter((e) => !q || e.key.toLowerCase().includes(q))
    .map((e) => ({ key: e.key, hits: e.hits || 0, ageSec: Math.round((Date.now() - e.ts) / 1000), err: e.lastError || null })).slice(0, 200);
  res.json({ total: vizCache.size, keys });
});
// CORRECTNESS: compare the cached payload vs a fresh Power BI result for a visual
app.get("/api/admin/cache/verify/:name", requireAdmin, async (req, res) => {
  try {
    const name = req.params.name;
    if (!VIZ[name]) return res.status(400).json({ error: "unknown visual" });
    const { key, asRole, range } = vizKey(name, req.user, req.query);
    const cached = vizCache.get(key);
    const fresh = await vizWork(name, req.user, req.query, asRole, range);
    const norm = (p) => JSON.stringify(p && (p.row || p.rows));
    const match = cached ? norm(cached.payload) === norm(fresh) : null;
    res.json({ name, key, cachedAgeSec: cached ? Math.round((Date.now() - cached.ts) / 1000) : null, match, fresh, cached: cached ? cached.payload : null });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// ============================ ANALYSIS LAB ============================
// Curated catalog of measures/dimensions (all proven against the model in the
// queries above) — safer than parsing TMDL, which risks broken column refs.
const ALAB_MEASURES = {
  net: { label: "Net Sales", table: "SALES DATA", expr: "SUM('SALES DATA'[NET])", fmt: "kd", desc: "Total net revenue (KD)" },
  orders: { label: "Orders", table: "Append1", expr: "'Append1'[Count of Orders]", fmt: "num", desc: "Number of orders" },
  aov: { label: "Avg Ticket (AOV)", table: "Append1", expr: "'Append1'[AOV]", fmt: "kdc", desc: "Average order value" },
  target: { label: "Target", table: "FORECAST BRANCH", expr: "SUM('FORECAST BRANCH'[Daily Target])", fmt: "kd", desc: "Sales target (KD)" },
  prep: { label: "Avg Prep Time", table: "Append1", expr: "CALCULATE('Append1'[Avg Prep Time (min)], KEEPFILTERS(FILTER(TALABAT_LOGISTICS, NOT ISBLANK(TALABAT_LOGISTICS[PrepMinutes]) && TALABAT_LOGISTICS[PrepMinutes] >= 5 && TALABAT_LOGISTICS[PrepMinutes] <= 30)))", fmt: "min", desc: "Average preparation time" },
  delivery: { label: "Avg Delivery Time", table: "TALABAT_LOGISTICS", expr: "'TALABAT_LOGISTICS'[Avg Delivery Time (min)]", fmt: "min", desc: "Average delivery time" },
  rider: { label: "Rider Waiting", table: "TALABAT_LOGISTICS", expr: "'TALABAT_LOGISTICS'[Avg Rider Waiting Time (min)]", fmt: "min", desc: "Avg rider wait" },
  complaint: { label: "Complaint Ratio", table: "Append1", expr: "'Append1'[Complaint_to_Order_Ratio]", fmt: "pct", desc: "Complaints ÷ orders" },
  complaints: { label: "Complaints", table: "Append1", expr: "'Append1'[Count of Complaints]", fmt: "num", desc: "Number of complaints" },
  offline: { label: "Offline Rate", table: "Append1", expr: "'Append1'[TotalOfflineRate]", fmt: "pct", desc: "Store offline %" },
  rating: { label: "Avg Rating", table: "Append1", expr: "'Append1'[AverageRating]", fmt: "rate", desc: "Average customer rating" },
  discount: { label: "Discount / Offer %", table: "Append1", expr: "'Append1'[Discount %]", fmt: "pct", desc: "Discount as % of sales" },
};
const ALAB_DIMS = {
  brand: { label: "Brand", col: "'Brand Table'[Brand Full Name]", time: false },
  location: { label: "Location", col: "'LocationMaster'[Location]", time: false },
  channel: { label: "Channel", col: "'BusinessesTable'[OrdersourceName]", time: false },
  date: { label: "Date", col: "'DATETABLE'[DATE]", time: true },
  hour: { label: "Hour", col: "'TALABAT_LOGISTICS'[Hour]", time: false },
  category: { label: "Complaint Category", col: "'Complaints'[ComplaintCategories]", time: false },
};
const alabFmt = (fmt) => {
  const kd = (v) => "KD " + Math.round(Number(v) || 0).toLocaleString("en-US");
  if (fmt === "kd") return kd;
  if (fmt === "kdc") return (v) => "KD " + (Number(v) || 0).toFixed(2);
  if (fmt === "num") return (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
  if (fmt === "min") return (v) => (Number(v) || 0).toFixed(1) + " min";
  if (fmt === "pct") return (v) => ((Number(v) || 0) * 100).toFixed(2) + "%";
  if (fmt === "rate") return (v) => (Number(v) || 0).toFixed(2);
  return (v) => String(v);
};
// build a dynamic SUMMARIZECOLUMNS from the user's picks (date + brand scope always applied)
function alabDax(cfg, range) {
  const dims = (cfg.dimensions || []).map((k) => ALAB_DIMS[k]).filter(Boolean);
  const meas = (cfg.measures || []).map((k) => ALAB_MEASURES[k]).filter(Boolean);
  if (!meas.length) return null;
  const esc = (s) => String(s).replace(/"/g, '""');
  const fv = [], fa = [];
  const addF = (vals, col, name) => {
    if (Array.isArray(vals) && vals.length) {
      fv.push(`  VAR ${name} = FILTER(ALL(${col}), ${col} IN {${vals.map((v) => `"${esc(v)}"`).join(", ")}})`);
      fa.push(name);
    }
  };
  const f = cfg.filters || {};
  addF(f.brands, "'Brand Table'[Brand Full Name]", "__fBrand");
  addF(f.locations, "'LocationMaster'[Location]", "__fLoc");
  addF(f.channels, "'BusinessesTable'[OrdersourceName]", "__fChan");
  const measCols = meas.map((m, i) => `"m${i}", ${m.expr}`).join(", ");
  const def = `DEFINE${dayFilters(range)}${fv.length ? "\n" + fv.join("\n") : ""}`;
  if (!dims.length) {
    return `${def}\nEVALUATE SUMMARIZECOLUMNS(__date, __brand, ${fa.length ? fa.join(", ") + ", " : ""}${measCols})`;
  }
  const groupArgs = [dims.map((d) => d.col).join(", "), "__date", "__brand", ...fa].filter(Boolean).join(", ");
  let inner = `FILTER(SUMMARIZECOLUMNS(${groupArgs}, ${measCols}), NOT ISBLANK([m0]))`;
  const order = cfg.order || "default";
  if (order === "top10") inner = `TOPN(10, ${inner}, [m0], DESC)`;
  else if (order === "bottom10") inner = `TOPN(10, ${inner}, [m0], ASC)`;
  const ob = order === "az" ? ` ORDER BY ${dims[0].col} ASC` : order === "bottom10" ? ` ORDER BY [m0] ASC` : ` ORDER BY [m0] DESC`;
  return `${def}\nEVALUATE ${inner}${ob}`;
}
function alabMap(rows, dims, meas) {
  const dk = dims.map((d) => d.col.replace(/'/g, ""));   // 'X'[Y] -> X[Y] (result column name)
  return rows.map((r) => {
    const o = {};
    dims.forEach((d, i) => { o["d" + i] = r[dk[i]]; });
    meas.forEach((m, i) => { o["m" + i] = r["[m" + i + "]"]; });
    return o;
  });
}
// deterministic local narrative (swap for a Claude call here if the API is ever enabled)
function alabInsight(mapped, dims, meas, range) {
  if (!mapped.length || !meas.length) return "No data for this selection — adjust measures or filters.";
  const m0 = meas[0], fv = alabFmt(m0.fmt);
  if (!dims.length) return `${m0.label} is ${fv(mapped[0].m0)} for ${range.start === range.end ? range.start : range.start + " → " + range.end}.`;
  const rows = mapped.filter((r) => r.m0 != null && isFinite(Number(r.m0)));
  if (!rows.length) return `${m0.label} has no values for this selection.`;
  const dl = dims[0].label.toLowerCase();
  const avg = m0.fmt === "pct" || m0.fmt === "rate" || m0.fmt === "min";   // rate-like measures average, not sum
  const sorted = [...rows].sort((a, b) => Number(b.m0) - Number(a.m0));
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const agg = avg ? rows.reduce((s, r) => s + Number(r.m0), 0) / rows.length : rows.reduce((s, r) => s + Number(r.m0), 0);
  let s = `${m0.label} by ${dims[0].label}: ${top.d0} leads at ${fv(top.m0)}`;
  if (sorted.length > 1) s += `, ${bottom.d0} trails at ${fv(bottom.m0)}`;
  s += `. ${avg ? "Average" : "Total"} across ${rows.length} ${dl}s is ${fv(agg)}.`;
  if (meas[1]) { const m1 = meas[1], fv1 = alabFmt(m1.fmt); s += ` Top by ${m0.label} (${top.d0}) shows ${m1.label} of ${fv1(top.m1)}.`; }
  return s;
}

// ---- saved-analyses store (per-user JSON file) ----
const ALAB_FILE = path.join(__dirname, "data", "analyses.json");
function loadAnalyses() { try { return JSON.parse(fs.readFileSync(ALAB_FILE, "utf8")); } catch { return []; } }
function saveAnalyses(list) { try { fs.mkdirSync(path.dirname(ALAB_FILE), { recursive: true }); fs.writeFileSync(ALAB_FILE, JSON.stringify(list, null, 2)); } catch {} }

app.get("/api/analysis-lab/catalog", requireAuth, async (req, res) => {
  const base = {
    measures: Object.entries(ALAB_MEASURES).map(([key, m]) => ({ key, label: m.label, table: m.table, desc: m.desc, fmt: m.fmt })),
    dimensions: Object.entries(ALAB_DIMS).map(([key, d]) => ({ key, label: d.label, time: d.time })),
  };
  try {
    if (!LIVE) return res.json({ ...base, brands: [], locations: [], channels: [] });
    CURRENT.user = req.user; CURRENT.brand = req.query.brand && req.query.brand !== "all" ? req.query.brand : null;
    const bv = brandFilterVar();                          // scope filter for this user + global brand
    const vals = (col, key) => runDax(`DEFINE VAR __b = ${bv}\nEVALUATE CALCULATETABLE(VALUES(${col}), __b)`)
      .then((r) => r.map((x) => x[key]).filter(Boolean).sort()).catch(() => []);
    const [brands, locations, channels] = await Promise.all([
      vals("'Brand Table'[Brand Full Name]", "Brand Table[Brand Full Name]"),
      vals("'LocationMaster'[Location]", "LocationMaster[Location]"),
      vals("'BusinessesTable'[OrdersourceName]", "BusinessesTable[OrdersourceName]"),
    ]);
    res.json({ ...base, brands, locations, channels });
  } catch (e) { res.json({ ...base, brands: [], locations: [], channels: [] }); }
});

app.post("/api/analysis-lab/query", requireAuth, async (req, res) => {
  try {
    const cfg = req.body || {};
    const meas = (cfg.measures || []).map((k) => ALAB_MEASURES[k]).filter(Boolean);
    if (!meas.length) return res.status(400).json({ error: "Select at least one measure." });
    const dims = (cfg.dimensions || []).map((k) => ALAB_DIMS[k]).filter(Boolean);
    CURRENT.user = req.user;
    CURRENT.brand = cfg.brand && cfg.brand !== "all" ? cfg.brand : null;
    const range = rangeFromReq(cfg.range || {});
    const dax = alabDax(cfg, range);
    console.log(`[alab] meas=[${(cfg.measures || []).join(",")}] dims=[${(cfg.dimensions || []).join(",")}] ${range.start}→${range.end}`);
    if (!LIVE) return res.json({ rows: [], schema: { dims: [], measures: [] }, insight: "Sample mode — no live data." });
    const rows = await runDax(dax);
    const mapped = alabMap(rows, dims, meas);
    const schema = {
      dims: dims.map((d, i) => ({ key: "d" + i, label: d.label, time: d.time })),
      measures: meas.map((m, i) => ({ key: "m" + i, label: m.label, fmt: m.fmt })),
    };
    res.json({ rows: mapped, schema, insight: alabInsight(mapped, dims, meas, range) });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.get("/api/analysis-lab/list", requireAuth, (req, res) => {
  const mine = loadAnalyses().filter((a) => a.user === req.user.email || a.isShared);
  res.json({ analyses: mine.map((a) => ({ ...a, own: a.user === req.user.email })) });
});
app.post("/api/analysis-lab/save", requireAuth, (req, res) => {
  const { id, name, config, chartType, isShared } = req.body || {};
  if (!name || !config) return res.status(400).json({ error: "name and config required" });
  const list = loadAnalyses();
  const now = new Date().toISOString();
  const canShare = req.user.role === "admin" || req.user.role === "marketing";
  if (id) {
    const i = list.findIndex((a) => a.id === id && a.user === req.user.email);
    if (i >= 0) { list[i] = { ...list[i], name, config, chartType, isShared: canShare ? !!isShared : false, updatedAt: now }; saveAnalyses(list); return res.json({ analysis: list[i] }); }
  }
  const rec = { id: "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), user: req.user.email, creator: req.user.name, name, config, chartType, isShared: canShare ? !!isShared : false, createdAt: now, updatedAt: now };
  list.push(rec); saveAnalyses(list);
  res.json({ analysis: rec });
});
app.post("/api/analysis-lab/delete", requireAuth, (req, res) => {
  const list = loadAnalyses().filter((a) => !(a.id === req.body.id && a.user === req.user.email));
  saveAnalyses(list); res.json({ ok: true });
});

app.post("/api/dax", requireAuth, async (req, res) => {
  const { template, role = "ceo" } = req.body;
  try {
    CURRENT.user = req.user;                              // enforce this user's scope
    if (!LIVE) {
      // sample mode
      if (template === "brandScorecard") return res.json(sampleScorecard(role));
      if (template === "intraday") return res.json({ rows: sampleIntraday(role) });
      return res.json({ rows: scopeSample(role) });
    }
    // live mode — query runs as the signed-in user (RLS applies to them).
    // NOTE: with device-code auth the `role` can't switch identities server-side;
    // per-role impersonation needs the service-principal path instead.
    CURRENT.brand = req.body.brand || null;                // global brand scope
    let dax = TEMPLATES[template];
    if (!dax) return res.status(400).json({ error: "unknown template" });
    // function templates take the resolved selected range (defaults to today, Kuwait)
    if (typeof dax === "function") dax = dax(rangeFromReq(req.body));
    const rows = await runDax(dax);
    if (template === "brandScorecard") return res.json(mapScorecard(rows));
    res.json({ rows: template === "intraday" ? mapIntraday(rows) : mapBoard(rows) });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// AI assistant — grounded chat that reuses the scoped queries + measure catalogue
registerAssistant(app, { runDax, VIZ, mapViz, rangeFromReq, CURRENT, LIVE });
registerVoiceBrief(app, { runDax, VIZ, mapViz, rangeFromReq, CURRENT, LIVE });
registerNarration(app, { runDax, VIZ, mapViz, rangeFromReq, CURRENT, LIVE });
registerBranches(app, { runDax, VIZ, mapViz, rangeFromReq, CURRENT, LIVE });
// Admin-only debug / visual editor
registerDebug(app, { VIZ, mapViz, rangeFromReq, runDax, CURRENT, invalidateViz });
// Feedback / engagement / management layer (feedback, exports, suggestions,
// messages, ratings, activity, notifications)
registerEngagement(app);
// Dashboard layout store (widget framework — user personalization + admin defaults)
registerLayouts(app);

// ---- PRODUCTION: serve the built SPA from this same process ----------------
// In dev, Vite serves the app on :5173. For deployment at scale, run
// `npm run build` and set SERVE_STATIC=1 so ONE Node process serves both the API
// and the app, with hashed assets cached hard by browsers/CDN (immutable, 1yr)
// and index.html never cached (so a new deploy is picked up immediately).
if (process.env.SERVE_STATIC === "1") {
  const distDir = path.join(__dirname, "..", "dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, {
      setHeaders: (res, filePath) => {
        if (/\.(js|css|woff2?|png|jpg|svg|webp|ico)$/.test(filePath) && /[.-][0-9a-f]{8,}\./i.test(filePath)) {
          res.set("Cache-Control", "public, max-age=31536000, immutable");   // content-hashed → never changes
        } else {
          res.set("Cache-Control", "no-cache");
        }
      },
    }));
    // SPA fallback — any non-API GET returns index.html so client routing works
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
    console.log("  Serving built SPA from /dist (SERVE_STATIC=1)");
  } else {
    console.warn("  SERVE_STATIC=1 but /dist not found — run `npm run build` first.");
  }
}

app.listen(PORT, () => {
  console.log(`\n  Waiter running on http://localhost:${PORT}`);
  console.log(`  Mode: ${LIVE ? "LIVE  (talking to your Power BI model)" : "SAMPLE  (fill server/.env for live data)"}\n`);
  // kick off sign-in now so the device code appears immediately (not on first query)
  if (LIVE) { getToken().then(() => startTokenRefresher()).catch((e) => console.error("  Sign-in error:", e.message)); }
});

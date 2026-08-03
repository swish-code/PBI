// ============================================================================
//  STORE LOCATIONS + WORKING-HOURS IMPORT (from Branches Data.xlsx)
//  store-locations.json was produced from the Excel: brand, branch, address,
//  parsed hours/day, resolved lat/lng, and the Google Maps link. This serves the
//  map, and (admin) imports the parsed hours into working-hours.json by matching
//  each store to the model's own LocationMaster locations.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, requireAdmin } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(__dirname, "data", "store-locations.json");
const WH_FILE = path.join(__dirname, "data", "working-hours.json");
const loadStores = () => { try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch { return []; } };
const loadWH = () => { try { const j = JSON.parse(fs.readFileSync(WH_FILE, "utf8")); return { hours: j.hours || {}, times: j.times || {}, default: Number(j.default) || 14 }; } catch { return { hours: {}, times: {}, default: 14 }; } };
const saveWH = (x) => { try { fs.mkdirSync(path.dirname(WH_FILE), { recursive: true }); fs.writeFileSync(WH_FILE, JSON.stringify(x, null, 2)); } catch { /* ignore */ } };

// normalise a branch/location name for fuzzy matching across the two sources
const norm = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z]/g, "").replace(/^al/, "").replace(/al$/, "");
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function bestMatch(name, candidates) {
  const nn = norm(name); if (!nn) return null;
  let best = null, bestScore = 99;
  for (const c of candidates) {
    const cn = norm(c); if (!cn) continue;
    if (cn === nn) return c;
    const contains = cn.includes(nn) || nn.includes(cn);
    const dist = lev(nn, cn);
    const score = contains ? 0.5 : dist;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return bestScore <= 2 ? best : null;   // accept exact, containment, or ≤2 edits
}

const nz = (v) => (isFinite(Number(v)) ? Number(v) : 0);
// parse a "Working hours" cell ("12:00 PM - 01:30 AM" / "24 Hrs") -> {open, close, hours}
function parseHours(txt) {
  const t = String(txt || "").trim();
  if (/24\s*hr/i.test(t)) return { open: "12:00 AM", close: "12:00 AM", hours: 24 };
  const m = t.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[-–]\s*(\d{1,2}:?\d{0,2}:?\s*[AP]M)/i);
  if (!m) return null;
  const to24 = (s) => { const mm = String(s).replace(/:\s*(?=[AP]M)/i, " ").match(/(\d{1,2}):(\d{2})\s*([AP])M/i); if (!mm) return null; let h = Number(mm[1]) % 12; if (/P/i.test(mm[3])) h += 12; return h + Number(mm[2]) / 60; };
  const o = to24(m[1]), c0 = to24(m[2].replace(/:$/, "")); if (o == null || c0 == null) return null;
  let c = c0; if (c <= o) c += 24;
  return { open: m[1].trim(), close: m[2].trim().replace(/:$/, ""), hours: Math.round((c - o) * 2) / 2 };
}

export function registerBranches(app, deps) {
  // store list for the map — scoped to the user's brand access, enriched with the
  // selected period's sales / orders / AOV per store (matched to model locations)
  app.get("/api/store-locations", requireAuth, async (req, res) => {
    let stores = loadStores().map((s) => ({ ...s }));
    const sc = req.user?.scope;
    if (sc && sc.brands && sc.brands !== "all") { const set = new Set(sc.brands); stores = stores.filter((s) => set.has(s.brand)); }
    if (deps.LIVE && (req.query.preset || req.query.start || req.query.date)) {
      try {
        deps.CURRENT.user = req.user;
        deps.CURRENT.brand = req.query.brand && req.query.brand !== "all" ? req.query.brand : null;
        const range = deps.rangeFromReq(req.query);
        const v = deps.VIZ.ops_store_metrics;
        const rows = deps.mapViz(v, await deps.runDax(v.dax(range, { loc: "" })));   // brand, location, prep, delivery, rating, net, orders, aov
        const byBrand = {};   // brand -> [{loc, prep, delivery, rating, net, orders, aov}]
        for (const r of rows) { (byBrand[r.brand] = byBrand[r.brand] || []).push({ loc: r.location, prep: nz(r.prep), delivery: nz(r.delivery), rating: nz(r.rating), net: nz(r.net), orders: nz(r.orders), aov: nz(r.aov) }); }
        for (const s of stores) {
          const cands = byBrand[s.brand] || [];
          const locName = bestMatch(s.branch, cands.map((c) => c.loc));
          const hit = locName && cands.find((c) => c.loc === locName);
          if (hit) { s.net = hit.net; s.orders = hit.orders; s.aov = hit.aov; s.prep = hit.prep; s.delivery = hit.delivery; s.rating = hit.rating; s.matchedLoc = hit.loc; }
        }
        // flag slow-delivery stores: delivery > 1.2× the brand's average (min 3 stores)
        for (const [b, arr] of Object.entries(byBrand)) {
          const d = arr.map((c) => c.delivery).filter((x) => x > 0);
          if (d.length < 3) continue;
          const avg = d.reduce((a, x) => a + x, 0) / d.length;
          const thresh = avg * 1.2;
          for (const s of stores) { if (s.brand === b && s.delivery > 0 && s.delivery >= thresh) { s.slowDelivery = true; s.brandAvgDelivery = Math.round(avg * 10) / 10; } }
        }
      } catch { /* enrichment is best-effort */ }
    }
    res.json({ stores });
  });

  // admin: import parsed hours → working-hours.json, matching to model locations
  app.post("/api/admin/import-working-hours", requireAdmin, async (req, res) => {
    if (!deps.LIVE) return res.status(400).json({ error: "live model required to match locations" });
    try {
      deps.CURRENT.user = { role: "admin", scope: { brands: "all", locations: "all" } };
      deps.CURRENT.brand = null;
      const rows = await deps.runDax(`EVALUATE FILTER(SUMMARIZECOLUMNS('Brand Table'[Brand Full Name], 'LocationMaster'[Location], "N", CALCULATE(SUM('SALES DATA'[NET]))), [N] > 0)`);
      const byBrand = {};   // brand -> [location names in the model]
      for (const r of rows) { const b = r["Brand Table[Brand Full Name]"], l = r["LocationMaster[Location]"]; if (b && l) (byBrand[b] = byBrand[b] || []).push(l); }
      const wh = loadWH(); wh.times = wh.times || {};
      const matched = [], unmatched = [];
      for (const s of loadStores()) {
        const p = parseHours(s.hours) || (s.hoursPerDay != null ? { open: null, close: null, hours: s.hoursPerDay } : null);
        if (!p) continue;
        const cands = byBrand[s.brand] || [];
        const loc = bestMatch(s.branch, cands);
        if (loc) {
          const k = `${s.brand}::${loc}`;
          wh.hours[k] = p.hours; wh.times[k] = { open: p.open, close: p.close, raw: s.hours };
          matched.push({ brand: s.brand, store: s.branch, matchedTo: loc, hours: p.hours, open: p.open, close: p.close });
        } else unmatched.push({ brand: s.brand, store: s.branch, hours: p.hours });
      }
      saveWH(wh);
      res.json({ ok: true, matched: matched.length, unmatched: unmatched.length, matchedList: matched, unmatchedList: unmatched });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
}

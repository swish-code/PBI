// ============================================================================
//  DEBUG / VISUAL EDITOR — ADMIN ONLY. A completely separate layer.
//  Every endpoint is behind requireAdmin (non-admins get 401). Lets an admin
//  inspect the exact DAX + measures + filters + raw rows behind any visual,
//  live-preview edits, save an override, revert, and trace dependents.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAdmin, logAudit } from "./auth.js";
import { measureCatalog } from "./assistant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVR_FILE = path.join(__dirname, "data", "viz-overrides.json");
const MODEL_DIR = process.env.PBI_MODEL_DIR ||
  "C:\\Project\\PBI-Model\\SWiSH ANALYTICS.SemanticModel\\definition\\tables";
const ROLES = ["ceo", "gm", "area"];

// per-role overrides: OVERRIDES[vizName][role] = dax
let OVERRIDES = {};
function loadOverrides() { try { OVERRIDES = JSON.parse(fs.readFileSync(OVR_FILE, "utf8")); } catch { OVERRIDES = {}; } }
function saveOverrides() { try { fs.mkdirSync(path.dirname(OVR_FILE), { recursive: true }); fs.writeFileSync(OVR_FILE, JSON.stringify(OVERRIDES, null, 2)); } catch {} }
loadOverrides();
// server.js consults this so a saved edit takes effect for the live app, per role
export function getVizOverride(name, role) { return OVERRIDES[name] && OVERRIDES[name][role]; }

// all table columns from the TMDL model (for the "table column" side of the picker)
let COLCAT = null;
function columnCatalog() {
  if (COLCAT) return COLCAT;
  const out = [];
  try {
    for (const file of fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith(".tmdl"))) {
      const text = fs.readFileSync(path.join(MODEL_DIR, file), "utf8");
      const lines = text.split(/\r?\n/);
      let table = null;
      for (const l of lines) {
        const t = l.match(/^table\s+(?:'([^']+)'|(\S+))/); if (t) { table = t[1] || t[2]; continue; }
        const c = l.match(/^\tcolumn\s+(?:'([^']+)'|([A-Za-z0-9_]+))/);
        if (c && table) { const name = c[1] || c[2]; if (!/^(RowNumber|LocalDateTable|DateTableTemplate)/i.test(name)) out.push({ table, name }); }
      }
    }
  } catch (e) { console.warn("  [debug] column catalogue:", e.message); }
  COLCAT = out;
  return out;
}

// which page renders a viz (by prefix)
function pageOf(name) {
  if (name.startsWith("landing_")) return "Dashboard (Landing)";
  if (name.startsWith("ops_")) return "Operations";
  if (name.startsWith("ov_")) return "Sales Analysis";
  if (name.startsWith("rr_")) return "Live Runrate";
  if (name.startsWith("brand")) return "Brand Scorecard";
  return "—";
}

// pull `'Table'[Name]` and bare `[Name]` refs out of a DAX string
function extractRefs(dax) {
  const refs = new Map();
  const cat = measureCatalog();
  const catNames = new Set(cat.map((m) => m.name.toLowerCase()));
  const catBy = {}; cat.forEach((m) => { catBy[m.name.toLowerCase()] = m; });
  let m;
  const reQualified = /'([^']+)'\[([^\]]+)\]/g;
  while ((m = reQualified.exec(dax))) {
    const table = m[1], name = m[2], key = `${table}[${name}]`;
    if (!refs.has(key)) refs.set(key, { ref: key, table, name, isMeasure: catNames.has(name.toLowerCase()) });
  }
  const reBare = /(^|[^'\]\w])\[([^\]]+)\]/g;
  while ((m = reBare.exec(dax))) {
    const name = m[2];
    if (catNames.has(name.toLowerCase())) {
      const key = `[${name}]`;
      if (!refs.has(key)) refs.set(key, { ref: key, table: catBy[name.toLowerCase()].table, name, isMeasure: true });
    }
  }
  return [...refs.values()];
}

// summarize the filter VARs present in the query
function extractFilters(dax) {
  const out = [];
  const grab = (label, re) => { const mm = dax.match(re); if (mm) out.push({ label, expr: mm[1].trim().replace(/\s+/g, " ").slice(0, 220) }); };
  grab("Scope / brand (enforced)", /VAR __brand =\s*([\s\S]*?)\n/);
  grab("Date range", /VAR __date =\s*([\s\S]*?)\n/);
  grab("Current period", /VAR __cur =\s*([\s\S]*?)\n/);
  if (/VAR __fB =/.test(dax)) out.push({ label: "Cross-filter: brand", expr: "clicked brand" });
  if (/VAR __fC =/.test(dax)) out.push({ label: "Cross-filter: channel", expr: "clicked channel" });
  if (/VAR __fL =/.test(dax)) out.push({ label: "Cross-filter: location", expr: "clicked location" });
  if (/VAR __sLoc =/.test(dax)) out.push({ label: "Role scope: locations", expr: "assigned branches" });
  return out;
}

/* -------- structured column editing (add/remove a measure in the query) -------- */
// walk to the matching ) for the ( at `open`, skipping DAX strings ("" = escaped quote)
function matchParen(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { i++; while (i < s.length) { if (s[i] === '"') { if (s[i + 1] === '"') { i++; } else break; } i++; } continue; }
    if (c === "(") d++;
    else if (c === ")") { d--; if (d === 0) return i; }
  }
  return -1;
}
// split a top-level arg list by commas (respect nesting + strings)
function splitArgs(s) {
  const out = []; let d = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { cur += c; i++; while (i < s.length) { cur += s[i]; if (s[i] === '"') { if (s[i + 1] === '"') { cur += s[i + 1]; i++; } else break; } i++; } continue; }
    if (c === "(" || c === "[" || c === "{") { d++; cur += c; continue; }
    if (c === ")" || c === "]" || c === "}") { d--; cur += c; continue; }
    if (c === "," && d === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
// find the query's column-bearing function (SUMMARIZECOLUMNS or ROW)
function locateCols(dax) {
  let idx = dax.search(/SUMMARIZECOLUMNS\s*\(/i);
  if (idx < 0) idx = dax.search(/\bROW\s*\(/i);
  if (idx < 0) return null;
  const open = dax.indexOf("(", idx);
  const close = matchParen(dax, open);
  if (close < 0) return null;
  return { open, close };
}
const isColRef = (a) => /^'[^']+'\[[^\]]+\]$/.test(a.trim());
const isStrLit = (a) => /^"(?:[^"]|"")*"$/.test(a.trim());

// parse the query's arg list into ordered editable items + fixed (filter) args
function parseModel(dax) {
  const loc = locateCols(dax);
  if (!loc) return null;
  const args = splitArgs(dax.slice(loc.open + 1, loc.close)).map((a) => a.trim());
  const items = [], fixed = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (isColRef(a)) { const m = a.match(/^'([^']+)'\[([^\]]+)\]$/); items.push({ kind: "column", key: a, ref: a, table: m[1], name: m[2] }); }
    else if (isStrLit(a) && i + 1 < args.length) { const alias = a.slice(1, -1).replace(/""/g, '"'); items.push({ kind: "measure", key: alias, alias, expr: args[i + 1].trim() }); i++; }
    else fixed.push(a);
  }
  return { loc, items, fixed };
}
export function parseItems(dax) { const m = parseModel(dax); return m ? m.items : []; }

// ---- measure filters (Power BI "Filters on this visual") -------------------
// A visual filter wraps the EVALUATE table expression in FILTER(...) with
// conditions on the measure alias columns. Marked with /*VF*/ so it's idempotent.
// filter = { type:"measure"|"column", ref, label, op, v1?, v2?, vals? }
//   ref = "[Alias]" for a measure column, "'Table'[Col]" for a grouping column.
const fCond = (f) => {
  const r = f.ref; if (!r) return "";
  const n = (x) => (isFinite(Number(x)) ? Number(x) : null);
  const q = (x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
  switch (f.op) {
    case "notblank": return `NOT(ISBLANK(${r}))`;
    case "blank": return `ISBLANK(${r})`;
    case "gte": return n(f.v1) != null ? `${r} >= ${n(f.v1)}` : "";
    case "lte": return n(f.v1) != null ? `${r} <= ${n(f.v1)}` : "";
    case "gt": return n(f.v1) != null ? `${r} > ${n(f.v1)}` : "";
    case "lt": return n(f.v1) != null ? `${r} < ${n(f.v1)}` : "";
    case "eq": return n(f.v1) != null ? `${r} = ${n(f.v1)}` : "";
    case "ne": return n(f.v1) != null ? `${r} <> ${n(f.v1)}` : "";
    case "between": return (n(f.v1) != null && n(f.v2) != null) ? `(${r} >= ${n(f.v1)} && ${r} <= ${n(f.v2)})` : "";
    case "is": return `${r} = ${q(f.v1)}`;
    case "isnot": return `${r} <> ${q(f.v1)}`;
    case "in": { const vals = Array.isArray(f.vals) ? f.vals : String(f.v1 || "").split(",").map((s) => s.trim()).filter(Boolean); return vals.length ? `${r} IN {${vals.map((v) => (f.numeric ? Number(v) : q(v))).join(", ")}}` : ""; }
    case "contains": return f.v1 ? `SEARCH(${q(f.v1)}, ${r}, 1, 0) > 0` : "";
    case "startswith": return f.v1 ? `LEFT(${r}, LEN(${q(f.v1)})) = ${q(f.v1)}` : "";
    default: return "";
  }
};
// Remove any previously-injected visual filters, returning the clean base query:
//  • leading /*VF:…*/ marker  • outer measure FILTER(/*VFM*/…)  • column filter
//  args marked /*VFC*/ inside SUMMARIZECOLUMNS  • hidden "__VFMn" measure columns.
function stripVF(dax) {
  let out = dax.replace(/^\s*\/\*VF:[A-Za-z0-9+/=]*\*\/\s*/, "");
  const i = out.indexOf("FILTER(/*VFM*/");
  if (i >= 0) { const open = out.indexOf("(", i), close = matchParen(out, open); if (close >= 0) out = out.slice(0, i) + splitArgs(out.slice(open + 1, close))[0].trim() + out.slice(close + 1); }
  const m = parseModel(out);
  if (m && (m.fixed.some((a) => a.includes("/*VFC*/")) || m.items.some((x) => x.kind === "measure" && /^__VFM\d+$/.test(x.alias)))) {
    const cols = m.items.filter((x) => x.kind === "column").map((x) => x.ref);
    const meas = m.items.filter((x) => x.kind === "measure" && !/^__VFM\d+$/.test(x.alias)).flatMap((x) => [`"${x.alias.replace(/"/g, '""')}"`, x.expr]);
    const fixed = m.fixed.filter((a) => !a.includes("/*VFC*/"));
    out = out.slice(0, m.loc.open + 1) + "\n  " + [...cols, ...fixed, ...meas].join(",\n  ") + "\n" + out.slice(m.loc.close);
  }
  return out;
}
// Apply the structured filter list to a query — works for ANY catalogue field:
//  • columns → KEEPFILTERS(FILTER(ALL('T'[C]),…)) as SUMMARIZECOLUMNS filter args
//  • measures → a hidden "__VFMn" column (inherits the query's filter context) that
//    the outer FILTER tests, then stripped from the output (filter-only, not shown).
function applyFilters(dax, filters) {
  const base = stripVF(dax);
  if (!filters || !filters.length) return base;
  const colFs = filters.filter((f) => f.type === "column");
  const measFs = filters.filter((f) => f.type === "measure");
  let out = base;
  const m = parseModel(out);
  if (m && (colFs.length || measFs.length)) {
    const cols = m.items.filter((x) => x.kind === "column").map((x) => x.ref);
    const meas = m.items.filter((x) => x.kind === "measure").flatMap((x) => [`"${x.alias.replace(/"/g, '""')}"`, x.expr]);
    const colArgs = colFs.map((f) => { const c = fCond(f); return c ? `KEEPFILTERS(FILTER(ALL(${f.ref}), ${c}))/*VFC*/` : ""; }).filter(Boolean);
    // hidden measure cols must inherit the SAME period scope the visible measures use
    // (queries wrap measures in CALCULATE(m, __cur / __date)); else they compute all-time.
    const scope = (/VAR __cur =/.test(out) && "__cur") || (/VAR __date =/.test(out) && "__date") || (/VAR __period =/.test(out) && "__period") || null;
    const hidden = measFs.flatMap((f, i) => [`"__VFM${i}"`, scope ? `CALCULATE([${f.ref}], ${scope})` : `[${f.ref}]`]);   // ref = measure name
    out = out.slice(0, m.loc.open + 1) + "\n  " + [...cols, ...m.fixed, ...colArgs, ...meas, ...hidden].join(",\n  ") + "\n" + out.slice(m.loc.close);
  }
  const measConds = measFs.map((f, i) => fCond({ ...f, ref: `[__VFM${i}]` })).filter(Boolean).join(" && ");
  if (measConds) {
    const w = out.match(/^([\s\S]*\bEVALUATE\b[ \t]*\n?)([\s\S]*?)([ \t]*\n?[ \t]*\bORDER BY\b[\s\S]*)?$/i);
    if (w) out = `${w[1]}FILTER(/*VFM*/\n${w[2].trim()},\n${measConds})${w[3] || ""}`;
  }
  return `/*VF:${Buffer.from(JSON.stringify(filters)).toString("base64")}*/\n` + out;
}
// drop hidden filter-only measure columns from raw rows shown in the debug grid
function hideVFCols(rows) {
  if (!rows || !rows.length || !Object.keys(rows[0]).some((k) => k.startsWith("[__VFM"))) return rows;
  return rows.map((r) => { const o = {}; for (const k in r) if (!k.startsWith("[__VFM")) o[k] = r[k]; return o; });
}
export function extractMeasureFilters(dax) {
  const m = dax.match(/\/\*VF:([A-Za-z0-9+/=]*)\*\//);
  if (!m) return [];
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); } catch { return []; }
}

// apply add / remove / reorder / setFilters to the query and return new DAX
function editQuery(dax, op) {
  if (op.kind === "setFilters") return applyFilters(dax, op.filters);
  const m = parseModel(dax);
  if (!m) return dax;
  let list = m.items.slice();
  if (op.kind === "remove") list = list.filter((x) => x.key !== op.key);
  else if (op.kind === "add") {
    if (op.itemType === "column") { const ref = `'${op.table}'[${op.name}]`; if (!list.some((x) => x.key === ref)) list.push({ kind: "column", key: ref, ref }); }
    else { const alias = op.name; const expr = /VAR __cur =/.test(dax) ? `CALCULATE([${op.name}], __cur)` : `[${op.name}]`; if (!list.some((x) => x.key === alias)) list.push({ kind: "measure", key: alias, alias, expr }); }
  } else if (op.kind === "reorder" && Array.isArray(op.order)) {
    const rank = {}; op.order.forEach((k, i) => (rank[k] = i));
    list = list.slice().sort((a, b) => (rank[a.key] ?? 999) - (rank[b.key] ?? 999));
  }
  // rebuild: group-by columns first, then fixed filter args, then measure pairs
  const cols = list.filter((x) => x.kind === "column").map((x) => x.ref);
  const meas = list.filter((x) => x.kind === "measure").flatMap((x) => [`"${x.alias.replace(/"/g, '""')}"`, x.expr]);
  const inner = [...cols, ...m.fixed, ...meas].join(",\n  ");
  return dax.slice(0, m.loc.open + 1) + "\n  " + inner + "\n" + dax.slice(m.loc.close);
}

// per-column "why is this empty" diagnostics
function diagnose(v, rawRows, mapped) {
  const cols = v.cols || [];
  const rows = v.single ? (rawRows[0] ? [rawRows[0]] : []) : rawRows;
  return cols.map(([as, key]) => {
    const vals = rows.map((r) => r[key]);
    const nonNull = vals.filter((x) => x != null && x !== "").length;
    const isMeasure = key.startsWith("[");
    let status = "ok", reason = "";
    if (!rows.length) { status = "empty"; reason = "Query returned no rows — the filter context excluded everything (check date range / scope)."; }
    else if (nonNull === 0) { status = "empty"; reason = isMeasure ? "Measure returned BLANK for every row — it isn't defined at this grain, or no rows match the filter." : "Column is blank for every row — the source column has no values in this filter context."; }
    else if (nonNull < vals.length) { status = "partial"; reason = `${vals.length - nonNull} of ${vals.length} rows are blank here (measure undefined for those rows).`; }
    return { column: as, key, status, filled: nonNull, total: vals.length, reason };
  });
}

// map rows to clean shape + pass through admin-added measure columns (mirrors server.js)
function mapVizFull(v, rows) {
  const known = new Set(v.cols.map((c) => c[1]));
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const extras = keys.filter((k) => !known.has(k) && k.startsWith("[") && !k.startsWith("[__VFM"));
  const clean = (k) => k.replace(/^\[|\]$/g, "");
  const one = (r) => { const o = Object.fromEntries(v.cols.map(([as, key]) => [as, r[key]])); for (const k of extras) o[clean(k)] = r[k]; return o; };
  return { mapped: v.single ? (rows[0] ? one(rows[0]) : {}) : rows.map(one), extraCols: extras.map((k) => ({ key: clean(k), label: clean(k) })) };
}

export function registerDebug(app, deps) {
  const { VIZ, mapViz, rangeFromReq, runDax, CURRENT, invalidateViz } = deps;

  // list every visual + its columns + whether an override exists
  // viz names that have a saved override for any role — drives the "glowing tile" hint
  app.get("/api/debug/overrides", requireAdmin, (_req, res) => {
    res.json({ names: Object.keys(OVERRIDES).filter((n) => OVERRIDES[n] && Object.keys(OVERRIDES[n]).length) });
  });

  app.get("/api/debug/catalog", requireAdmin, (_req, res) => {
    res.json({
      visuals: Object.entries(VIZ).map(([name, v]) => ({ name, page: pageOf(name), single: !!v.single, columns: v.cols.map((c) => c[0]), hasOverride: !!OVERRIDES[name] })),
    });
  });

  // measures AND table columns, both labelled (for the add picker)
  app.get("/api/debug/available", requireAdmin, (_req, res) => {
    res.json({
      measures: measureCatalog().map((m) => ({ type: "measure", name: m.name, table: m.table })),
      columns: columnCatalog().map((c) => ({ type: "column", name: c.name, table: c.table })),
    });
  });
  app.get("/api/debug/measures", requireAdmin, (_req, res) => res.json({ measures: measureCatalog().map((m) => ({ name: m.name, table: m.table })) }));

  // distinct values for a column (Power BI "Basic filtering" value list) + numeric flag
  app.get("/api/debug/values", requireAdmin, async (req, res) => {
    const { table, column, model } = req.query || {};
    if (!table || !column) return res.status(400).json({ error: "table & column required" });
    const ref = `'${String(table).replace(/'/g, "''")}'[${String(column).replace(/]/g, "]]")}]`;
    try {
      CURRENT.user = req.user; CURRENT.brand = null;
      const rows = await runDax(`EVALUATE TOPN(2000, VALUES(${ref}), ${ref}, ASC)`, model || "main");
      const key = Object.keys(rows[0] || {})[0];
      let values = rows.map((r) => r[key]).filter((v) => v != null && v !== "");
      const numeric = values.length > 0 && values.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))));
      if (numeric) values = values.map(Number).sort((a, b) => a - b);
      else values = values.map(String).sort((a, b) => a.localeCompare(b));
      res.json({ values: values.slice(0, 2000), numeric, truncated: rows.length >= 2000 });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  const roleOf = (r) => (ROLES.includes(r) ? r : "ceo");

  // run a visual for a role (base = that role's saved override, or the default query)
  app.post("/api/debug/run", requireAdmin, async (req, res) => {
    const { name, params = {}, dax: edited, role: rawRole } = req.body || {};
    const role = roleOf(rawRole);
    const v = VIZ[name];
    if (!v) return res.status(400).json({ error: "unknown visual" });
    try {
      CURRENT.user = req.user; CURRENT.brand = params.brand || null;   // admin preview = full data
      const range = rangeFromReq(params);
      const built = edited != null ? edited : (getVizOverride(name, role) || v.dax(range, params));
      const rows = hideVFCols(await runDax(built, v.model || "main"));
      const mapped = mapViz(v, rows);
      res.json({
        dax: built, rows, mapped, cols: v.cols, single: !!v.single, role, model: v.model || "main",
        items: parseItems(built), measures: extractRefs(built), filters: extractFilters(built), measureFilters: extractMeasureFilters(built),
        diagnostics: diagnose(v, rows, mapped), hasOverride: !!getVizOverride(name, role),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e), dax: edited }); }
  });

  // DAX TEXT ONLY — build a viz's DAX for a ctx WITHOUT executing it. Used to freeze
  // the byte-identical DAX snapshots for the 1b viz-registry relocation. Params:
  // brand, preset|start&end, and optional scope=<JSON> for GM/area variants.
  app.get("/api/debug/dax/:name", requireAdmin, (req, res) => {
    const v = VIZ[req.params.name];
    if (!v) return res.status(400).json({ error: "unknown visual" });
    try {
      const params = { ...req.query };
      let user = req.user;
      if (params.scope) { try { user = { ...req.user, scope: JSON.parse(params.scope) }; } catch { /* ignore */ } delete params.scope; }
      CURRENT.user = user; CURRENT.brand = params.brand && params.brand !== "all" ? params.brand : null;
      const dax = v.dax(rangeFromReq(params), params);
      res.json({ name: req.params.name, model: v.model || "main", dax });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // add / remove / reorder a measure or column, then run the new query
  app.post("/api/debug/transform", requireAdmin, async (req, res) => {
    const { name, params = {}, dax, op, role: rawRole } = req.body || {};
    const role = roleOf(rawRole);
    const v = VIZ[name];
    if (!v || !dax || !op) return res.status(400).json({ error: "name, dax, op required" });
    try {
      const next = editQuery(dax, op);
      CURRENT.user = req.user; CURRENT.brand = params.brand || null;
      const rows = hideVFCols(await runDax(next, v.model || "main"));
      const mapped = mapViz(v, rows);
      res.json({ dax: next, rows, mapped, role, items: parseItems(next), measures: extractRefs(next), filters: extractFilters(next), measureFilters: extractMeasureFilters(next), diagnostics: diagnose(v, rows, mapped), hasOverride: !!getVizOverride(name, role) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // save the edit to THIS role's version only — validate by executing first
  app.post("/api/debug/save", requireAdmin, async (req, res) => {
    const { name, dax, role: rawRole } = req.body || {};
    const role = roleOf(rawRole);
    if (!VIZ[name] || !dax) return res.status(400).json({ error: "name + dax required" });
    console.log(`  [debug] SAVE ${name} [${role}] by ${req.user.email} (${dax.length} chars)`);
    const v = VIZ[name];
    try {
      CURRENT.user = req.user; CURRENT.brand = null;               // validate as admin (full)
      const rows = await runDax(dax, v.model || "main");           // syntax + measures checked by execution
      const { mapped, extraCols } = mapVizFull(v, rows);
      OVERRIDES[name] = OVERRIDES[name] || {}; OVERRIDES[name][role] = dax; saveOverrides();
      const busted = invalidateViz ? invalidateViz(name) : 0;   // drop stale cache so the live visual reflects the edit now
      logAudit(req.user.email, "viz-edit", `${name} [${role}]`, `saved for ${role.toUpperCase()} (${v.single ? 1 : rows.length} rows).`);
      res.json({ ok: true, hasOverride: true, role, data: mapped, extraCols, cacheBusted: busted });
    } catch (e) {
      res.status(400).json({ error: "Query invalid — not saved: " + String(e.message || e) });
    }
  });

  app.post("/api/debug/revert", requireAdmin, (req, res) => {
    const { name, role: rawRole } = req.body || {};
    const role = roleOf(rawRole);
    if (OVERRIDES[name] && OVERRIDES[name][role]) { delete OVERRIDES[name][role]; if (!Object.keys(OVERRIDES[name]).length) delete OVERRIDES[name]; saveOverrides(); if (invalidateViz) invalidateViz(name); logAudit(req.user.email, "viz-revert", `${name} [${role}]`, `reverted ${role.toUpperCase()} to default`); }
    res.json({ ok: true, hasOverride: false, role });
  });

  // trace: pages that render this viz + other visuals sharing its measures
  app.get("/api/debug/trace/:name", requireAdmin, (req, res) => {
    const name = req.params.name;
    const v = VIZ[name];
    if (!v) return res.status(400).json({ error: "unknown visual" });
    const range = rangeFromReq({});
    let dax = ""; try { dax = OVERRIDES[name] || v.dax(range, {}); } catch {}
    const mine = new Set(extractRefs(dax).filter((r) => r.isMeasure).map((r) => r.name));
    const alsoUse = [];
    for (const [n2, v2] of Object.entries(VIZ)) {
      if (n2 === name) continue;
      let d2 = ""; try { d2 = OVERRIDES[n2] || v2.dax(range, {}); } catch { continue; }
      const shared = extractRefs(d2).filter((r) => r.isMeasure && mine.has(r.name)).map((r) => r.name);
      if (shared.length) alsoUse.push({ visual: n2, page: pageOf(n2), sharedMeasures: [...new Set(shared)] });
    }
    res.json({ name, page: pageOf(name), measures: [...mine], dependents: alsoUse.slice(0, 30) });
  });
}

// ============================================================================
//  AI ASSISTANT — grounded analytics chat
//  The language layer (Claude) NEVER writes DAX or invents numbers. It can only
//  call a fixed set of tools that run the SAME validated, security-scoped queries
//  the dashboards use (through runDax -> the signed-in user's RLS). It reads the
//  model's measure catalogue for "explain this measure" and narrates the results.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { requireAuth } from "./auth.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5";
const MODEL_DIR = process.env.PBI_MODEL_DIR ||
  "C:\\Project\\PBI-Model\\SWiSH ANALYTICS.SemanticModel\\definition\\tables";

const PERIODS = ["current", "today", "yesterday", "last7", "thisWeek", "lastWeek", "thisMonth", "lastMonth"];

// ---- measure catalogue (parsed once from the TMDL model) --------------------
let CATALOG = null;
function loadCatalog() {
  if (CATALOG) return CATALOG;
  const out = [];
  try {
    for (const file of fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith(".tmdl"))) {
      const text = fs.readFileSync(path.join(MODEL_DIR, file), "utf8");
      const lines = text.split(/\r?\n/);
      let table = file.replace(/\.tmdl$/, "");
      const t = lines.find((l) => /^table\s+/.test(l));
      if (t) table = t.replace(/^table\s+/, "").replace(/^'|'$/g, "").trim();
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\t+)measure\s+(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))\s*=(.*)$/);
        if (!m) continue;
        const indent = m[1].length, name = m[2] || m[3] || m[4];
        const parts = m[5].trim() ? [m[5].trim()] : [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (l.trim() === "") { parts.push(""); continue; }
          const li = (l.match(/^\t*/)[0]).length;
          if (li <= indent) break;
          if (li === indent + 1 && /^\t+(formatString|lineageTag|displayFolder|isHidden|description|dataType|kpi|annotation|formatStringDefinition|changedProperty)\b/.test(l)) break;
          parts.push(l.replace(new RegExp(`^\\t{0,${indent + 2}}`), ""));
        }
        out.push({ name, table, expr: parts.join("\n").trim() });
        i = j - 1;
      }
    }
  } catch (e) { console.warn("  [assistant] could not read measure model:", e.message); }
  CATALOG = out;
  console.log(`  [assistant] measure catalogue: ${out.length} measures`);
  return out;
}
export function measureCatalog() { return loadCatalog(); }
function findMeasure(q) {
  const cat = loadCatalog();
  const clean = String(q || "").replace(/[\[\]'"]/g, "").trim().toLowerCase();
  return cat.find((m) => m.name.toLowerCase() === clean) || cat.find((m) => m.name.toLowerCase().includes(clean));
}

const pctDelta = (a, b) => (isFinite(a) && isFinite(b) && Number(b) !== 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
const nz = (v) => (isFinite(Number(v)) ? Number(v) : 0);

// ---- the tools Claude may call (each maps to existing validated DAX) ---------
const TOOLS = [
  { name: "get_overview", description: "Headline KPIs for a period with weekday-aligned comparisons: net sales, orders, AOV, target, gap, each vs last week / last month / last year. Use for totals and any 'why are sales up/down' question. Scoped to the current brand filter unless a brand is given.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: PERIODS }, brand: { type: "string", description: "exact brand full name to scope to; omit to use the current filter" } } } },
  { name: "get_brands", description: "Per-brand net sales for a period with vs last week/month/year. Use to compare or rank brands.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: PERIODS } } } },
  { name: "get_branches", description: "Per-branch net, target, gap, orders, AOV and WoW for a period, optionally within one brand. Use for 'which branches missed target' or best/worst branches.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: PERIODS }, brand: { type: "string" } } } },
  { name: "get_channels", description: "Per order-source/channel net, share, orders, AOV and WoW for a period. Use for channel mix, top channel by AOV, delivery vs in-store.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: PERIODS }, brand: { type: "string" } } } },
  { name: "explain_measure", description: "Return the exact DAX definition of a model measure by name so you can explain what it computes in plain language.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_measures", description: "Search the model's measure catalogue by keyword; returns matching measure names and their table.",
    input_schema: { type: "object", properties: { query: { type: "string" } } } },
];

// ---- tool executor (all data goes through the scoped runDax) -----------------
function makeExec(deps) {
  const runViz = async (vizName, { period, brand, scope }) => {
    deps.CURRENT.brand = brand && brand !== "all" ? brand : null;
    const range = deps.rangeFromReq({ preset: period });
    const v = deps.VIZ[vizName];
    const rows = await deps.runDax(v.dax(range, { loc: scope || "" }));
    return deps.mapViz(v, rows);
  };
  return async function exec(name, input, ctx) {
    // Enforce the signed-in user's row-level security on every AI tool query.
    // (Set right before the synchronous v.dax() build so brandFilterVar bakes their scope in.)
    if (ctx.user) deps.CURRENT.user = ctx.user;
    const period = input.period && input.period !== "current" ? input.period : (ctx.sel?.preset || "today");
    const brand = input.brand || ctx.brand || "all";
    const scope = ctx.scope || "";
    switch (name) {
      case "get_overview": {
        const r = await runViz("ov_compare", { period, brand, scope });
        return { period, brand: brand === "all" ? "All Brands" : brand,
          netSales: nz(r.net), orders: nz(r.ord), aov: nz(r.aov), dailyTarget: nz(r.tgtCur), gapToTarget: nz(r.net) - nz(r.tgtCur),
          netVsLastWeekPct: pctDelta(r.net, r.net_w), netVsLastMonthPct: pctDelta(r.net, r.net_m), netVsLastYearPct: pctDelta(r.net, r.net_y),
          ordersVsLastWeekPct: pctDelta(r.ord, r.ord_w), aovVsLastWeekPct: pctDelta(r.aov, r.aov_w),
          _measures: ["SUM('SALES DATA'[NET])", "'Append1'[Count of Orders]", "'Append1'[AOV]", "'FORECAST BRANCH'[Daily Target]"] };
      }
      case "get_brands": {
        const rows = await runViz("ov_compare_dim", { period, brand: "all", scope });
        return { period, brands: rows.slice(0, 20).map((r) => ({ brand: r.label, netSales: nz(r.netCur), vsLastWeekPct: pctDelta(r.netCur, r.netW), vsLastMonthPct: pctDelta(r.netCur, r.netM), vsLastYearPct: pctDelta(r.netCur, r.netY) })),
          _measures: ["SUM('SALES DATA'[NET])"] };
      }
      case "get_branches": {
        const rows = await runViz("ov_branches", { period, brand, scope });
        const mapped = rows.map((r) => ({ brand: r.brand, branch: r.label, netSales: nz(r.net), target: nz(r.target), gap: nz(r.net) - nz(r.target), achievedPct: r.target ? Math.round((r.net / r.target) * 1000) / 10 : null, orders: nz(r.orders), aov: nz(r.aov), vsLastWeekPct: pctDelta(r.net, r.net_w) }))
          .sort((a, b) => b.netSales - a.netSales);
        const missed = mapped.filter((b) => b.achievedPct != null && b.achievedPct < 100);
        return { period, brand: brand === "all" ? "All Brands" : brand, branchCount: mapped.length, missedTargetCount: missed.length, branches: mapped.slice(0, 30),
          _measures: ["SUM('SALES DATA'[NET])", "'FORECAST BRANCH'[Daily Target]", "'Append1'[Count of Orders]", "'Append1'[AOV]"] };
      }
      case "get_channels": {
        const rows = await runViz("ov_channels", { period, brand, scope });
        const total = rows.reduce((s, r) => s + nz(r.net), 0) || 1;
        return { period, brand: brand === "all" ? "All Brands" : brand,
          channels: rows.map((r) => ({ channel: r.label, netSales: nz(r.net), sharePct: Math.round((nz(r.net) / total) * 1000) / 10, orders: nz(r.orders), aov: nz(r.aov), vsLastWeekPct: pctDelta(r.net, r.net_w) })),
          _measures: ["SUM('SALES DATA'[NET])", "'Append1'[Count of Orders]", "'Append1'[AOV]"] };
      }
      case "explain_measure": {
        const hit = findMeasure(input.name);
        if (!hit) return { found: false, message: `No measure named "${input.name}". Use list_measures to search.` };
        return { found: true, name: hit.name, table: hit.table, dax: hit.expr };
      }
      case "list_measures": {
        const q = String(input.query || "").toLowerCase();
        const hits = loadCatalog().filter((m) => m.name.toLowerCase().includes(q)).slice(0, 25).map((m) => ({ name: m.name, table: m.table }));
        return { query: input.query, count: hits.length, measures: hits };
      }
      default: return { error: "unknown tool" };
    }
  };
}

function systemPrompt(ctx) {
  const brandLine = ctx.brand && ctx.brand !== "all" ? ctx.brand : "All Brands";
  const brands = (ctx.brands || []).join(", ");
  return `You are the embedded AI analyst inside the SWiSH QSR analytics platform (a Kuwait multi-brand restaurant group). You answer business questions from the company's live Power BI model.

STRICT GROUNDING — non-negotiable:
- Every figure you state MUST come from a tool result. NEVER invent, estimate, guess or extrapolate a number. If the tools cannot answer, say so plainly and suggest what you CAN answer.
- You cannot write DAX. You only call the provided tools, which run the same validated, security-scoped queries the dashboards use. The user only ever sees data their security scope allows.
- Cite the measure(s) behind your numbers briefly and naturally (e.g. "from Net + Daily Target").

STYLE:
- Be concise and executive: 2–5 sentences, plain English, currency in KD, round sensibly.
- For "why up/down" questions use get_overview and decompose: Net = Orders × AOV. Say whether the move was driven by order VOLUME or average TICKET (compare ordersVsLastWeekPct vs aovVsLastWeekPct), then name the biggest brand/branch/channel contributor if useful (call get_brands/get_branches/get_channels).
- For "explain this page" or "why is this red", use the current page + filters below and the relevant tool, then explain what drives it.
- To explain what a metric means, call explain_measure and translate the DAX to plain language.
- Prefer the fewest tool calls that answer the question. Tools already default to the context below.
- You MAY end with ONE small chart when it truly clarifies, as a fenced block EXACTLY:
\`\`\`chart
{"type":"bar","title":"…","unit":"KD","data":[{"label":"…","value":123}]}
\`\`\`
  type is "bar" | "line" | "donut"; use ONLY numbers you obtained from tools.

CURRENT CONTEXT (already applied by tools unless you override):
- Page: ${ctx.page || "unknown"}
- Date selection: ${ctx.periodLabel || ctx.sel?.preset || "today"} (period "${ctx.sel?.preset || "today"}")
- Brand filter: ${brandLine}
- Role: ${ctx.role || "ceo"}
- Brands the user can pick: ${brands || "(loading)"}
${ctx.snapshot ? "- On screen now: " + ctx.snapshot : ""}

Tool period values: current (=the selection above), today, yesterday, last7, thisWeek, lastWeek, thisMonth, lastMonth.
Remember: your commentary is AI-generated; the figures come live from the model.`;
}

function extractChart(text) {
  const m = text.match(/```chart\s*([\s\S]*?)```/);
  if (!m) return { text: text.trim(), chart: null };
  let chart = null;
  try {
    const c = JSON.parse(m[1].trim());
    if (c && ["bar", "line", "donut"].includes(c.type) && Array.isArray(c.data) && c.data.length) {
      chart = { type: c.type, title: String(c.title || ""), unit: String(c.unit || ""), data: c.data.filter((d) => d && d.label != null && isFinite(Number(d.value))).map((d) => ({ label: String(d.label), value: Number(d.value) })) };
    }
  } catch { /* ignore malformed chart */ }
  return { text: text.replace(m[0], "").trim(), chart };
}

async function anthropic({ key, system, messages }) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1400, system, tools: TOOLS, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || JSON.stringify(j));
  return j;
}

// registers POST /api/assistant on the given express app
export function registerAssistant(app, deps) {
  loadCatalog(); // warm the catalogue at startup
  const exec = makeExec(deps);
  app.post("/api/assistant", requireAuth, async (req, res) => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ text: "⚠️ The AI assistant isn't configured yet — add `ANTHROPIC_API_KEY` to server/.env and restart the server. Everything else (dashboards, live figures) works normally.", sources: [], note: "not-configured" });
    if (!deps.LIVE) return res.json({ text: "I can only answer from the live Power BI model, and it isn't connected right now (sample mode). Fill in server/.env to go live.", sources: [], note: "sample" });
    const { message, history = [], context: ctxIn = {} } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: "empty message" });
    const context = { ...ctxIn, user: req.user };   // bind the signed-in user so every tool query is RLS-scoped to them
    try {
      const system = systemPrompt(context);
      const messages = [
        ...(Array.isArray(history) ? history : []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .slice(-8).map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: String(message) },
      ];
      const sourceSet = new Set(); const usedTools = [];
      let final = "";
      for (let step = 0; step < 5; step++) {
        const resp = await anthropic({ key, system, messages });
        if (resp.stop_reason === "tool_use") {
          messages.push({ role: "assistant", content: resp.content });
          const results = [];
          for (const block of resp.content) {
            if (block.type !== "tool_use") continue;
            usedTools.push(block.name);
            let out;
            try { out = await exec(block.name, block.input || {}, context); }
            catch (e) { out = { error: String(e.message || e) }; }
            if (out && out._measures) out._measures.forEach((x) => sourceSet.add(x));
            const clean = { ...out }; delete clean._measures;
            results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(clean) });
          }
          messages.push({ role: "user", content: results });
          continue;
        }
        final = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        break;
      }
      if (!final) final = "I wasn't able to compose an answer from the model just now — try rephrasing, or ask about sales, targets, brands, branches or channels.";
      const { text, chart } = extractChart(final);
      res.json({ text, chart, sources: [...sourceSet], tools: [...new Set(usedTools)] });
    } catch (e) {
      res.status(500).json({ text: "Sorry — I hit an error reaching the model: " + String(e.message || e), sources: [] });
    }
  });
}

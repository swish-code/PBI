// ============================================================================
//  FREE VOICE BRIEF — no AI / no Claude, zero external API cost.
//  Answers voice/text questions by keyword-routing to the SAME validated,
//  RLS-scoped DAX the dashboards use, then composing plain-English answers from
//  templates. Deterministic and free. Understands brand + period named in the
//  question itself (e.g. "why were Yelo sales down yesterday"), runs a multi-
//  factor diagnostic across locations, channels, volume/ticket and peak hours,
//  and says "oops, I don't know" for anything out of scope.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WH_FILE = path.join(__dirname, "data", "working-hours.json");
function loadWH() { try { const j = JSON.parse(fs.readFileSync(WH_FILE, "utf8")); return { hours: j.hours || {}, default: Number(j.default) || 14 }; } catch { return { hours: {}, default: 14 }; } }

const nz = (v) => (isFinite(Number(v)) ? Number(v) : 0);
const pct = (a, b) => (isFinite(a) && isFinite(b) && Number(b) !== 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
const kd = (n) => "KD " + Math.round(nz(n)).toLocaleString("en-US");
const cnt = (n) => Math.round(nz(n)).toLocaleString("en-US");
const dirWord = (p) => (p == null ? "flat" : p > 0 ? `up ${p}%` : `down ${Math.abs(p)}%`);
const hh = (h) => { const n = ((Number(h) % 24) + 24) % 24; const am = n < 12; const h12 = n % 12 || 12; return `${h12} ${am ? "AM" : "PM"}`; };

const PERIOD_LABEL = { today: "today", yesterday: "yesterday", last7: "the last 7 days", thisWeek: "this week", lastWeek: "last week", thisMonth: "this month", lastMonth: "last month" };

function periodFromMsg(q) {
  if (/\byesterday\b/.test(q)) return "yesterday";
  if (/\btoday\b/.test(q)) return "today";
  if (/\blast week\b/.test(q)) return "lastWeek";
  if (/\bthis week\b/.test(q)) return "thisWeek";
  if (/\blast month\b/.test(q)) return "lastMonth";
  if (/\b(this month|month to date|mtd)\b/.test(q)) return "thisMonth";
  if (/\b(last 7|past 7|last seven|rolling week|trailing week)\b/.test(q)) return "last7";
  return null;
}
function brandFromMsg(q, brands) {
  const t = " " + q + " ";
  let best = null;
  for (const b of brands || []) {
    const bn = String(b).toLowerCase();
    if (t.includes(bn) && (!best || bn.length > best.len)) best = { name: b, len: bn.length };
  }
  // common short aliases
  if (!best) { if (/\byelo\b/.test(t)) return findBrand(brands, "yelo"); }
  return best ? best.name : null;
}
function findBrand(brands, needle) { return (brands || []).find((b) => String(b).toLowerCase().includes(needle)) || null; }

export function registerVoiceBrief(app, deps) {
  // run one existing viz through the scoped runDax (RLS baked in via CURRENT.user)
  const run = async (vizName, { period, brand, custom, user }) => {
    if (user) deps.CURRENT.user = user;
    deps.CURRENT.brand = brand && brand !== "all" ? brand : null;
    const range = deps.rangeFromReq(custom || { preset: period });
    const v = deps.VIZ[vizName];
    const rows = await deps.runDax(v.dax(range, { loc: "" }));
    return deps.mapViz(v, rows);
  };

  app.post("/api/voice-brief", requireAuth, async (req, res) => {
    if (!deps.LIVE) return res.json({ text: "I can only read your live numbers, and the Power BI model isn't connected right now." });
    const { message = "", context: ctx = {} } = req.body || {};
    const q = String(message).toLowerCase().replace(/[?.!,]/g, " ").replace(/\s+/g, " ").trim();
    const brands = ctx.brands || [];

    // brand + period can be named in the question; otherwise fall back to the app's current filters
    const sel = ctx.sel || {};
    const selPeriod = sel.preset && sel.preset !== "custom" ? sel.preset : "today";
    const custom0 = sel.preset === "custom" && sel.start ? { start: sel.start, end: sel.end } : null;
    const msgBrand = brandFromMsg(q, brands);
    const msgPeriod = periodFromMsg(q);
    const brand = msgBrand || (ctx.brand && ctx.brand !== "all" ? ctx.brand : "all");
    const period = msgPeriod || selPeriod;
    const custom = msgPeriod ? null : custom0;               // a named period overrides a custom range
    const periodLabel = msgPeriod ? PERIOD_LABEL[msgPeriod] : (ctx.periodLabel || PERIOD_LABEL[selPeriod] || selPeriod);
    const brandLabel = brand === "all" ? "all brands" : brand;
    const args = { period, brand, custom, user: req.user };

    try {
      // ---- HELP / CAPABILITIES ----
      if (/\b(help|what can (you|i)|what do you|how do you work|what can i ask|commands?)\b/.test(q)) {
        return res.json({ text: "You can ask me about sales and targets, top brands, channel mix, average order value, busiest hour, best and worst branch, why sales moved, top complaint categories and issues, prep and delivery times, offline rate, hidden items, and I can suggest where to focus. Ask about any brand and day." });
      }

      // ---- TOP COMPLAINT CATEGORIES / ISSUES / REASONS ----
      if (/\b(complaint|complaints|issue|issues|problem|problems|categor|top reason|reasons?|refund|wrong order|missing|cold food)\b/.test(q)) {
        const wantReasons = /\b(reason|reasons|specific|detail|exactly|breakdown)\b/.test(q);
        const [cats, resp] = await Promise.all([run("ops_complaint_cat", args).catch(() => []), run("ops_complaint_resp", args).catch(() => [])]);
        if (!Array.isArray(cats) || !cats.length) return res.json({ text: `No complaints recorded for ${brandLabel}, ${periodLabel}. Alhamdulillah.` });
        let text;
        if (wantReasons) {
          const piv = await run("ops_complaint_pivot", args).catch(() => []);
          const reasons = (Array.isArray(piv) ? piv : []).slice().sort((a, b) => nz(b.count) - nz(a.count)).slice(0, 4).map((r) => `${r.reason} (${cnt(r.count)})`);
          text = reasons.length ? `Top complaint reasons for ${brandLabel}, ${periodLabel}: ${reasons.join("; ")}.` : "";
        }
        if (!text) {
          const total = cats.reduce((s, c) => s + nz(c.value), 0) || 1;
          const sorted = [...cats].sort((a, b) => nz(b.value) - nz(a.value));
          const top = sorted.slice(0, 4).map((c) => `${c.label}, ${cnt(c.value)} (${Math.round((nz(c.value) / total) * 100)}%)`);
          text = `Top complaint categories for ${brandLabel}, ${periodLabel}: ${top.join("; ")}. The biggest to tackle is ${sorted[0].label}.`;
        }
        const rp = (Array.isArray(resp) ? resp : []).slice().sort((a, b) => nz(b.value) - nz(a.value))[0];
        if (rp) text += ` Most are ${rp.label}'s responsibility (${cnt(rp.value)} cases).`;
        return res.json({ text });
      }

      // ---- HIDDEN / OUT-OF-STOCK ITEMS ----
      if (/\b(hidden|out of stock|unavailable|84|eighty ?four|turned off|item off)\b/.test(q)) {
        const items = await run("ops_hidden_items", args).catch(() => []);
        if (!Array.isArray(items) || !items.length) return res.json({ text: `No hidden items recorded for ${brandLabel}, ${periodLabel}.` });
        const top = [...items].sort((a, b) => nz(b.times) - nz(a.times)).slice(0, 4).map((r) => `${r.label}, hidden ${cnt(r.times)} times (${cnt(r.minutes)} minutes)`);
        return res.json({ text: `Most hidden items for ${brandLabel}, ${periodLabel}: ${top.join("; ")}. These are lost-sales risks worth fixing first.` });
      }

      // ---- OFFLINE RATE (working-hours based) ----
      if (/\boffline\b|\bbusy time\b|\bavailability\b/.test(q)) {
        const rows = await run("ops_offline_calc", { ...args }).catch(() => []);
        const wh = loadWH();
        let busy = 0, avail = 0; const per = [];
        for (const r of (Array.isArray(rows) ? rows : [])) {
          const days = nz(r.salesDays); if (days <= 0) continue;
          const k = `${r.brand}::${r.location}`; const hrs = wh.hours[k] != null ? Number(wh.hours[k]) : wh.default;
          const a = hrs * 60 * days; busy += nz(r.busyMin); avail += a;
          per.push({ loc: r.location, rate: a > 0 ? nz(r.busyMin) / a : 0 });
        }
        const rate = avail > 0 ? busy / avail : null;
        per.sort((a, b) => b.rate - a.rate);
        if (rate == null) return res.json({ text: `No offline time recorded for ${brandLabel}, ${periodLabel}.` });
        let text = `Offline rate for ${brandLabel}, ${periodLabel} is ${(rate * 100).toFixed(1)}%`;
        if (per[0] && per[0].rate > 0) text += `. Highest at ${per.slice(0, 3).map((p) => `${p.loc} (${(p.rate * 100).toFixed(1)}%)`).join(", ")}.`;
        return res.json({ text });
      }

      // ---- PREP / DELIVERY / RATING / OPERATIONS SUMMARY ----
      if (/\b(prep|preparation|delivery time|kitchen|rating|reviews?|operations?|service|fulfil|how fast)\b/.test(q)) {
        const o = await run("ops_kpis", args);
        const bits = [
          `complaint rate ${(nz(o.complaint) * 100).toFixed(2)}%`,
          `average prep ${nz(o.prep).toFixed(1)} minutes`,
          `average delivery ${nz(o.delivery).toFixed(1)} minutes`,
          `rating ${nz(o.rating).toFixed(2)} out of 5`,
        ];
        return res.json({ text: `Operations for ${brandLabel}, ${periodLabel}: ${bits.join(", ")}.` });
      }

      // ---- SUGGESTIONS / WHERE TO FOCUS ----
      if (/\b(suggest|recommend|advice|advise|what should|where.*focus|focus on|improve|action|priorit)\b/.test(q)) {
        return res.json({ text: await suggest({ ...args, periodLabel, brandLabel }) });
      }

      // ---- WHY did sales move — multi-factor diagnostic ----
      if (/\bwhy\b|what happened|reason|explain the (drop|fall|rise|jump)|what drove/.test(q)) {
        return res.json({ text: await diagnose({ ...args, periodLabel, brandLabel }) });
      }

      // ---- BRAND RANKING ----
      if (/\b(which|top|best|leading|biggest)\b.*\bbrand|brand.*\b(rank|leader|leading|best|top)\b|top brands?\b/.test(q)) {
        const rows = await run("ov_compare_dim", { ...args, brand: "all" });
        if (!rows.length) return res.json({ text: `No brand sales found for ${periodLabel}.` });
        const top = rows.slice(0, 3).map((r, i) => `${i + 1}. ${r.label}, ${kd(r.netCur)}`);
        const worst = rows[rows.length - 1];
        let text = `Top brands for ${periodLabel}: ${top.join("; ")}.`;
        if (rows.length > 3 && worst) text += ` The lowest is ${worst.label} at ${kd(worst.netCur)}.`;
        return res.json({ text });
      }

      // ---- CHANNEL / ORDER SOURCE MIX ----
      if (/\b(channel|order source|delivery|talabat|deliveroo|jahez|walk|dine ?in|aggregator|pickup|carhop|cari)\b/.test(q)) {
        const rows = await run("ov_channels", args);
        if (!rows.length) return res.json({ text: `No channel data for ${brandLabel}, ${periodLabel}.` });
        const total = rows.reduce((s, r) => s + nz(r.net), 0) || 1;
        const top = rows.slice(0, 3).map((r) => `${r.label}, ${kd(r.net)}, ${Math.round((nz(r.net) / total) * 100)} percent`);
        return res.json({ text: `Channel mix for ${brandLabel}, ${periodLabel}: ${top.join("; ")}.` });
      }

      // ---- BEST / WORST BRANCH (LOCATION) ----
      if (/\b(branch|location|store|outlet|worst|weakest|strongest|best branch|top branch)\b/.test(q)) {
        const rows = await run("ov_branches", args);
        if (!Array.isArray(rows) || !rows.length) return res.json({ text: `No branch data for ${brandLabel}, ${periodLabel}.` });
        const sorted = [...rows].sort((a, b) => nz(b.net) - nz(a.net));
        const best = sorted[0], worst = sorted[sorted.length - 1];
        const wantWorst = /\b(worst|weakest|lowest|bottom|below)\b/.test(q);
        if (wantWorst) return res.json({ text: `For ${brandLabel}, ${periodLabel}, the weakest branch is ${worst.label} at ${kd(worst.net)}. The strongest is ${best.label} at ${kd(best.net)}.` });
        return res.json({ text: `For ${brandLabel}, ${periodLabel}, the top branch is ${best.label} at ${kd(best.net)}${best.target ? `, ${Math.round(nz(best.net) / nz(best.target) * 100)} percent of target` : ""}. The weakest is ${worst.label} at ${kd(worst.net)}.` });
      }

      // ---- AOV ----
      if (/\b(aov|average order|average ticket|basket size|spend per order)\b/.test(q)) {
        const o = await run("ov_compare", args);
        let text = `For ${brandLabel}, ${periodLabel}, the average order value is ${kd(o.aov)}`;
        if (o.aov_w != null) text += `, ${dirWord(pct(nz(o.aov), nz(o.aov_w)))} versus last week`;
        return res.json({ text: text + "." });
      }

      // ---- ORDERS / COUNT ----
      if (/\b(how many orders|order count|number of orders|transactions|covers|tickets)\b/.test(q)) {
        const o = await run("ov_compare", args);
        let text = `For ${brandLabel}, ${periodLabel}, there were ${cnt(o.ord)} orders`;
        if (o.ord_w != null) text += `, ${dirWord(pct(nz(o.ord), nz(o.ord_w)))} versus last week`;
        return res.json({ text: text + `, at ${kd(o.aov)} average.` });
      }

      // ---- BUSIEST / PEAK HOUR ----
      if (/\b(busiest|peak|rush|what hour|which hour|best time|busy time)\b/.test(q)) {
        const rows = await run("ov_hourly", args);
        if (!Array.isArray(rows) || !rows.length) return res.json({ text: `No hourly data for ${brandLabel}, ${periodLabel}.` });
        const peak = [...rows].sort((a, b) => nz(b.value) - nz(a.value))[0];
        return res.json({ text: `For ${brandLabel}, ${periodLabel}, the busiest hour is around ${hh(peak.x)} with ${kd(peak.value)} in sales.` });
      }

      // ---- TARGET / ACHIEVEMENT ----
      if (/\b(target|behind|miss|missed|gap|achiev|on track|pace|forecast|below)\b/.test(q)) {
        const o = await run("ov_compare", args);
        const net = nz(o.net), tgt = nz(o.tgtCur), gap = net - tgt;
        const achieved = tgt ? Math.round((net / tgt) * 100) : null;
        let branches = [];
        try { branches = await run("ov_branches", args); } catch { /* optional */ }
        const missed = (Array.isArray(branches) ? branches : []).filter((b) => nz(b.target) > 0 && nz(b.net) < nz(b.target)).length;
        let text = `For ${brandLabel}, ${periodLabel}, net sales are ${kd(net)} against a target of ${kd(tgt)}`;
        text += achieved != null ? `, ${achieved} percent of target` : "";
        text += tgt ? (gap >= 0 ? `, ahead by ${kd(Math.abs(gap))}.` : `, behind by ${kd(Math.abs(gap))}.`) : ".";
        if (missed) text += ` ${missed} branch${missed > 1 ? "es are" : " is"} below target.`;
        return res.json({ text });
      }

      // ---- GENERAL BRIEF ("how are we doing", "read this page", "sales") ----
      if (/\b(how are we|how('?s| is) it going|read (this|the)|brief|summar|catch me up|sales|net sales|revenue|doing|performance|update|overview|numbers|status)\b/.test(q) || q.length < 3) {
        const o = await run("ov_compare", args);
        const net = nz(o.net), ord = nz(o.ord), aov = nz(o.aov), tgt = nz(o.tgtCur);
        let text = `For ${brandLabel}, ${periodLabel}: net sales ${kd(net)}`;
        if (o.net_w != null) text += `, ${dirWord(pct(net, nz(o.net_w)))} versus the same day last week`;
        text += `. ${cnt(ord)} orders at ${kd(aov)} average order value.`;
        if (tgt) text += ` Target ${kd(tgt)}, ${net >= tgt ? "ahead" : "behind"} by ${kd(Math.abs(net - tgt))}.`;
        return res.json({ text });
      }

      // ---- OUT OF SCOPE ----
      return res.json({ text: "Oops, I don't know that one yet — I'm still in my testing phase and learning. Try asking about sales, targets, top brands, channels, average order value, busiest hour, best or worst branch, or why sales moved for a brand and day.", unknown: true });
    } catch (e) {
      return res.json({ text: "Sorry, I couldn't read that from the model just now. Try asking about sales, targets, top brands or channels." });
    }
  });

  // ---- the multi-factor "why did sales move" engine --------------------------
  // Looks across the whole sales model: total move, volume vs ticket, which
  // LOCATIONS dropped, which CHANNELS dropped, and which peak HOURS underperformed.
  // studies sales + ops data and returns prioritised, plain-language suggestions
  async function suggest({ period, brand, custom, user, periodLabel, brandLabel }) {
    const a = { period, brand, custom, user };
    const [ov, cats, chs, brs, off, hid] = await Promise.all([
      run("ov_compare", a),
      run("ops_complaint_cat", a).catch(() => []),
      run("ov_channels", a).catch(() => []),
      run("ov_branches", a).catch(() => []),
      run("ops_offline_calc", a).catch(() => []),
      run("ops_hidden_items", a).catch(() => []),
    ]);
    const recs = [];
    const netP = ov.net_w != null ? pct(nz(ov.net), nz(ov.net_w)) : null;
    const ch = (Array.isArray(chs) ? chs : []).map((c) => ({ name: c.label, d: c.net_w != null ? nz(c.net) - nz(c.net_w) : null, p: c.net_w != null ? pct(nz(c.net), nz(c.net_w)) : null })).filter((c) => c.d != null).sort((x, y) => x.d - y.d)[0];
    if (ch && ch.d < 0) recs.push(`Recover ${ch.name}, ${dirWord(ch.p)} versus last week — the biggest channel drop.`);
    const br = (Array.isArray(brs) ? brs : []).map((b) => ({ loc: b.label, net: nz(b.net), tgt: nz(b.target) })).filter((b) => b.tgt > 0).map((b) => ({ ...b, gap: b.tgt - b.net })).sort((x, y) => y.gap - x.gap)[0];
    if (br && br.gap > 0) recs.push(`${br.loc} is ${kd(br.gap)} behind target — the widest branch gap.`);
    const cat = (Array.isArray(cats) ? cats : []).slice().sort((a2, b2) => nz(b2.value) - nz(a2.value))[0];
    if (cat) recs.push(`Tackle the top complaint, ${cat.label} (${cnt(cat.value)} cases).`);
    const resp = await run("ops_complaint_resp", a).catch(() => []);
    const rp = (Array.isArray(resp) ? resp : []).slice().sort((x, y) => nz(y.value) - nz(x.value))[0];
    if (rp && nz(rp.value) > 0) recs.push(`Most complaints trace to ${rp.label} (${cnt(rp.value)}) — review that area.`);
    const wh = loadWH(); const per = [];
    for (const r of (Array.isArray(off) ? off : [])) { const days = nz(r.salesDays); if (days <= 0) continue; const k = `${r.brand}::${r.location}`; const hrs = wh.hours[k] != null ? Number(wh.hours[k]) : wh.default; const av = hrs * 60 * days; per.push({ loc: r.location, rate: av > 0 ? nz(r.busyMin) / av : 0 }); }
    per.sort((a2, b2) => b2.rate - a2.rate);
    if (per[0] && per[0].rate > 0.05) recs.push(`Cut offline time at ${per[0].loc} (${(per[0].rate * 100).toFixed(1)}%).`);
    const topHid = (Array.isArray(hid) ? hid : []).slice().sort((a2, b2) => nz(b2.times) - nz(a2.times))[0];
    if (topHid && nz(topHid.times) > 0) recs.push(`Keep ${topHid.label} in stock — hidden ${cnt(topHid.times)} times.`);
    const head = `Looking at ${brandLabel} for ${periodLabel}${netP != null ? `, sales are ${dirWord(netP)} versus last week` : ""}. `;
    if (!recs.length) return head + "Nothing urgent stands out — keep protecting your top outlets and channels. Alhamdulillah.";
    return head + "Here's where I'd focus: " + recs.slice(0, 4).map((r, i) => `${i + 1}. ${r}`).join(" ");
  }

  async function diagnose({ period, brand, custom, user, periodLabel, brandLabel }) {
    const a = { period, brand, custom, user };
    const o = await run("ov_compare", a);
    const net = nz(o.net), netW = nz(o.net_w);
    const netP = o.net_w != null ? pct(net, netW) : null;

    // headline
    let out;
    if (netP == null) out = `For ${brandLabel}, ${periodLabel}, net sales are ${kd(net)}. I don't have a same-day-last-week baseline for this range, so here's what's driving the mix.`;
    else out = `For ${brandLabel}, ${periodLabel}, net sales are ${kd(net)}, ${dirWord(netP)} versus the same day last week (${kd(netW)}). Here's what's behind it:`;

    const reasons = [];

    // 1) volume vs ticket
    if (o.ord_w != null && o.aov_w != null) {
      const op = pct(nz(o.ord), nz(o.ord_w)), ap = pct(nz(o.aov), nz(o.aov_w));
      const lead = Math.abs(op || 0) >= Math.abs(ap || 0) ? "order volume" : "average order value";
      reasons.push(`Orders are ${dirWord(op)} and average order value is ${dirWord(ap)}, so the move is driven mainly by ${lead}.`);
    }

    // 2) locations that moved most (only meaningful when a brand is scoped → dim = Location)
    if (brand && brand !== "all") {
      try {
        const locs = await run("ov_compare_dim", a);
        const withW = locs.filter((l) => l.netW != null && nz(l.netW) > 0).map((l) => ({ name: l.label, d: nz(l.netCur) - nz(l.netW), p: pct(nz(l.netCur), nz(l.netW)) }));
        const dropped = withW.filter((l) => l.d < 0).sort((x, y) => x.d - y.d).slice(0, 2);
        const gained = withW.filter((l) => l.d > 0).sort((x, y) => y.d - x.d)[0];
        if (dropped.length) reasons.push(`By location, ${dropped.map((l) => `${l.name} is ${dirWord(l.p)} (${kd(Math.abs(l.d))})`).join(", and ")}.`);
        if (gained && gained.d > 0) reasons.push(`${gained.name} held up, ${dirWord(gained.p)}.`);
      } catch { /* skip */ }
    }

    // 3) channels that moved most
    try {
      const chs = await run("ov_channels", a);
      const withW = chs.filter((c) => c.net_w != null).map((c) => ({ name: c.label, d: nz(c.net) - nz(c.net_w), p: pct(nz(c.net), nz(c.net_w)) }));
      const drop = withW.filter((c) => c.d < 0).sort((x, y) => x.d - y.d)[0];
      if (drop && drop.d < 0) reasons.push(`On channels, ${drop.name} is ${dirWord(drop.p)} (${kd(Math.abs(drop.d))}), the biggest source of the drop.`);
    } catch { /* skip */ }

    // 4) peak hours that underperformed vs last week
    try {
      const hrs = await run("ov_hourly", a);
      const withLW = hrs.filter((h) => h.lastWeek != null && nz(h.lastWeek) > 0).map((h) => ({ x: h.x, d: nz(h.value) - nz(h.lastWeek), p: pct(nz(h.value), nz(h.lastWeek)), lw: nz(h.lastWeek) }));
      // pick the peak-period hour (high last-week volume) with the worst shortfall
      const peakLW = Math.max(...withLW.map((h) => h.lw), 0);
      const peakHours = withLW.filter((h) => h.lw >= peakLW * 0.6 && h.d < 0).sort((x, y) => x.d - y.d).slice(0, 2);
      if (peakHours.length) reasons.push(`During peak hours, ${peakHours.map((h) => `${hh(h.x)} is ${dirWord(h.p)}`).join(" and ")} versus last week.`);
    } catch { /* skip */ }

    if (!reasons.length) reasons.push("The change is spread evenly — no single location, channel or hour stands out.");
    return out + " " + reasons.join(" ");
  }
}

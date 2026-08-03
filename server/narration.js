// ============================================================================
//  SWiSH AI NARRATION — a full executive morning-brief, composed from the SAME
//  validated, RLS-scoped DAX the dashboards use. No AI / no Claude: deterministic
//  templates stitched into one connected business story. Respects the active
//  date + brand filter and the signed-in user's data scope.
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
const kdM = (n) => { const v = nz(n); return Math.abs(v) >= 1e6 ? "KD " + (v / 1e6).toFixed(2) + " million" : kd(v); };
const cnt = (n) => Math.round(nz(n)).toLocaleString("en-US");
const dirWord = (p) => (p == null ? "flat" : p > 0 ? `up ${p}%` : `down ${Math.abs(p)}%`);
const upDown = (p) => (p == null ? "flat" : p >= 0 ? "up" : "down");
const firstName = (full) => (String(full || "").trim().split(/\s+/)[0] || "there");
function daypart() { const h = new Date().getHours(); return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"; }

export function registerNarration(app, deps) {
  const run = async (vizName, { period, brand, custom, user }) => {
    if (user) deps.CURRENT.user = user;
    deps.CURRENT.brand = brand && brand !== "all" ? brand : null;
    const range = deps.rangeFromReq(custom || { preset: period });
    const v = deps.VIZ[vizName];
    const rows = await deps.runDax(v.dax(range, { loc: "" }));
    return deps.mapViz(v, rows);
  };

  app.post("/api/narration", requireAuth, async (req, res) => {
    if (!deps.LIVE) return res.json({ error: "The live Power BI model isn't connected right now, so I can't build the briefing." });
    const { context: ctx = {} } = req.body || {};
    const brand = ctx.brand && ctx.brand !== "all" ? ctx.brand : "all";
    const sel = ctx.sel || {};
    const period = sel.preset && sel.preset !== "custom" ? sel.preset : "yesterday";
    const custom = sel.preset === "custom" && sel.start ? { start: sel.start, end: sel.end } : null;
    const periodLabel = ctx.periodLabel || (period === "yesterday" ? "yesterday" : period);
    const brandLabel = brand === "all" ? "all brands" : brand;
    const name = firstName(ctx.userName);
    // Warm, standalone greeting — spoken first and shown at the top of the card.
    const greeting = `Good ${daypart()}, ${name}. I hope you're having a great day. Here is your business briefing for ${brandLabel}, covering ${periodLabel} — let's take a look at how we performed.`;
    const args = { period, brand, custom, user: req.user };

    try {
      const [ov, ach, dim, channels, branches, offRows] = await Promise.all([
        run("ov_compare", args),
        run("landing_achievement", args),
        run("ov_compare_dim", args),
        run("ov_channels", args).catch(() => []),
        run("ov_branches", args).catch(() => []),
        run("ops_offline_calc", args).catch(() => []),
      ]);

      const net = nz(ov.net), netW = nz(ov.net_w), ord = nz(ov.ord), ordW = nz(ov.ord_w), aov = nz(ov.aov), aovW = nz(ov.aov_w);
      if (net === 0 && ord === 0) {
        return res.json({ empty: true, greeting, text: `${greeting} There are no sales recorded for ${brandLabel} in ${periodLabel} yet, so there's nothing to brief on. Try a different date or brand.`, sections: [] });
      }
      const sections = [];
      const netP = ov.net_w != null ? pct(net, netW) : null;
      const ordP = ov.ord_w != null ? pct(ord, ordW) : null;
      const aovP = ov.aov_w != null ? pct(aov, aovW) : null;

      // 1) headline / total sales
      let s1 = `For ${brandLabel}, ${periodLabel}, total sales reached ${kd(net)}`;
      if (netP != null) s1 += `, which is ${dirWord(netP)} versus the same day last week (${kd(netW)}) — a difference of ${kd(Math.abs(net - netW))}`;
      s1 += ".";
      if (netP != null && netP > 0) s1 += " Alhamdulillah, sales grew on the day.";
      sections.push({ title: "Total Sales", text: s1 });

      // 2) month-to-date
      const mtd = nz(ach.mtdSales), mtdTgt = nz(ach.mtdTarget);
      const mtdGap = mtdTgt - mtd, mtdGapP = mtdTgt ? Math.round((mtdGap / mtdTgt) * 1000) / 10 : null;
      let s2 = `Month to date, sales are ${kd(mtd)} against a target of ${kd(mtdTgt)}`;
      if (mtdTgt) s2 += mtdGap > 0 ? `, a gap of ${kd(mtdGap)} or ${mtdGapP}% behind target.` : `, ${kd(Math.abs(mtdGap))} (${Math.abs(mtdGapP)}%) ahead of target. Alhamdulillah.`;
      else s2 += ".";
      sections.push({ title: "Month-to-Date", text: s2 });

      // 3) projected month-end closing
      const close = nz(ach.monthForecast), monthTgt = nz(ach.monthTarget);
      const closeGap = close - monthTgt, closeP = monthTgt ? Math.round((closeGap / monthTgt) * 1000) / 10 : null;
      let s3 = `Based on the current run rate, In Sha Allah the projected month-end closing is ${kdM(close)}, against a monthly target of ${kdM(monthTgt)}`;
      if (monthTgt) s3 += close >= monthTgt ? ` — In Sha Allah on track to exceed target by ${kd(closeGap)} (${closeP}%). Alhamdulillah.` : ` — currently expected to finish ${kd(Math.abs(closeGap))} (${Math.abs(closeP)}%) below target.`;
      else s3 += ".";
      const targetAchievable = monthTgt ? close >= monthTgt * 0.995 : null;
      sections.push({ title: "Projected Month-End Closing", text: s3 });

      // 4) brand / dimension performance  (dim = brands at all-brands, locations when a brand is scoped)
      const dimIsBrand = brand === "all";
      const ranked = (Array.isArray(dim) ? dim : []).map((r) => ({ label: r.label, net: nz(r.netCur), p: r.netW != null ? pct(nz(r.netCur), nz(r.netW)) : null })).filter((r) => r.label).sort((a, b) => b.net - a.net);
      let leader = null, laggard = null;
      if (ranked.length) {
        const top = ranked.slice(0, 3);
        leader = top[0];
        const decliners = ranked.filter((r) => r.p != null && r.p < 0).sort((a, b) => a.p - b.p);
        laggard = decliners[0] || null;
        let s4 = dimIsBrand ? `Leading brands ${periodLabel}: ${top.map((r) => `${r.label} at ${kd(r.net)}${r.p != null ? ` (${dirWord(r.p)})` : ""}`).join("; ")}.`
          : `Leading outlets for ${brandLabel}: ${top.map((r) => `${r.label} at ${kd(r.net)}${r.p != null ? ` (${dirWord(r.p)})` : ""}`).join("; ")}.`;
        if (laggard) s4 += ` The biggest drag is ${laggard.label}, ${dirWord(laggard.p)} versus last week.`;
        sections.push({ title: dimIsBrand ? "Brand Performance" : "Outlet Performance", text: s4 });
      }

      // 5) run rate + ACC (average check) vs transaction count
      let s5 = `The average check, our ACC, was ${kd(aov)}${aovP != null ? `, ${dirWord(aovP)} versus last week` : ""}, on ${cnt(ord)} transactions${ordP != null ? ` (${dirWord(ordP)})` : ""}.`;
      if (ordP != null && aovP != null) {
        const driver = Math.abs(ordP) >= Math.abs(aovP) ? `transaction count (${dirWord(ordP)})` : `average check (${dirWord(aovP)})`;
        s5 += ` The ${upDown(netP)}ward move was driven mainly by ${driver}.`;
      }
      sections.push({ title: "Run Rate & ACC", text: s5 });

      // 6) order source analysis
      const chs = (Array.isArray(channels) ? channels : []).map((r) => ({ label: r.label, net: nz(r.net), d: r.net_w != null ? nz(r.net) - nz(r.net_w) : null, p: r.net_w != null ? pct(nz(r.net), nz(r.net_w)) : null })).filter((r) => r.label);
      const chTotal = chs.reduce((s, r) => s + r.net, 0) || 1;
      let worstCh = null, bestCh = null;
      if (chs.length) {
        const withD = chs.filter((r) => r.d != null);
        worstCh = withD.filter((r) => r.d < 0).sort((a, b) => a.d - b.d)[0] || null;
        bestCh = withD.filter((r) => r.d > 0).sort((a, b) => b.d - a.d)[0] || null;
        const mix = [...chs].sort((a, b) => b.net - a.net).slice(0, 3).map((r) => `${r.label} ${Math.round((r.net / chTotal) * 100)}%`).join(", ");
        let s6 = `By order source, the mix is ${mix}.`;
        if (worstCh) s6 += ` ${worstCh.label} had the largest negative impact, ${dirWord(worstCh.p)} (${kd(Math.abs(worstCh.d))}).`;
        if (bestCh) s6 += ` ${bestCh.label} held up best, ${dirWord(bestCh.p)}.`;
        sections.push({ title: "Order Source Analysis", text: s6 });
      }

      // 7) offline rate (working-hours based) — availability across EVERY available
      // brand×location combo for the whole selected period: hours × 60 × days-in-period.
      const wh = loadWH();
      const oRange = deps.rangeFromReq(custom || { preset: period });
      const periodDays = Math.round((Date.parse(oRange.end) - Date.parse(oRange.start)) / 86400000) + 1;
      let totBusy = 0, totAvail = 0; const offBranch = [];
      for (const r of (Array.isArray(offRows) ? offRows : [])) {
        const busy = nz(r.busyMin); const k = `${r.brand}::${r.location}`;
        const hrs = wh.hours[k] != null ? Number(wh.hours[k]) : wh.default;
        const avail = hrs * 60 * periodDays;
        totBusy += busy; totAvail += avail;
        offBranch.push({ loc: r.location, brand: r.brand, rate: avail > 0 ? busy / avail : 0 });
      }
      const offRate = totAvail > 0 ? totBusy / totAvail : null;
      offBranch.sort((a, b) => b.rate - a.rate);
      if (offRate != null) {
        let s7 = `The overall offline rate ${periodLabel} was ${(offRate * 100).toFixed(1)}%`;
        if (offBranch.length && offBranch[0].rate > 0) s7 += `. The highest offline outlets are ${offBranch.slice(0, 3).map((b) => `${b.loc} (${(b.rate * 100).toFixed(1)}%)`).join(", ")}, which risks lost sales during peak hours.`;
        else s7 += ".";
        sections.push({ title: "Offline Rate", text: s7 });
      }

      // 8) top outlet
      const brs = (Array.isArray(branches) ? branches : []).map((r) => ({ loc: r.label, brand: r.brand, net: nz(r.net), p: r.net_w != null ? pct(nz(r.net), nz(r.net_w)) : null })).filter((r) => r.loc);
      if (brs.length) {
        const totBr = brs.reduce((s, r) => s + r.net, 0) || 1;
        const top = [...brs].sort((a, b) => b.net - a.net)[0];
        const grower = [...brs].filter((r) => r.p != null).sort((a, b) => b.p - a.p)[0];
        const decliner = [...brs].filter((r) => r.p != null).sort((a, b) => a.p - b.p)[0];
        let s8 = `The top outlet was ${top.loc}${top.brand ? ` (${top.brand})` : ""} at ${kd(top.net)}, ${Math.round((top.net / totBr) * 100)}% of ${periodLabel}'s sales.`;
        if (grower && grower.p > 0) s8 += ` ${grower.loc} grew strongly, ${dirWord(grower.p)}.`;
        if (decliner && decliner.p != null && decliner.p < 0 && decliner.loc !== grower?.loc) s8 += ` ${decliner.loc} needs attention, ${dirWord(decliner.p)}.`;
        sections.push({ title: "Top Outlet", text: s8 });
      }

      // 9) executive summary — synthesise
      const wins = [];
      if (bestCh) wins.push(`${bestCh.label} grew`);
      if (leader && leader.p != null && leader.p > 0) wins.push(`${leader.label} led ${dirWord(leader.p)}`);
      const risks = [];
      if (worstCh) risks.push(`${worstCh.label} (${dirWord(worstCh.p)})`);
      if (laggard) risks.push(`${laggard.label} (${dirWord(laggard.p)})`);
      if (offBranch.length && offBranch[0].rate > 0.05) risks.push(`high offline at ${offBranch[0].loc}`);
      let s9 = `In summary: ${netP == null ? "sales held" : `sales were ${dirWord(netP)} on the day`}${wins.length ? `, helped by ${wins.join(" and ")}` : ""}.`;
      if (risks.length) s9 += ` The main gap came from ${risks.join(", ")}.`;
      if (targetAchievable != null) s9 += targetAchievable ? ` In Sha Allah the month-end target is currently achievable — Alhamdulillah.` : ` On the current run rate the month-end target is at risk.`;
      const action = worstCh ? `recover ${worstCh.label}` : laggard ? `support ${laggard.label}` : (offBranch[0] && offBranch[0].rate > 0.03 ? `reduce offline time at ${offBranch[0].loc}` : `protect the leading outlets`);
      s9 += ` Today's priority: ${action}.`;
      sections.push({ title: "Executive Summary", text: s9 });

      const closing = `That's your briefing, ${name}. Wishing you a productive ${daypart()} ahead.`;
      const text = [greeting, ...sections.map((s) => s.text), closing].join(" ");
      res.json({ greeting, brandLabel, periodLabel, sections, text });
    } catch (e) {
      res.status(500).json({ error: "I couldn't complete the briefing just now — " + String(e.message || e).slice(0, 140) });
    }
  });
}

// ============================================================================
//  COMPARISON ENGINE — pure calculation layer for the Compare experience.
//
//  Deliberately free of React and fetch so every number here is unit-testable
//  against golden datasets (see scratchpad/compare-tests.mjs). Every function
//  that decomposes a variance MUST reconcile exactly to the total variance —
//  that property is asserted in the tests, not assumed.
//
//  Vocabulary
//    Period A  = the period under review (the "current" one)
//    Period B  = the baseline being compared against
//    LFL       = like-for-like: only entities present and trading in BOTH periods
//    pp        = percentage points (mix movement), never a % growth of a %
// ============================================================================

export const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const safeDiv = (a, b) => (nn(b) === 0 ? null : nn(a) / nn(b));

/* ------------------------------------------------------- metric direction */
// Green/red must never be applied blindly: for these, DOWN is the good outcome.
export const LOWER_IS_BETTER = new Set([
  "discount", "discountPct", "complaints", "complaintRatio", "cancellation",
  "cancellationRate", "deliveryDelay", "delivery", "prep", "prepTime", "offline", "waste", "refunds",
]);
export const isLowerBetter = (metricKey) => LOWER_IS_BETTER.has(metricKey);
// Direction-aware: did this move in the business-favourable direction?
export const isFavourable = (delta, metricKey) =>
  delta == null || delta === 0 ? null : isLowerBetter(metricKey) ? delta < 0 : delta > 0;

/* ------------------------------------------------------------ status label */
export const STATUS = {
  STRONG_GROWTH: "Strong Growth",
  MODERATE_GROWTH: "Moderate Growth",
  STABLE: "Stable",
  MODERATE_DECLINE: "Moderate Decline",
  SIGNIFICANT_DECLINE: "Significant Decline",
  INCOMPLETE: "Data Incomplete",
  NOT_COMPARABLE: "Not Comparable",
};
// `pct` is the raw signed change. For lower-is-better metrics the scale flips,
// so a -12% discount reads as Strong Growth (i.e. strongly favourable).
export function statusLabel(pct, metricKey, ctx = {}) {
  if (ctx.notComparable) return STATUS.NOT_COMPARABLE;
  if (ctx.incomplete) return STATUS.INCOMPLETE;
  if (pct == null || !isFinite(pct)) return STATUS.NOT_COMPARABLE;
  const p = (isLowerBetter(metricKey) ? -pct : pct) * 100;
  if (p >= 10) return STATUS.STRONG_GROWTH;
  if (p >= 2) return STATUS.MODERATE_GROWTH;
  if (p > -2) return STATUS.STABLE;
  if (p > -10) return STATUS.MODERATE_DECLINE;
  return STATUS.SIGNIFICANT_DECLINE;
}
export const statusTone = (label) => ({
  [STATUS.STRONG_GROWTH]: "pos", [STATUS.MODERATE_GROWTH]: "pos",
  [STATUS.STABLE]: "flat",
  [STATUS.MODERATE_DECLINE]: "neg", [STATUS.SIGNIFICANT_DECLINE]: "neg",
  [STATUS.INCOMPLETE]: "warn", [STATUS.NOT_COMPARABLE]: "warn",
}[label] || "flat");

/* -------------------------------------------------- entity classification */
export const ENTITY = {
  COMPARABLE: "Comparable",
  NEW_IN_A: "New in Period A",
  MISSING_IN_A: "Missing in Period A",
  DATA_UNAVAILABLE: "Data unavailable",
};

// LFL eligibility is configurable (§4). `rules.minValue` guards against a branch
// with a single trivial sale counting as "trading".
export const DEFAULT_LFL_RULES = { requireBothPeriods: true, minValue: 0 };

// rows: [{ label, aSales, aOrders, bSales, bOrders }]
export function classifyEntities(rows, rules = DEFAULT_LFL_RULES) {
  const min = nn(rules.minValue);
  return (rows || []).map((r) => {
    const a = nn(r.aSales), b = nn(r.bSales);
    const inA = a > min, inB = b > min;
    let cls, reason;
    if (inA && inB) { cls = ENTITY.COMPARABLE; reason = "Traded in both periods"; }
    else if (inA && !inB) { cls = ENTITY.NEW_IN_A; reason = `No sales in Period B${min > 0 ? ` above the ${min} threshold` : ""}`; }
    else if (!inA && inB) { cls = ENTITY.MISSING_IN_A; reason = `No sales in Period A${min > 0 ? ` above the ${min} threshold` : ""}`; }
    else { cls = ENTITY.DATA_UNAVAILABLE; reason = "No sales in either period"; }
    return { ...r, aSales: a, bSales: b, aOrders: nn(r.aOrders), bOrders: nn(r.bOrders), cls, reason };
  });
}

/* ------------------------------------------------- LFL vs network growth */
// Splits total movement into like-for-like, expansion and closure components.
// GUARANTEE: lflDelta + newContribution + closedImpact === totalA - totalB
export function lflBreakdown(rows, rules = DEFAULT_LFL_RULES) {
  const items = classifyEntities(rows, rules);
  const sum = (f, p) => items.filter(f).reduce((s, r) => s + nn(r[p]), 0);
  const isCmp = (r) => r.cls === ENTITY.COMPARABLE;
  const isNew = (r) => r.cls === ENTITY.NEW_IN_A;
  const isGone = (r) => r.cls === ENTITY.MISSING_IN_A;

  const totalA = items.reduce((s, r) => s + r.aSales, 0);
  const totalB = items.reduce((s, r) => s + r.bSales, 0);
  const lflA = sum(isCmp, "aSales"), lflB = sum(isCmp, "bSales");
  const lflDelta = lflA - lflB;
  const newContribution = sum(isNew, "aSales");     // present only in A
  const closedImpact = -sum(isGone, "bSales");      // lost vs B → negative
  const variance = totalA - totalB;

  return {
    items, totalA, totalB, variance,
    totalGrowthPct: safeDiv(variance, totalB),
    lflA, lflB, lflDelta,
    lflGrowthPct: safeDiv(lflDelta, lflB),                  // growth of the comparable base
    lflContributionPct: safeDiv(lflDelta, totalB),          // its share of total movement
    newContribution, expansionPct: safeDiv(newContribution, totalB),
    closedImpact, closurePct: safeDiv(closedImpact, totalB),
    counts: {
      comparable: items.filter(isCmp).length,
      new: items.filter(isNew).length,
      missing: items.filter(isGone).length,
      unavailable: items.filter((r) => r.cls === ENTITY.DATA_UNAVAILABLE).length,
    },
    // reconciliation residual — asserted to be ~0 in tests, surfaced in the UI
    residual: variance - (lflDelta + newContribution + closedImpact),
  };
}

/* ------------------------------------------------------------ growth bridge */
// Waterfall steps from Period B to Period A (§3). Every step is a real, derived
// component; anything left over is labelled "Unexplained" rather than hidden.
export function growthBridge(rows, rules = DEFAULT_LFL_RULES) {
  const b = lflBreakdown(rows, rules);
  const steps = [
    { key: "start", label: "Period B Net Sales", type: "total", value: b.totalB },
    { key: "lfl", label: "Like-for-Like growth", type: "delta", value: b.lflDelta },
    { key: "new", label: "New branch contribution", type: "delta", value: b.newContribution },
    { key: "closed", label: "Closed / missing branch impact", type: "delta", value: b.closedImpact },
  ];
  if (Math.abs(b.residual) > 0.005) steps.push({ key: "residual", label: "Unexplained", type: "delta", value: b.residual });
  steps.push({ key: "end", label: "Period A Net Sales", type: "total", value: b.totalA });
  return { steps, breakdown: b, reconciles: Math.abs(b.residual) <= 0.005 };
}

/* ------------------------------- volume / rate (order vs ATV) decomposition */
// Splits a sales movement into an order-count effect and an average-ticket
// effect. GUARANTEE: orderEffect + atvEffect === salesA - salesB
export function volumeRateSplit({ aSales, aOrders, bSales, bOrders }) {
  const sA = nn(aSales), sB = nn(bSales), oA = nn(aOrders), oB = nn(bOrders);
  const atvA = oA ? sA / oA : 0, atvB = oB ? sB / oB : 0;
  const orderEffect = (oA - oB) * atvB;        // extra orders at the OLD ticket
  const atvEffect = (atvA - atvB) * oA;        // ticket change on the NEW volume
  const variance = sA - sB;
  return {
    atvA, atvB, orderEffect, atvEffect, variance,
    residual: variance - (orderEffect + atvEffect),
    orderEffectPct: safeDiv(orderEffect, sB),
    atvEffectPct: safeDiv(atvEffect, sB),
  };
}

/* ---------------------------------------------------------- mix-shift (pp) */
// Mix movement is expressed in PERCENTAGE POINTS, never as growth-of-a-share.
export function mixShift(rows, key = "aSales", baseKey = "bSales") {
  const totA = (rows || []).reduce((s, r) => s + nn(r[key]), 0);
  const totB = (rows || []).reduce((s, r) => s + nn(r[baseKey]), 0);
  return (rows || []).map((r) => {
    const mixA = totA ? nn(r[key]) / totA : 0;
    const mixB = totB ? nn(r[baseKey]) / totB : 0;
    return {
      ...r,
      mixA, mixB,
      mixPoints: (mixA - mixB) * 100,                 // e.g. -6.3 pp
      valueDelta: nn(r[key]) - nn(r[baseKey]),
      valueGrowth: safeDiv(nn(r[key]) - nn(r[baseKey]), nn(r[baseKey])),
    };
  });
}

/* ------------------------------------------------------------ contributors */
// Ranks by ABSOLUTE contribution to the total movement, not by % growth — a
// tiny line growing 500% is not a business driver (§12). `minBase` suppresses
// noise from immaterial entities.
export function contributors(rows, { key = "aSales", baseKey = "bSales", limit = 10, minBase = 0 } = {}) {
  const scored = (rows || []).map((r) => {
    const delta = nn(r[key]) - nn(r[baseKey]);
    return { label: r.label, a: nn(r[key]), b: nn(r[baseKey]), delta, growth: safeDiv(delta, nn(r[baseKey])) };
  }).filter((r) => Math.abs(r.a) >= minBase || Math.abs(r.b) >= minBase);
  const totalVariance = scored.reduce((s, r) => s + r.delta, 0);
  const ups = scored.filter((r) => r.delta > 0), downs = scored.filter((r) => r.delta < 0);
  const grossUp = ups.reduce((s, r) => s + r.delta, 0);
  const grossDown = downs.reduce((s, r) => s + r.delta, 0);   // negative
  // Two shares, because one number can't honestly do both jobs:
  //  shareOfVariance — signed, reconciles to the net movement (can exceed 100%
  //    or go negative when gains and losses offset; that IS the real picture).
  //  shareOfSide — this entity's share of all movement in its own direction,
  //    which is what "top 10 negative contributors" actually means to a reader.
  const decorate = (arr, gross) => arr.map((r) => ({
    ...r,
    shareOfVariance: totalVariance === 0 ? null : r.delta / totalVariance,
    shareOfSide: gross === 0 ? null : r.delta / gross,
  }));
  return {
    totalVariance, grossUp, grossDown,
    positive: decorate(ups.sort((x, y) => y.delta - x.delta), grossUp).slice(0, limit),
    negative: decorate(downs.sort((x, y) => x.delta - y.delta), grossDown).slice(0, limit),
  };
}

/* ---------------------------------------------------------- normalization */
export const NORMALIZERS = [
  { k: "total", label: "Total value", short: "Total" },
  { k: "perCalendarDay", label: "Average per calendar day", short: "/ cal day" },
  { k: "perTradingDay", label: "Average per trading day", short: "/ trading day" },
  { k: "perBranch", label: "Average per active branch", short: "/ branch" },
  { k: "perBranchDay", label: "Average per branch-day", short: "/ branch-day" },
  { k: "perOrder", label: "Average per order", short: "/ order" },
  { k: "indexed", label: "Indexed (Period B = 100)", short: "Index" },
];
// ctx: { calendarDays, tradingDays, branches, orders }
export function normalize(value, mode, ctx = {}, baseValue = null) {
  const v = nn(value);
  switch (mode) {
    case "perCalendarDay": return safeDiv(v, ctx.calendarDays);
    case "perTradingDay": return safeDiv(v, ctx.tradingDays);
    case "perBranch": return safeDiv(v, ctx.branches);
    case "perBranchDay": return safeDiv(v, nn(ctx.branches) * nn(ctx.tradingDays));
    case "perOrder": return safeDiv(v, ctx.orders);
    case "indexed": return baseValue == null || nn(baseValue) === 0 ? null : (v / nn(baseValue)) * 100;
    default: return v;
  }
}

/* ------------------------------------------------- comparison quality score */
// Scores how trustworthy the comparison is (§17) and, crucially, says WHY it is
// reduced. Starts at 100 and deducts for each defect found.
export function qualityScore(ctx = {}) {
  const warnings = [];
  let score = 100;
  const {
    daysA = 0, daysB = 0, tradingDaysA = 0, tradingDaysB = 0,
    completenessA = 1, completenessB = 1,
    commonBranches = 0, branchesA = 0, branchesB = 0,
    partialDay = false, partialCutoffLabel = "",
    eventAligned = null,
  } = ctx;

  if (daysA !== daysB) {
    score -= 18;
    warnings.push(`Period A is ${daysA} days and Period B is ${daysB} — totals are not like-for-like. Use a normalized view or an equal-length window.`);
  }
  if (tradingDaysA && tradingDaysB && tradingDaysA !== tradingDaysB) {
    score -= 10;
    warnings.push(`Trading days differ (${tradingDaysA} vs ${tradingDaysB}) — per-trading-day normalization is recommended.`);
  }
  const cA = Math.round(completenessA * 100), cB = Math.round(completenessB * 100);
  if (completenessA < 0.999) { score -= Math.min(30, (1 - completenessA) * 60); warnings.push(`Period A data is ${cA}% complete.`); }
  if (completenessB < 0.999) { score -= Math.min(30, (1 - completenessB) * 60); warnings.push(`Period B data is ${cB}% complete.`); }
  if (partialDay) { score -= 12; warnings.push(`Period A includes a partial day${partialCutoffLabel ? ` (data to ${partialCutoffLabel})` : ""} — compare to the same cut-off for a fair read.`); }

  const union = Math.max(branchesA, branchesB);
  if (union > 0 && commonBranches < union) {
    const missing = union - commonBranches;
    score -= Math.min(20, (missing / union) * 40);
    warnings.push(`${missing} of ${union} branches trade in only one period — see the LFL breakdown for which and why.`);
  }
  if (eventAligned === false) warnings.push("Periods are aligned by calendar date, not by business-event day.");

  score = Math.max(0, Math.round(score));
  const status = score >= 90 ? "Excellent Comparison"
    : score >= 75 ? "Good Comparison"
    : score >= 55 ? "Limited Comparability"
    : score >= 35 ? "Low Data Confidence"
    : "Incomplete Comparison";
  return { score, status, warnings };
}

/* ------------------------------------------- executive narrative (§15, §16)
   Generated from the CALCULATED results only — no model call, so it cannot
   invent a cause that isn't in the data. Facts are stated plainly; anything
   unproven is phrased as "consider investigating", never as a finding.
   Returns sections: [{ title, tone, lines: [{ text, hypothesis? }] }]          */
export function buildNarrative({ breakdown, volumeRate, contributors: c, quality, metricFmt = (v) => String(Math.round(v)), dimLabel = "branch", mixRows = [] }) {
  const L = breakdown, vr = volumeRate;
  const pc = (v, dp = 1) => (v == null || !isFinite(v) ? "n/a" : (v >= 0 ? "+" : "") + (v * 100).toFixed(dp) + "%");
  const out = [];

  // ---- Executive summary (facts only) ----
  const dir = L.variance > 0 ? "increased" : L.variance < 0 ? "decreased" : "was flat";
  const summary = [`Net sales ${dir} by ${metricFmt(Math.abs(L.variance))} (${pc(L.totalGrowthPct)}), from ${metricFmt(L.totalB)} to ${metricFmt(L.totalA)}.`];
  if (vr && Math.abs(vr.variance) > 0) {
    const orderShare = Math.abs(vr.orderEffect) / (Math.abs(vr.orderEffect) + Math.abs(vr.atvEffect) || 1);
    const lead = orderShare >= 0.5 ? "order volume" : "average ticket";
    summary.push(`The movement is driven mainly by ${lead}: order effect ${metricFmt(vr.orderEffect)}, ticket effect ${metricFmt(vr.atvEffect)}.`);
  }
  out.push({ title: "Executive summary", tone: L.variance >= 0 ? "pos" : "neg", lines: summary.map((text) => ({ text })) });

  // ---- Growth composition ----
  const comp = [];
  if (L.counts.comparable > 0) comp.push({ text: `Like-for-like (${L.counts.comparable} ${dimLabel}s trading in both periods) moved ${metricFmt(L.lflDelta)}, a ${pc(L.lflGrowthPct)} change on a base of ${metricFmt(L.lflB)}.` });
  if (L.counts.new > 0) comp.push({ text: `${L.counts.new} new ${dimLabel}${L.counts.new > 1 ? "s" : ""} added ${metricFmt(L.newContribution)} (${pc(L.expansionPct)} of the Period B base).` });
  if (L.counts.missing > 0) comp.push({ text: `${L.counts.missing} ${dimLabel}${L.counts.missing > 1 ? "s" : ""} present in Period B but absent in Period A removed ${metricFmt(Math.abs(L.closedImpact))} (${pc(L.closurePct)}).` });
  if (L.counts.new === 0 && L.counts.missing === 0) comp.push({ text: `All movement is like-for-like — no openings or closures affect this comparison.` });
  out.push({ title: "Growth drivers", tone: "flat", lines: comp });

  // ---- Risk areas (largest negatives) ----
  if (c && c.negative.length) {
    const risk = c.negative.slice(0, 3).map((r) => ({
      text: `${r.label}: ${metricFmt(r.delta)}${r.shareOfSide != null ? ` — ${(Math.abs(r.shareOfSide) * 100).toFixed(0)}% of all decline` : ""}.`,
    }));
    const top = c.negative[0];
    if (top && Math.abs(top.shareOfSide || 0) >= 0.3) {
      risk.push({ text: `${top.label} alone accounts for ${(Math.abs(top.shareOfSide) * 100).toFixed(0)}% of the total decline — consider investigating operating hours, stock availability or channel outages there.`, hypothesis: true });
    }
    out.push({ title: "Risk areas", tone: "neg", lines: risk });
  }

  // ---- Mix changes (percentage points) ----
  if (mixRows && mixRows.length) {
    const moved = [...mixRows].filter((r) => isFinite(r.mixPoints)).sort((x, y) => Math.abs(y.mixPoints) - Math.abs(x.mixPoints)).slice(0, 3);
    if (moved.length && Math.abs(moved[0].mixPoints) >= 0.5) {
      out.push({
        title: "Mix changes", tone: "flat",
        lines: moved.filter((r) => Math.abs(r.mixPoints) >= 0.5).map((r) => ({
          text: `${r.label}: ${(r.mixB * 100).toFixed(1)}% → ${(r.mixA * 100).toFixed(1)}% of the mix (${r.mixPoints >= 0 ? "+" : ""}${r.mixPoints.toFixed(1)} pp).`,
        })),
      });
    }
  }

  // ---- Data warnings ----
  if (quality && quality.warnings.length) {
    out.push({
      title: "Data warnings", tone: "warn",
      lines: [{ text: `Comparison quality ${quality.score}/100 — ${quality.status}.` }, ...quality.warnings.map((w) => ({ text: w }))],
    });
  }
  return out;
}

/* --------------------------------------------- smart insight detection (§16)
   Materiality-aware: a 40% swing on a trivial base is noise, not a signal.      */
export function detectSignals(rows, { key = "aSales", baseKey = "bSales", minAbs = 500, minPct = 0.15, minShare = 0.02, total = 0 } = {}) {
  const sigs = [];
  for (const r of rows || []) {
    const a = nn(r[key]), b = nn(r[baseKey]);
    const delta = a - b;
    const pct = b === 0 ? null : delta / b;
    const share = total ? Math.max(a, b) / total : 0;
    // ALL of: material in absolute terms, material in relative terms, and a
    // non-trivial share of the business. Any one alone produces noise.
    if (Math.abs(delta) < minAbs) continue;
    if (pct == null || Math.abs(pct) < minPct) continue;
    if (share < minShare) continue;
    sigs.push({
      label: r.label, delta, pct, share,
      severity: Math.abs(pct) >= 0.4 && share >= 0.05 ? "high" : "medium",
      direction: delta > 0 ? "up" : "down",
    });
  }
  return sigs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/* ------------------------------------------------------------- date helpers */
export const isoOf = (d) => d.toISOString().slice(0, 10);
export const shiftDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
export const dayCount = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
// trading days = days that actually carry data (from the daily trend rows)
export const tradingDays = (trendRows, valueKey = "sales") =>
  (trendRows || []).filter((r) => nn(r[valueKey]) !== 0).length;

// Golden-dataset validation for the comparison engine (spec Â§27).
// Run: node compare-tests.mjs
import {
  lflBreakdown, growthBridge, volumeRateSplit, mixShift, contributors,
  normalize, qualityScore, statusLabel, isFavourable, classifyEntities,
  ENTITY, STATUS, dayCount,
} from "../src/compareEngine.js";

let pass = 0, fail = 0;
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps;
function ok(name, cond, got, want) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); }
}

// ---- golden dataset: 5 branches -------------------------------------------
// Ardhiya  both periods   (comparable, grew)
// Salmiya  both periods   (comparable, declined)
// Jahra    A only         (new branch)
// Hawally  B only         (closed / missing)
// Ghost    neither        (data unavailable)
const G = [
  { label: "Ardhiya", aSales: 75000, aOrders: 1500, bSales: 60000, bOrders: 1200 },
  { label: "Salmiya", aSales: 40000, aOrders: 1000, bSales: 50000, bOrders: 1100 },
  { label: "Jahra",   aSales: 20000, aOrders: 500,  bSales: 0,     bOrders: 0 },
  { label: "Hawally", aSales: 0,     aOrders: 0,    bSales: 30000, bOrders: 700 },
  { label: "Ghost",   aSales: 0,     aOrders: 0,    bSales: 0,     bOrders: 0 },
];
// totals: A = 135,000   B = 140,000   variance = -5,000

console.log("\n=== classification ===");
const cls = classifyEntities(G);
ok("Ardhiya comparable", cls[0].cls === ENTITY.COMPARABLE, cls[0].cls, ENTITY.COMPARABLE);
ok("Jahra new in A", cls[2].cls === ENTITY.NEW_IN_A, cls[2].cls, ENTITY.NEW_IN_A);
ok("Hawally missing in A", cls[3].cls === ENTITY.MISSING_IN_A, cls[3].cls, ENTITY.MISSING_IN_A);
ok("Ghost data unavailable", cls[4].cls === ENTITY.DATA_UNAVAILABLE, cls[4].cls, ENTITY.DATA_UNAVAILABLE);
ok("every exclusion has a reason", cls.every((r) => !!r.reason), cls.map((r) => r.reason), "non-empty");

console.log("\n=== LFL breakdown ===");
const b = lflBreakdown(G);
ok("totalA", near(b.totalA, 135000), b.totalA, 135000);
ok("totalB", near(b.totalB, 140000), b.totalB, 140000);
ok("variance", near(b.variance, -5000), b.variance, -5000);
ok("lflDelta = +5,000", near(b.lflDelta, 5000), b.lflDelta, 5000);
ok("newContribution = 20,000", near(b.newContribution, 20000), b.newContribution, 20000);
ok("closedImpact = -30,000", near(b.closedImpact, -30000), b.closedImpact, -30000);
ok("LFL growth % = 5000/110000", near(b.lflGrowthPct, 5000 / 110000), b.lflGrowthPct, 5000 / 110000);
ok("counts", b.counts.comparable === 2 && b.counts.new === 1 && b.counts.missing === 1, b.counts, "2/1/1");
// THE critical invariant
ok("RECONCILES: lfl + new + closed === variance", near(b.residual, 0), b.residual, 0);
ok("growth components sum to total growth %",
  near((b.lflContributionPct + b.expansionPct + b.closurePct), b.totalGrowthPct),
  b.lflContributionPct + b.expansionPct + b.closurePct, b.totalGrowthPct);

console.log("\n=== growth bridge ===");
const br = growthBridge(G);
ok("bridge reconciles", br.reconciles === true, br.reconciles, true);
const deltas = br.steps.filter((s) => s.type === "delta").reduce((s, x) => s + x.value, 0);
ok("start + deltas === end", near(b.totalB + deltas, b.totalA), b.totalB + deltas, b.totalA);
ok("no hidden residual step when it reconciles", !br.steps.some((s) => s.key === "residual"), br.steps.map((s) => s.key), "no residual");

console.log("\n=== volume / rate split ===");
const vr = volumeRateSplit({ aSales: 135000, aOrders: 3000, bSales: 140000, bOrders: 3500 });
ok("orderEffect + atvEffect === variance", near(vr.residual, 0), vr.residual, 0);
ok("variance", near(vr.variance, -5000), vr.variance, -5000);
ok("ATV A = 45", near(vr.atvA, 45), vr.atvA, 45);
ok("ATV B = 40", near(vr.atvB, 40), vr.atvB, 40);

console.log("\n=== mix shift (percentage points) ===");
const mx = mixShift([
  { label: "Aggregator", aSales: 84.2, bSales: 90.5 },
  { label: "Own", aSales: 15.8, bSales: 9.5 },
]);
ok("mix A sums to 100%", near(mx.reduce((s, r) => s + r.mixA, 0), 1), mx.reduce((s, r) => s + r.mixA, 0), 1);
ok("mix B sums to 100%", near(mx.reduce((s, r) => s + r.mixB, 0), 1), mx.reduce((s, r) => s + r.mixB, 0), 1);
ok("aggregator moves -6.3pp", near(mx[0].mixPoints, -6.3, 1e-9), mx[0].mixPoints, -6.3);
ok("mix points sum to 0", near(mx.reduce((s, r) => s + r.mixPoints, 0), 0, 1e-9), mx.reduce((s, r) => s + r.mixPoints, 0), 0);

console.log("\n=== contributors ===");
const c = contributors(G);
ok("total variance matches", near(c.totalVariance, -5000), c.totalVariance, -5000);
// ranked by absolute contribution, so the new branch (+20k) outranks Ardhiya (+15k)
ok("top positive is Jahra +20,000", c.positive[0].label === "Jahra" && near(c.positive[0].delta, 20000), c.positive[0], "Jahra +20000");
ok("second positive is Ardhiya +15,000", c.positive[1].label === "Ardhiya" && near(c.positive[1].delta, 15000), c.positive[1], "Ardhiya +15000");
ok("top negative is Hawally -30,000", c.negative[0].label === "Hawally" && near(c.negative[0].delta, -30000), c.negative[0], "Hawally -30000");
ok("all deltas reconcile to total", near([...c.positive, ...c.negative].reduce((s, r) => s + r.delta, 0), -5000),
  [...c.positive, ...c.negative].reduce((s, r) => s + r.delta, 0), -5000);
ok("grossUp = 35,000", near(c.grossUp, 35000), c.grossUp, 35000);
ok("grossDown = -40,000", near(c.grossDown, -40000), c.grossDown, -40000);
ok("gross up + down === net variance", near(c.grossUp + c.grossDown, c.totalVariance), c.grossUp + c.grossDown, c.totalVariance);
// shareOfSide is the readable one: Hawally is 75% of all decline
ok("Hawally is 75% of total decline", near(c.negative[0].shareOfSide, 0.75), c.negative[0].shareOfSide, 0.75);
ok("positive shareOfSide sums to 1", near(c.positive.reduce((s, r) => s + r.shareOfSide, 0), 1), c.positive.reduce((s, r) => s + r.shareOfSide, 0), 1);
const cMin = contributors(G, { minBase: 25000 });
ok("minBase suppresses immaterial rows", !cMin.positive.some((r) => r.label === "Jahra"), cMin.positive.map((r) => r.label), "no Jahra");

console.log("\n=== divide-by-zero handling ===");
const z = lflBreakdown([{ label: "X", aSales: 100, aOrders: 1, bSales: 0, bOrders: 0 }]);
ok("zero base â†’ null growth, not Infinity", z.lflGrowthPct === null || z.totalGrowthPct === null, { lfl: z.lflGrowthPct, tot: z.totalGrowthPct }, "null");
ok("zero-order ATV does not throw", near(volumeRateSplit({ aSales: 0, aOrders: 0, bSales: 0, bOrders: 0 }).variance, 0), 0, 0);

console.log("\n=== same-period comparison (A === B) ===");
const same = lflBreakdown(G.map((r) => ({ ...r, bSales: r.aSales, bOrders: r.aOrders })));
ok("variance is zero", near(same.variance, 0), same.variance, 0);
ok("reconciles", near(same.residual, 0), same.residual, 0);

console.log("\n=== period swap symmetry ===");
const swapped = lflBreakdown(G.map((r) => ({ label: r.label, aSales: r.bSales, aOrders: r.bOrders, bSales: r.aSales, bOrders: r.aOrders })));
ok("swap negates variance", near(swapped.variance, -b.variance), swapped.variance, -b.variance);
ok("swap reconciles", near(swapped.residual, 0), swapped.residual, 0);
ok("new/closed roles invert", swapped.counts.new === 1 && swapped.counts.missing === 1, swapped.counts, "1/1");

console.log("\n=== normalization ===");
const ctx = { calendarDays: 10, tradingDays: 8, branches: 4, orders: 3000 };
ok("per calendar day", near(normalize(1000, "perCalendarDay", ctx), 100), normalize(1000, "perCalendarDay", ctx), 100);
ok("per trading day", near(normalize(1000, "perTradingDay", ctx), 125), normalize(1000, "perTradingDay", ctx), 125);
ok("per branch-day", near(normalize(1000, "perBranchDay", ctx), 31.25), normalize(1000, "perBranchDay", ctx), 31.25);
ok("indexed B=100", near(normalize(112.4, "indexed", ctx, 100), 112.4), normalize(112.4, "indexed", ctx, 100), 112.4);
ok("indexed guards zero base", normalize(50, "indexed", ctx, 0) === null, normalize(50, "indexed", ctx, 0), null);

console.log("\n=== metric direction (green/red must not be blind) ===");
ok("sales up is favourable", isFavourable(0.05, "sales") === true, isFavourable(0.05, "sales"), true);
ok("discount up is NOT favourable", isFavourable(0.05, "discount") === false, isFavourable(0.05, "discount"), false);
ok("complaints down IS favourable", isFavourable(-0.05, "complaints") === true, isFavourable(-0.05, "complaints"), true);
ok("discount -12% reads as strong", statusLabel(-0.12, "discount") === STATUS.STRONG_GROWTH, statusLabel(-0.12, "discount"), STATUS.STRONG_GROWTH);
ok("sales -12% reads as significant decline", statusLabel(-0.12, "sales") === STATUS.SIGNIFICANT_DECLINE, statusLabel(-0.12, "sales"), STATUS.SIGNIFICANT_DECLINE);
ok("+1% is Stable", statusLabel(0.01, "sales") === STATUS.STABLE, statusLabel(0.01, "sales"), STATUS.STABLE);
ok("incomplete overrides", statusLabel(0.5, "sales", { incomplete: true }) === STATUS.INCOMPLETE, statusLabel(0.5, "sales", { incomplete: true }), STATUS.INCOMPLETE);

console.log("\n=== quality score ===");
const perfect = qualityScore({ daysA: 7, daysB: 7, tradingDaysA: 7, tradingDaysB: 7, completenessA: 1, completenessB: 1, commonBranches: 10, branchesA: 10, branchesB: 10 });
ok("perfect = 100 / Excellent", perfect.score === 100 && perfect.status === "Excellent Comparison", perfect, "100 Excellent");
ok("perfect has no warnings", perfect.warnings.length === 0, perfect.warnings, []);
const uneven = qualityScore({ daysA: 8, daysB: 7, tradingDaysA: 8, tradingDaysB: 7, completenessA: 0.67, completenessB: 1, commonBranches: 8, branchesA: 10, branchesB: 9, partialDay: true, partialCutoffLabel: "3:00 PM" });
ok("defects reduce score", uneven.score < perfect.score, uneven.score, "< 100");
ok("explains WHY", uneven.warnings.length >= 4, uneven.warnings, ">= 4 warnings");
ok("names the day mismatch", uneven.warnings.some((w) => /8 days and Period B is 7/.test(w)), uneven.warnings, "day mismatch");
ok("names the partial day", uneven.warnings.some((w) => /3:00 PM/.test(w)), uneven.warnings, "partial day");
ok("score never negative", qualityScore({ daysA: 1, daysB: 90, completenessA: 0, completenessB: 0, commonBranches: 0, branchesA: 50, branchesB: 50, partialDay: true }).score >= 0, true, ">= 0");

console.log("\n=== date helpers ===");
ok("dayCount inclusive", dayCount("2026-07-01", "2026-07-07") === 7, dayCount("2026-07-01", "2026-07-07"), 7);
ok("single day = 1", dayCount("2026-07-01", "2026-07-01") === 1, dayCount("2026-07-01", "2026-07-01"), 1);

console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}\n`);
process.exit(fail ? 1 : 0);


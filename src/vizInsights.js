// ============================================================================
//  VISUAL INSIGHTS — a plain-data "so what?" for any visual.
//
//  Deliberately deterministic (no AI call): it reads whatever rows the visual
//  itself returned and states what they say. Works for every [data-viz] because
//  it infers the shape rather than hard-coding per-visual rules:
//     label column   = first non-numeric field
//     primary metric = first numeric field, preferring known money/volume names
//     comparison     = a sibling field (avg / last4 / _w / _m / _y) if present
//
//  Returns [{ tone: "up"|"down"|"flat", text }] — [] when there's nothing honest
//  to say, which the UI renders as "No insight for this selection" rather than
//  inventing one.
// ============================================================================
const nn = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const isNum = (v) => v !== null && v !== "" && v !== undefined && isFinite(Number(v));
const kd = (n) => "KD " + Math.round(nn(n)).toLocaleString("en-US");
const num = (n) => Math.round(nn(n)).toLocaleString("en-US");
const pctOf = (a, b) => (b ? (a / b) * 100 : 0);
const signPct = (v) => (v >= 0 ? "+" : "") + v.toFixed(0) + "%";

// metric names we'd rather summarise, in order of preference
const METRIC_RANK = ["net", "netSales", "sales", "value", "orders", "qty", "pen", "share"];
// fields that are a comparison for the primary metric, not a metric of their own
const CMP_SUFFIX = ["_w", "_m", "_y"];
const CMP_NAMES = ["avg", "last4", "target", "prev"];
// never treat these as the metric
const SKIP = new Set(["x", "hour", "hr", "key", "id", "tip", "pct", "color"]);

const isMoney = (k) => /net|sales|aov|value|target/i.test(k);

// Matrix visuals ship their own total rows (isGrandTotal / isGroupTotal). Counting
// those as entries double-counts the total and produces nonsense like
// "All brands leads with 50% of the total" — drop them before summarising.
const TOTAL_FLAGS = /^is(Grand|Group)?Total$/i;
const TOTAL_LABEL = /^(all brands|all|total|grand total)$/i;
const isTotalRow = (r, labelKey) =>
  Object.keys(r || {}).some((k) => TOTAL_FLAGS.test(k) && (r[k] === true || r[k] === 1)) ||
  TOTAL_LABEL.test(String(r?.[labelKey] ?? "").trim());

// hour dimensions come through as raw 0–23 — say "1pm", not "13"
const isHourKey = (k) => /^(x|hour|hr)$/i.test(k);
const hourLabel = (h) => { const n = Number(h) % 24; return `${n % 12 || 12}${n < 12 ? "am" : "pm"}`; };

function shape(rows) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const labelKey = keys.find((k) => rows.some((r) => r && r[k] != null && !isNum(r[k]))) || keys[0];
  const numKeys = keys.filter((k) => k !== labelKey && !SKIP.has(k) && rows.some((r) => r && isNum(r[k])));
  // pick the metric: known name first, else the first numeric that isn't a comparison
  const plain = numKeys.filter((k) => !CMP_SUFFIX.some((s) => k.endsWith(s)) && !CMP_NAMES.includes(k));
  const metric = METRIC_RANK.find((m) => plain.includes(m)) || plain[0] || numKeys[0];
  // find its comparison partner
  const cmp = CMP_NAMES.find((c) => numKeys.includes(c))
    || CMP_SUFFIX.map((s) => metric + s).find((k) => numKeys.includes(k));
  return { labelKey, metric, cmp };
}

export function buildInsights(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const { labelKey, metric, cmp } = shape(rows);
  if (!metric) return [];

  const fmt = isMoney(metric) ? kd : num;
  const lbl = isHourKey(labelKey) ? (r) => hourLabel(r[labelKey]) : (r) => r[labelKey];
  // orders is a second dimension worth calling out whenever it's present and isn't
  // already the primary metric (so money visuals also get an orders/AOV read).
  const ordersKey = metric !== "orders" && rows.some((r) => r && isNum(r.orders)) ? "orders" : null;
  const src = rows.filter((r) => r && r[labelKey] != null && isNum(r[metric]) && !isTotalRow(r, labelKey));
  if (src.length < 2) return [];

  // Matrix visuals repeat the label across a second dimension (brand × location),
  // so ranking raw rows would crown a single store line and call it the brand.
  // Roll up to one entry per label first. No-op when labels are already unique.
  const clean = (() => {
    const byLabel = new Map();
    for (const r of src) {
      const k = String(lbl(r));
      const prev = byLabel.get(k);
      if (prev) { prev[metric] = nn(prev[metric]) + nn(r[metric]); if (cmp) prev[cmp] = nn(prev[cmp]) + nn(r[cmp]); if (ordersKey) prev[ordersKey] = nn(prev[ordersKey]) + nn(r[ordersKey]); }
      else byLabel.set(k, { ...r, [labelKey]: lbl(r) });
    }
    return [...byLabel.values()];
  })();
  if (clean.length < 2) return [];
  const label = (r) => r[labelKey];   // already resolved by the roll-up above

  const total = clean.reduce((s, r) => s + nn(r[metric]), 0);
  const sorted = [...clean].sort((a, b) => nn(b[metric]) - nn(a[metric]));
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const out = [];

  // 1. concentration — who carries the number
  if (total > 0) {
    const topShare = pctOf(nn(top[metric]), total);
    out.push({
      tone: "flat",
      text: `${label(top)} leads with ${fmt(top[metric])} — ${topShare.toFixed(0)}% of the ${fmt(total)} total.`,
    });
    if (sorted.length >= 4) {
      const top3 = sorted.slice(0, 3).reduce((s, r) => s + nn(r[metric]), 0);
      const share3 = pctOf(top3, total);
      out.push({
        tone: share3 >= 70 ? "down" : "flat",
        text: share3 >= 70
          ? `Heavily concentrated: the top 3 carry ${share3.toFixed(0)}% of the total — thin spread across the remaining ${sorted.length - 3}.`
          : `The top 3 account for ${share3.toFixed(0)}%, so the total is spread across ${sorted.length} ${sorted.length > 12 ? "entries" : "lines"}.`,
      });
    }
  }

  // 1b. orders / AOV — who drives volume, and the blended ticket
  if (ordersKey) {
    const totalOrders = clean.reduce((s, r) => s + nn(r[ordersKey]), 0);
    if (totalOrders > 0) {
      const byOrders = [...clean].sort((a, b) => nn(b[ordersKey]) - nn(a[ordersKey]));
      const oTop = byOrders[0];
      const oShare = pctOf(nn(oTop[ordersKey]), totalOrders);
      const aovPart = isMoney(metric) && nn(oTop[ordersKey]) > 0 ? `, AOV ${kd(nn(oTop[metric]) / nn(oTop[ordersKey]))}` : "";
      out.push({ tone: "flat", text: `Busiest by orders: ${label(oTop)} — ${num(oTop[ordersKey])} orders, ${oShare.toFixed(0)}% of ${num(totalOrders)}${aovPart}.` });
    }
  }

  // 2. vs comparison — the biggest gain and the biggest drop
  if (cmp) {
    // A near-zero benchmark yields nonsense like "+12403%". Quote the percentage
    // only when the benchmark is big enough for it to mean anything; otherwise
    // state the absolute gap, which is always honest.
    const pctPart = (p, base) => (base > 0 && Math.abs(p) <= 300 ? ` (${signPct(p)})` : "");
    const withDelta = clean
      .filter((r) => nn(r[cmp]) > 0)
      .map((r) => ({ l: label(r), b: nn(r[cmp]), d: nn(r[metric]) - nn(r[cmp]), p: pctOf(nn(r[metric]) - nn(r[cmp]), nn(r[cmp])) }));
    if (withDelta.length) {
      const gain = [...withDelta].sort((a, b) => b.d - a.d)[0];
      const drop = [...withDelta].sort((a, b) => a.d - b.d)[0];
      if (gain && gain.d > 0) out.push({ tone: "up", text: `${gain.l} is the biggest gain: ${fmt(gain.d)} above its benchmark${pctPart(gain.p, gain.b)}.` });
      if (drop && drop.d < 0) out.push({ tone: "down", text: `${drop.l} is the biggest shortfall: ${fmt(Math.abs(drop.d))} below its benchmark${pctPart(drop.p, drop.b)}.` });
      const below = withDelta.filter((r) => r.d < 0).length;
      if (below) out.push({ tone: below > withDelta.length / 2 ? "down" : "flat", text: `${below} of ${withDelta.length} are below benchmark.` });
    }
  } else if (total > 0) {
    // no benchmark — describe the spread instead
    const avg = total / clean.length;
    out.push({ tone: "flat", text: `Average is ${fmt(avg)}; the range runs ${fmt(bottom[metric])} (${lbl(bottom)}) to ${fmt(top[metric])} (${label(top)}).` });
  }

  // 3. zero / missing — worth flagging on any breakdown
  const zeros = clean.filter((r) => nn(r[metric]) === 0);
  if (zeros.length && zeros.length < clean.length) {
    out.push({ tone: "down", text: `${zeros.length} recorded nothing: ${zeros.slice(0, 3).map(lbl).join(", ")}${zeros.length > 3 ? "…" : ""}.` });
  }

  return out.slice(0, 6);
}

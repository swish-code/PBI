// Chart tokens — mirror styles.css so ECharts matches the design system.
// `green`/`accent` read the live --accent CSS var so charts recolour per brand.
const cssVar = (name, fb) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch { return fb; } };
export const T = {
  // Getters, not literals: these MUST read live so charts follow the light/dark
  // toggle. A plain value would freeze at import and leave every axis and label
  // in light-mode colours forever.
  get ink() { return cssVar("--ink", "#0D0D0F"); },
  get ink900() { return cssVar("--ink-900", "#000000"); },
  get muted() { return cssVar("--muted", "#6E6E73"); },
  get line() { return cssVar("--line", "#EBEBEC"); },
  get card() { return cssVar("--card", "#FFFFFF"); },
  get accentSoft() { return cssVar("--accent-soft", "#E4F6EC"); },
  red: "#F04438",
  blue: "#2E90FA",
  pos: "#12B76A",     // fixed semantic green (up/positive) — never brand-tinted
  font: "'DM Sans', ui-sans-serif, system-ui, sans-serif",   // must match --font in styles.css
  // brand accent — follows the selected brand (falls back to SWiSH green)
  get green() { return cssVar("--accent", "#12B76A"); },
  get accent() { return cssVar("--accent", "#12B76A"); },
  // categorical palette for donuts / multi-series (first slot follows the accent)
  get cat() { return [cssVar("--accent", "#12B76A"), "#2E90FA", "#7A5AF8", "#F79009", "#EE46BC", "#12B0A0", "#6172F3", "#F04438", "#EAAA08", "#4E5BA6"]; },
};

// number formatters (KD is the group currency)
export const kd = (n) => "KD " + Math.round(Number(n) || 0).toLocaleString("en-US");
export const kdc = (n) => "KD " + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const num = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
export const pct = (n) => (n >= 0 ? "+" : "") + (Number(n) * 100).toFixed(1) + "%";
export const kk = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k" : String(Math.round(v)));

// Shared ECharts base (grid, axis, tooltip) in the design-system style.
// Every colour is a GETTER so it re-reads the CSS vars on each use — object
// spread (`{...tooltipBase}`, how every call site consumes these) invokes
// getters at spread time, so charts pick up the active theme with no call-site
// changes. Plain literals here would bake in light mode at import.
export const axisBase = {
  get axisLine() { return { lineStyle: { color: T.line } }; },
  axisTick: { show: false },
  get axisLabel() { return { color: T.muted, fontSize: 11, fontFamily: T.font }; },
  get splitLine() { return { lineStyle: { color: T.line, type: "dashed" } }; },
};
export const tooltipBase = {
  get backgroundColor() { return cssVar("--tip-bg", "#0B1220"); },
  borderWidth: 0,
  padding: [8, 12],
  // snap to the cursor (no position animation → no "floating/stuck" feel) and keep
  // the tooltip inside the chart so it can't get clipped/left behind in a scrollable modal
  transitionDuration: 0,
  confine: true,
  get textStyle() { return { color: cssVar("--tip-ink", "#fff"), fontSize: 12, fontFamily: T.font }; },
  extraCssText: "border-radius:10px; box-shadow:0 10px 28px -6px rgba(0,0,0,.35);",
};

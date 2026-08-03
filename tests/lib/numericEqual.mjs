// Golden comparator. Numeric fields pass within tolerance (Power BI's summation
// order produces ULP-level noise across runs); everything else must match exactly.
//   relative tolerance 1e-9, OR absolute 1e-6 near zero.
// Returns { equal, diffs:[{path, golden, actual}] }.
const REL = 1e-9;
const ABS = 1e-6;

export function numbersClose(a, b, rel = REL, abs = ABS) {
  if (a === b) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const diff = Math.abs(a - b);
  return diff <= Math.max(rel * Math.max(Math.abs(a), Math.abs(b)), abs);
}

// canonical, ULP-tolerant serialization used to align rows when Power BI returns a
// tied sort in a different order (so we compare row SETS, not positions).
function canon(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v.toPrecision(8) : String(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => k + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

export function deepNumericEqual(golden, actual, opts = {}) {
  const diffs = [];
  const rel = opts.rel ?? REL, abs = opts.abs ?? ABS;
  const walk = (g, a, path) => {
    if (typeof g === "number" || typeof a === "number") {
      if (!numbersClose(g, a, rel, abs)) diffs.push({ path, golden: g, actual: a });
      return;
    }
    if (Array.isArray(g) || Array.isArray(a)) {
      let gg = Array.isArray(g) ? g : [], aa = Array.isArray(a) ? a : [];
      if (gg.length !== aa.length) diffs.push({ path, golden: `array[${gg.length}]`, actual: `array[${aa.length}]` });
      // rows (arrays of objects) are order-insensitive: align by canonical key so a
      // nondeterministic tie-order in the DAX ORDER BY isn't reported as a value diff.
      if (gg.every((x) => x && typeof x === "object") && aa.every((x) => x && typeof x === "object")) {
        gg = [...gg].sort((x, y) => canon(x).localeCompare(canon(y)));
        aa = [...aa].sort((x, y) => canon(x).localeCompare(canon(y)));
      }
      const n = Math.max(gg.length, aa.length);
      for (let i = 0; i < n; i++) walk(gg[i], aa[i], `${path}[${i}]`);
      return;
    }
    if (g && a && typeof g === "object" && typeof a === "object") {
      const keys = new Set([...Object.keys(g), ...Object.keys(a)]);
      for (const k of keys) walk(g[k], a[k], path ? `${path}.${k}` : k);
      return;
    }
    if (g !== a) diffs.push({ path, golden: g, actual: a });   // strings/bools/null → exact
  };
  walk(golden, actual, "");
  return { equal: diffs.length === 0, diffs };
}

// ============================================================================
//  VIZ-REGISTRY — the DAX builders + helpers, as PURE functions of an explicit
//  `ctx` argument. NO module-level mutable state (the old server.js `CURRENT`
//  global was a brand-bleed race once the worker builds DAX for many brands
//  concurrently through the per-dataset gates). Every helper/builder takes ctx.
//
//  ctx shape (assembled by the caller — worker from its cycle, legacy from a shim
//  over CURRENT): { brand, scope:{brands, locations}, range:{start,end}, ... }
//
//  IMPORT BOUNDARY: only pbi-core / worker may import this. The web subtree must
//  never reach it (ESLint no-restricted-imports + madge). If web ever needs plain
//  metadata, that goes in a data-only viz-contract.js, never here.
//
//  Builders are relocated here from server.js incrementally (move-only + ctx
//  parameterization); this file grows one gated commit at a time.
// ============================================================================

const daxList = (arr) => arr.map((s) => `"${String(s).replace(/"/g, '""')}"`).join(", ");

// The __brand filter is injected into EVERY query — THE brand-isolation enforcement
// point. Returns the intersection of (a) the brand requested (ctx.brand) and (b) the
// brands/locations the user is allowed (ctx.scope). Pure: no shared global.
//   ctx.brand: string | "all" | null
//   ctx.scope: { brands: "all" | string[], locations: "all" | { brand: string[] } }
export function brandFilterVar(ctx = {}) {
  const req = ctx.brand && ctx.brand !== "all" ? ctx.brand : null;
  const sc = ctx.scope || { brands: "all", locations: "all" };
  // location-restricted user (Area Manager): filter to the exact (brand, location)
  // PAIRS they own via TREATAS, so a same-named branch in another brand can't leak.
  if (sc.locations && sc.locations !== "all") {
    const esc = (s) => String(s).replace(/"/g, '""');
    const pairs = [];
    for (const [b, arr] of Object.entries(sc.locations)) {
      if (req && b !== req) continue;                 // header brand narrows within scope
      (arr || []).forEach((l) => pairs.push(`("${esc(b)}", "${esc(l)}")`));
    }
    if (!pairs.length) return `FILTER(ALL('LocationMaster'[Location]), FALSE())`;
    return `TREATAS({${pairs.join(", ")}}, 'Brand Table'[Brand Full Name], 'LocationMaster'[Location])`;
  }
  // brand-restricted (GM/Marketing) or all-brands (Admin/Ops)
  let brands = sc.brands && sc.brands !== "all" ? sc.brands.slice() : null;
  if (req) brands = brands ? brands.filter((b) => b === req) : [req];
  if (brands && brands.length === 0) return `FILTER(ALL('Brand Table'[Brand Full Name]), FALSE())`;
  if (brands) return `FILTER(ALL('Brand Table'[Brand Full Name]), 'Brand Table'[Brand Full Name] IN {${daxList(brands)}})`;
  return `FILTER(KEEPFILTERS(VALUES('Brand Table'[Brand])), NOT('Brand Table'[Brand] IN {BLANK()}))`;
}

export { daxList };

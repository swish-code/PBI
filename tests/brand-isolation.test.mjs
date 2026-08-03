// Brand-isolation guarantee at the DAX layer. Builds the brand filter for several
// brands CONCURRENTLY and interleaved (Promise.all + random yields) and asserts each
// output contains ONLY its own brand â€” proving there is no shared mutable state that
// could bleed one brand's scope into another's query. No Power BI calls. CI-forever.
import assert from "node:assert";
import { brandFilterVar } from "../server/viz-registry.js";

const brands = ["BBT", "Mishmash", "Tabel", "Shawarma Shakir", "Chilli Pepper"];
const allScope = { brands: "all", locations: "all" };

const results = await Promise.all(brands.map(async (b) => {
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)));   // force interleave
  const dax = brandFilterVar({ brand: b, scope: allScope });
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)));
  return { b, dax };
}));

let n = 0;
for (const { b, dax } of results) {
  assert.ok(dax.includes(`"${b}"`), `${b}: filter must contain its own brand`); n++;
  for (const other of brands) if (other !== b) {
    assert.ok(!dax.includes(`"${other}"`), `${b}: filter must NOT contain ${other} (brand bleed!)`); n++;
  }
}

// a brand-scoped GM must only ever see their brand, even if they request "all"
const gm = brandFilterVar({ brand: "all", scope: { brands: ["BBT"], locations: "all" } });
assert.ok(gm.includes('"BBT"') && !gm.includes("Mishmash"), "GM scoped to BBT only"); n++;
// requesting a brand outside scope yields an impossible filter (no data), never another brand
const outOfScope = brandFilterVar({ brand: "Mishmash", scope: { brands: ["BBT"], locations: "all" } });
assert.ok(outOfScope.includes("FALSE()"), "out-of-scope brand request â†’ empty, never leaked"); n++;
// location-restricted user: exact (brand, location) pairs via TREATAS
const area = brandFilterVar({ brand: null, scope: { brands: ["BBT"], locations: { BBT: ["Salmiya"] } } });
assert.ok(area.includes("TREATAS") && area.includes("Salmiya") && area.includes("BBT"), "area (brand,loc) pairs"); n++;

console.log(`brand-isolation: all ${n} assertions passed (no brand bleed under concurrency)`);


// Freeze the DAX text emitted by EVERY builder across a fixed ctx matrix, from the
// current (pre-relocation) tree. After the viz-registry move, the registry's dax(ctx)
// must reproduce these byte-for-byte (verify-dax-snapshots.mjs). No Power BI calls â€”
// /api/debug/dax builds the text without executing. Usage: node tests/gen-dax-snapshots.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const PORT = Number(process.env.PORT) || 7001;
const sec = fs.readFileSync("server/data/.jwtsecret", "utf8");
const tok = jwt.sign({ id: "t", email: "data-team@swishhh.net", name: "T", role: "admin", scope: { brands: "all", locations: "all" } }, sec, { expiresIn: "5m" });
const outDir = path.join("tests", "dax-snapshots");
fs.mkdirSync(outDir, { recursive: true });

// ctx matrix: brand Ã— range Ã— scope (all-brands / GM / area)
const MATRIX = [
  { id: "bbt_day", q: { brand: "BBT", start: "2026-07-25", end: "2026-07-25" } },
  { id: "mm_range", q: { brand: "Mishmash", start: "2026-07-01", end: "2026-07-25" } },
  { id: "gm_bbt", q: { brand: "all", start: "2026-07-25", end: "2026-07-25", scope: JSON.stringify({ brands: ["BBT"], locations: "all" }) } },
  { id: "area_bbt", q: { brand: "BBT", start: "2026-07-25", end: "2026-07-25", scope: JSON.stringify({ brands: ["BBT"], locations: { BBT: ["Salmiya"] } }) } },
];
const get = (p) => new Promise((res, rej) => { http.get({ host: "localhost", port: PORT, path: p, headers: { Cookie: "sid=" + tok }, timeout: 30000 }, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => res({ status: r.statusCode, d })); }).on("error", rej); });
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

const run = async () => {
  const cat = JSON.parse((await get("/api/debug/catalog")).d);
  const names = cat.visuals.map((v) => v.name);
  const entries = {};
  let built = 0, errored = 0;
  for (const name of names) {
    for (const m of MATRIX) {
      const r = await get(`/api/debug/dax/${name}?${qs(m.q)}`);
      let j; try { j = JSON.parse(r.d); } catch { j = { error: "bad response" }; }
      const key = `${name}||${m.id}`;
      if (j.dax != null) { entries[key] = { dax: j.dax, model: j.model }; built++; }
      else { entries[key] = { error: j.error || "unknown" }; errored++; }
    }
  }
  fs.writeFileSync(path.join(outDir, "snapshots.json"), JSON.stringify({ matrix: MATRIX.map((m) => m.id), vizCount: names.length, entries }, null, 0));
  console.log(`froze ${built} DAX snapshots (${errored} builders errored for some ctx) across ${names.length} vizzes Ã— ${MATRIX.length} ctx`);
};
run().catch((e) => { console.error(e); process.exit(1); });


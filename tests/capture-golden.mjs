// Re-baseline the golden fixtures from the running server (fixed brand + date).
// Run whenever upstream data is intentionally reprocessed. Usage: node tests/capture-golden.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const PORT = Number(process.env.PORT) || 7001;
const BRAND = "BBT";
const RANGE = "start=2026-07-25&end=2026-07-25";
const outDir = path.join("tests", "golden");
fs.mkdirSync(outDir, { recursive: true });
const sec = fs.readFileSync("server/data/.jwtsecret", "utf8");
const tok = jwt.sign({ id: "t", email: "data-team@swishhh.net", name: "T", role: "admin", scope: { brands: "all", locations: "all" } }, sec, { expiresIn: "5m" });
const VIZ = ["pm_kpis", "pm_launch_detail", "pm_hero", "pm_category", "pm_bestsellers", "pm_daypart", "pm_hourly", "pm_cat_month", "pm_cat_detail", "pm_cat_bucket", "pm_xa_cards", "landing_head", "landing_brand_matrix", "landing_channel_matrix", "ov_channels", "ov_branches", "ov_buckets"];
const get = (p) => new Promise((res, rej) => { http.get({ host: "localhost", port: PORT, path: p, headers: { Cookie: "sid=" + tok }, timeout: 120000 }, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => res(d)); }).on("error", rej); });
const run = async () => {
  const items = [];
  for (const name of VIZ) {
    const body = await get(`/api/viz/${name}?${RANGE}&brand=${encodeURIComponent(BRAND)}`);
    fs.writeFileSync(path.join(outDir, `${name}.json`), body);
    const sha = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
    items.push({ name, bytes: body.length, sha });
    console.log(name.padEnd(22), body.length.toString().padStart(7), "bytes");
  }
  fs.writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify({ brand: BRAND, range: RANGE, capturedFor: "phase-baseline", items }, null, 2));
  console.log("\nre-baselined", items.length, "golden fixtures");
};
run().catch((e) => { console.error(e); process.exit(1); });


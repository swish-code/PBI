// Golden validation runner. Fetches each captured endpoint from the running server
// and compares to tests/golden/*.json using the tolerant comparator. Exit 1 on any
// real (non-ULP) deviation. Usage: node tests/verify-golden.mjs [port]
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { deepNumericEqual } from "./lib/numericEqual.mjs";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 7001;
const dir = path.join("tests", "golden");
const man = JSON.parse(fs.readFileSync(path.join(dir, "_manifest.json"), "utf8"));
const sec = fs.readFileSync("server/data/.jwtsecret", "utf8");
const tok = jwt.sign({ id: "t", email: "data-team@swishhh.net", name: "T", role: "admin", scope: { brands: "all", locations: "all" } }, sec, { expiresIn: "5m" });

const get = (p) => new Promise((res, rej) => {
  http.get({ host: "localhost", port: PORT, path: p, headers: { Cookie: "sid=" + tok }, timeout: 120000 }, (r) => {
    let d = ""; r.on("data", (c) => d += c); r.on("end", () => res(d));
  }).on("error", rej);
});

const run = async () => {
  let pass = 0, fail = 0;
  for (const it of man.items) {
    if (it.error) continue;
    const golden = JSON.parse(fs.readFileSync(path.join(dir, `${it.name}.json`), "utf8"));
    const actual = JSON.parse(await get(`/api/viz/${it.name}?${man.range}&brand=${encodeURIComponent(man.brand)}`));
    const { equal, diffs } = deepNumericEqual(golden, actual);
    if (equal) { pass++; console.log("PASS ", it.name); }
    else { fail++; console.log("FAIL ", it.name, "â†’", diffs.slice(0, 4).map((d) => `${d.path}: ${d.golden} != ${d.actual}`).join("; ")); }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
};
run().catch((e) => { console.error(e); process.exit(2); });


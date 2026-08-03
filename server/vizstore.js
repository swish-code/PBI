// ============================================================================
//  VIZSTORE — the shared cache contract between the worker (writes) and web (reads).
//
//  Key schema (v1):
//    swish:v1:{brand}:{vizId}:{dateKey}  -> pre-serialized JSON payload STRING
//    swish:v1:{brand}:{vizId}:{dateKey}:etag -> ETag string
//    swish:v1:{brand}:current            -> the dateKey web should resolve
//    swish:v1:meta:{brand}:{dateKey}     -> { generatedAt, vizCount, rowCounts }
//    swish:version                       -> monotonic int (bumped per green cycle)
//    swish:worker:heartbeat              -> SET with 5-min TTL each cycle tick
//    swish:worker:leader                 -> leader lock (SET NX PX)
//
//  Backends: Redis (REDIS_URL) for prod/staging & multi-process; a disk-dir fallback
//  for single-box dev (worker + web share server/data/vizstore/*). Same interface.
//  Payloads are stored as EXACT bytes the HTTP response sends — never re-stringified.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const V = "swish:v1";
export const etagFor = (jsonString, version) => 'W/"' + crypto.createHash("sha1").update(String(version) + ":" + jsonString).digest("base64url").slice(0, 24) + '"';

const kViz = (b, v, d) => `${V}:${b}:${v}:${d}`;
const kEtag = (b, v, d) => `${V}:${b}:${v}:${d}:etag`;
const kCurrent = (b) => `${V}:${b}:current`;
const kMeta = (b, d) => `${V}:meta:${b}:${d}`;
const K_VERSION = "swish:version";
const K_HEARTBEAT = "swish:worker:heartbeat";
const K_LEADER = "swish:worker:leader";

export function createVizStore({ redisUrl, diskDir, log = () => {} }) {
  return redisUrl ? redisStore(redisUrl, diskDir, log) : diskStore(diskDir, log);
}

// ---------------------------------------------------------------- Redis backend
function redisStore(redisUrl, diskDir, log) {
  let client = null, ready = null;
  const connect = async () => {
    if (ready) return ready;
    ready = (async () => {
      const { createClient } = await import("redis");   // optional dependency
      client = createClient({ url: redisUrl });
      client.on("error", (e) => log("[vizstore] redis error: " + e.message));
      await client.connect();
      log("[vizstore] Redis connected");
      return client;
    })().catch((e) => { log("[vizstore] Redis unavailable: " + e.message); client = null; return null; });
    return ready;
  };
  const c = async () => (await connect());
  return {
    backend: "redis",
    async writeViz(brand, vizId, dateKey, jsonString, version) {
      const cl = await c(); if (!cl) throw new Error("redis down");
      const etag = etagFor(jsonString, version);
      const m = cl.multi();
      m.set(kViz(brand, vizId, dateKey), jsonString, { EX: 48 * 3600 });   // keep 48h for rollback
      m.set(kEtag(brand, vizId, dateKey), etag, { EX: 48 * 3600 });
      await m.exec();
      return etag;
    },
    async readViz(brand, vizId, dateKey) {
      const cl = await c(); if (!cl) return null;
      const [json, etag] = await Promise.all([cl.get(kViz(brand, vizId, dateKey)), cl.get(kEtag(brand, vizId, dateKey))]);
      return json == null ? null : { json, etag };
    },
    async writeMeta(brand, dateKey, meta) { const cl = await c(); if (cl) await cl.set(kMeta(brand, dateKey), JSON.stringify(meta), { EX: 48 * 3600 }); },
    async readMeta(brand, dateKey) { const cl = await c(); if (!cl) return null; const b = await cl.get(kMeta(brand, dateKey)); return b ? JSON.parse(b) : null; },
    async getCurrent(brand) { const cl = await c(); return cl ? cl.get(kCurrent(brand)) : null; },
    async flipCurrent(brand, dateKey) { const cl = await c(); if (cl) await cl.set(kCurrent(brand), dateKey); },
    async bumpVersion() { const cl = await c(); return cl ? cl.incr(K_VERSION) : 0; },
    async getVersion() { const cl = await c(); const v = cl ? await cl.get(K_VERSION) : null; return Number(v) || 0; },
    async heartbeat() { const cl = await c(); if (cl) await cl.set(K_HEARTBEAT, String(Date.now()), { EX: 300 }); },
    async heartbeatAgeMs() { const cl = await c(); if (!cl) return null; const t = await cl.get(K_HEARTBEAT); return t ? Date.now() - Number(t) : null; },
    // leader lock: SET NX PX; returns true if this id holds it
    async acquireLeader(id, ttlMs) { const cl = await c(); if (!cl) return false; const r = await cl.set(K_LEADER, id, { NX: true, PX: ttlMs }); return r === "OK"; },
    async renewLeader(id, ttlMs) { const cl = await c(); if (!cl) return false; const cur = await cl.get(K_LEADER); if (cur !== id) return false; await cl.set(K_LEADER, id, { PX: ttlMs }); return true; },
    async releaseLeader(id) { const cl = await c(); if (!cl) return; const cur = await cl.get(K_LEADER); if (cur === id) await cl.del(K_LEADER); },
  };
}

// ---------------------------------------------------------------- disk backend (dev)
// One file per key under diskDir; atomic writes via temp+rename. Fine for a single
// worker + web on one box. Not for multi-instance prod — use Redis there.
function diskStore(dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  log("[vizstore] disk backend at " + dir);
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = (name) => path.join(dir, safe(name) + ".json");
  const readJson = (name) => { try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return null; } };
  const writeAtomic = (name, obj) => { const f = file(name); const tmp = f + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); };
  return {
    backend: "disk",
    async writeViz(brand, vizId, dateKey, jsonString, version) {
      const etag = etagFor(jsonString, version);
      writeAtomic(kViz(brand, vizId, dateKey), { json: jsonString, etag, at: Date.now() });
      return etag;
    },
    async readViz(brand, vizId, dateKey) { const o = readJson(kViz(brand, vizId, dateKey)); return o ? { json: o.json, etag: o.etag } : null; },
    async writeMeta(brand, dateKey, meta) { writeAtomic(kMeta(brand, dateKey), meta); },
    async readMeta(brand, dateKey) { return readJson(kMeta(brand, dateKey)); },
    async getCurrent(brand) { const o = readJson(kCurrent(brand)); return o ? o.dateKey : null; },
    async flipCurrent(brand, dateKey) { writeAtomic(kCurrent(brand), { dateKey }); },
    async bumpVersion() { const o = readJson(K_VERSION) || { v: 0 }; o.v += 1; writeAtomic(K_VERSION, o); return o.v; },
    async getVersion() { const o = readJson(K_VERSION); return o ? o.v : 0; },
    async heartbeat() { writeAtomic(K_HEARTBEAT, { at: Date.now() }); },
    async heartbeatAgeMs() { const o = readJson(K_HEARTBEAT); return o ? Date.now() - o.at : null; },
    // single-box dev: the disk "leader" is always this process (no contention)
    async acquireLeader() { return true; },
    async renewLeader() { return true; },
    async releaseLeader() { },
  };
}

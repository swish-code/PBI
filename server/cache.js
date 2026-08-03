// ============================================================================
//  CACHE PERSISTENCE ADAPTER
//  The hot read path is always an in-memory Map (fastest — a Redis round trip
//  would defeat the <50ms warm target). This module is the L2 / persistence &
//  cross-instance-sharing backend behind that Map:
//     • default: local disk (JSON file)
//     • optional: Redis (set REDIS_URL) — enables shared warm cache across
//       multiple app instances and survives restarts centrally.
//  On boot we load() the persisted hot set into memory; the sweep persist()s it.
//  Cache VERSION lets us invalidate everything on a breaking change to the
//  measure logic / key scheme (bump CACHE_VERSION).
// ============================================================================
import fs from "node:fs";
import path from "node:path";

export const CACHE_VERSION = 3;   // bump to invalidate all persisted caches

export function createPersistence({ diskFile, redisUrl, log = () => {} }) {
  const versionKey = `bpa:viz-cache:v${CACHE_VERSION}`;

  // ---- Redis backend (lazy — only if REDIS_URL is set and 'redis' installed)
  if (redisUrl) {
    let client = null, ready = null;
    const connect = async () => {
      if (ready) return ready;
      ready = (async () => {
        const { createClient } = await import("redis");   // optional dependency
        client = createClient({ url: redisUrl });
        client.on("error", (e) => log("[cache] redis error: " + e.message));
        await client.connect();
        log("[cache] Redis connected → shared warm cache enabled");
        return client;
      })().catch((e) => { log("[cache] Redis unavailable, falling back to disk: " + e.message); client = null; return null; });
      return ready;
    };
    return {
      backend: "redis",
      async load() {
        try { const c = await connect(); if (!c) return diskLoad(diskFile);
          const blob = await c.get(versionKey); return blob ? JSON.parse(blob) : []; }
        catch { return diskLoad(diskFile); }
      },
      async persist(entries) {
        try { const c = await connect(); if (!c) return diskSave(diskFile, entries);
          await c.set(versionKey, JSON.stringify(entries), { EX: 24 * 3600 }); }
        catch { diskSave(diskFile, entries); }
      },
      async clear() { try { const c = await connect(); if (c) await c.del(versionKey); } catch {} diskSave(diskFile, []); },
    };
  }

  // ---- disk backend (default, single instance) ----------------------------
  return {
    backend: "disk",
    async load() { return diskLoad(diskFile); },
    async persist(entries) { diskSave(diskFile, entries); },
    async clear() { diskSave(diskFile, []); },
  };
}

function diskLoad(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && j.version === CACHE_VERSION && Array.isArray(j.entries)) return j.entries;
    return [];   // version mismatch → treat as empty (invalidated)
  } catch { return []; }
}
function diskSave(file, entries) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: CACHE_VERSION, entries })); }
  catch { /* ignore */ }
}

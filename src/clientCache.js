// ============================================================================
//  CLIENT-SIDE INSTANT CACHE (IndexedDB + stale-while-revalidate)
//  Dashboard payloads are persisted in the browser so that:
//    • a repeat visit / full page refresh shows the LAST data instantly
//      (0 network), then
//    • a background fetch revalidates and swaps in fresh data,
//    • without ever blocking navigation.
//  IndexedDB (not localStorage) because dashboard payloads are large (100KB+).
// ============================================================================
const DB_NAME = "bpa-cache";
const STORE = "viz";
const VERSION = 1;
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbp;
}

async function idbGet(key) {
  const db = await openDB(); if (!db) return null;
  return new Promise((resolve) => {
    try { const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      tx.onsuccess = () => resolve(tx.result || null); tx.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function idbSet(key, value) {
  const db = await openDB(); if (!db) return;
  try { db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key); } catch { /* quota / closed */ }
}

// Stale-while-revalidate fetch. `apply(data, meta)` is called up to twice:
//   1. immediately with cached data (meta.stale=true, meta.ts=cachedAt) if present
//   2. with fresh data (meta.stale=false, meta.ts=now) once the network resolves
// Returns the fresh promise so callers can await completion if they want.
export async function swr(cacheKey, fetcher, apply) {
  let hadCache = false;
  try {
    const cached = await idbGet(cacheKey);
    if (cached && cached.data !== undefined) { hadCache = true; apply(cached.data, { stale: true, ts: cached.ts }); }
  } catch { /* ignore */ }
  try {
    const fresh = await fetcher();
    const ts = Date.now();
    apply(fresh, { stale: false, ts });
    idbSet(cacheKey, { data: fresh, ts });
    return fresh;
  } catch (e) {
    if (!hadCache) throw e;   // no cache to fall back on → surface the error
    return null;              // keep showing stale data on network failure
  }
}

export async function clearClientCache() {
  const db = await openDB(); if (!db) return;
  try { db.transaction(STORE, "readwrite").objectStore(STORE).clear(); } catch {}
}

// human "updated 2m ago"
export function agoLabel(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

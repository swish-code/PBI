# Scaling & performance — running for ~300 users

The workload is **read-heavy on cached data**. Almost every request is served from
an in-memory cache; Power BI is only queried on a cold or stale key. So the job of
scaling is (1) make sure the cache is already warm for the scopes real users have,
(2) stop browsers re-fetching what they just fetched, and (3) put enough CPU behind
gzip + JSON serialization. All three are addressed below.

## What's already in place

- **Stale-while-revalidate cache** (`vizCache`): a warm key is served instantly
  from memory and refreshed in the background — a user never waits on Power BI for
  a page they've seen.
- **Cold-miss de-duplication** (`vizInflight`): if 300 users hit the same cold key
  at once, Power BI is queried **once** and all 300 share the result.
- **Scope-shared cache keys**: two users with the same data scope share cache
  entries. RLS is applied in DAX, so scope — not identity — is the only key
  differentiator.
- **Priority queue + disk/Redis persistence**: background refresh, survives reboot.
- **gzip** on responses (~75% smaller viz JSON).

## What changed for 300 users

1. **Scope-aware pre-warm** — pre-warm now warms **one synthetic user per distinct
   real-user scope** (bounded by `PREWARM_MAX_SCOPES`, default 25), not just the
   all-brands admin. Because scope is the cache-key differentiator, this warms the
   cache for *every* user, so brand/area/store users hit warm cache too — not just
   CEO/GM. Runs on boot and daily before business hours.
2. **HTTP cache headers** on `/api/viz` and `/api/viz-batch`:
   `private, max-age=20, stale-while-revalidate=120`. Each browser serves repeat
   navigations from its **own** cache (0 network) for 20s and stays instant via SWR
   for 2 min. `private` because results are RLS-scoped — never cache in a shared
   proxy/CDN. This is the biggest lever: 300 users navigating the same pages stop
   generating redundant server hits.
3. **Compression threshold** (`1024`) — tiny payloads skip gzip so CPU isn't spent
   compressing sub-1KB bodies under load.
4. **`trust proxy` + `x-powered-by` off** — correct client IPs / secure cookies
   behind a load balancer.
5. **Single-process static serve** (`SERVE_STATIC=1`) — after `npm run build`, one
   Node process serves both the API and the app. Hashed assets are cached
   `immutable, 1yr`; `index.html` is `no-cache` so deploys are picked up instantly.

## How to deploy at scale

**Single box (simplest, handles a lot):**
```
npm run build
SERVE_STATIC=1 node server/server.js      # serves API + SPA on one port
```
Put nginx/Caddy in front for TLS. The in-memory cache + SWR means Node serves
cached JSON from RAM — a single process handles thousands of req/s of cached reads.

**Horizontal (multiple instances behind a load balancer):**
- Set `REDIS_URL` so all instances share the persisted cache and reload each
  other's warm results on boot.
- Run N instances (one per box, or `node --cluster`-style per core) behind the LB
  with **sticky sessions** (the auth cookie is per-instance-agnostic, but sticky
  keeps a user's warm in-memory cache on one instance).
- Note: each instance keeps its **own** in-memory hot cache; Redis is the shared
  *persistence* layer, not the live serving path. Prefer scaling up the single
  process first (it's rarely the bottleneck) before scaling out.

## The real ceiling: Power BI query throughput

`executeQueries` runs as the single master user and Power BI serializes it
(~0.7s each; >6 concurrent throttles). The cache + pre-warm exist precisely so
users almost never hit this. If cold traffic ever saturates it, the levers are:
increase `VIZ_BATCH_CONCURRENCY` cautiously, widen pre-warm coverage, or move to a
Power BI capacity with higher query concurrency.

## Env knobs

| Var | Default | Purpose |
|---|---|---|
| `PREWARM_MAX_SCOPES` | 25 | Max distinct user scopes to pre-warm |
| `PREWARM_HOUR` | 6 | Local hour of the daily warm-up |
| `VIZ_HTTP_CACHE` | `private, max-age=20, stale-while-revalidate=120` | Browser cache policy for viz responses |
| `VIZ_BATCH_CONCURRENCY` | 4 | Parallel Power BI queries per batch |
| `SERVE_STATIC` | off | Serve the built SPA from the API process |
| `TRUST_PROXY_HOPS` | 1 | Reverse-proxy hops to trust |
| `REDIS_URL` | — | Shared cache persistence across instances |

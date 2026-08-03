# Performance audit & optimizations

Audit of the freezing/lag issues, what was already in place, what was changed, and the
larger items still recommended. Written 2026-07.

## What was already good (verified, not re-done)

- **Route-based code splitting** — every page is `lazy()`-loaded in `App.jsx` (`PAGE_IMPORTS`),
  so navigating a page loads only that chunk. Chunks are pre-warmed on idle (`preloadPages`).
- **Server visual cache** — `server/cache.js` + `vizCache`: results keyed by
  visual + user scope + range + `vizDefHash` (DAX+cols hash), persisted to disk, SWR refresh.
- **Prewarm yields to live traffic** — background warm-up runs at `PRIO.PREWARM`; whenever a
  user cold-miss query is in flight (`liveInflight > 0`) prewarm **pauses** (`drainRefresh`),
  so it does not starve interactive queries. Bounded concurrency to Power BI (`mapLimit`).
- **Client SWR + IndexedDB** — `clientCache.js` paints the last-seen view instantly, then
  revalidates. Skeleton loaders per card. `vizInflight` de-dupes concurrent identical queries.
- **Error boundary** — `PageErrorBoundary` stops one bad visual from white-screening the app.

## Bottlenecks found

1. **Dashboard was all-or-nothing.** The landing page fired 7 Power BI queries and waited for
   `Promise.all` before painting anything past the skeleton — so a single slow query (e.g. the
   ops matrix) blocked the KPI cards.
2. **AOV baseline query was uncached and ~40s.** `/api/aov-baseline` (trailing-6-month AOV) ran
   the heavy DAX on every request, leaving derived Orders-Target columns blank until it returned.
3. Heavy client renders on wide tables (AG-Grid) and ECharts are the main main-thread cost on
   cold loads; these are already virtualized by AG-Grid but the ECharts count per page is high.

## Changes applied

- **Progressive Dashboard render** (`LandingPage.jsx`): each visual now paints the moment *its*
  query resolves; `setLoading(false)` fires as soon as `landing_head` (the KPIs) lands instead of
  waiting for the slowest query. KPIs/priority content appear first.
- **Daily cache on the AOV baseline** (`server.js`): `/api/aov-baseline` memoizes per user+brand+day.
  First call of the day computes (~40s), the rest are instant.
- **Expired-session handling** (`App.jsx`): a fetch interceptor drops to the login screen with a
  clear message on any authed `401`, instead of leaving broken pages.
- **Minimal splash** — logo-only, no text/progress, overlays the app so it never delays render.

## Recommended next (larger, deliberately not done in this pass)

- **Move heavy aggregates out of Power BI runtime.** The 6-month AOV baseline, ops offline calc,
  and Yelo pizza grids are the slowest DAX. Precomputing these into Snowflake (or a nightly job
  that populates the disk cache) would remove the runtime cost entirely. This is the single biggest
  lever and is an infra change, not a frontend tweak.
- **AbortController on page/filter change** — cancel in-flight `fetchViz` when the user navigates
  or changes filters before responses land (currently they resolve and are discarded).
- **Cap concurrent ECharts** per page / defer below-the-fold charts with `IntersectionObserver`
  (Overview already uses `InView` for some; extend to all heavy charts).
- **Formal measurement** — add timing marks around each `executeQueries` and a slow-query log,
  and capture Lighthouse/Web-Vitals before/after on a throttled profile. Not yet instrumented.

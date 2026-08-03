# Power BI model optimization - the real speedup (for the data team)

Measured from the live app (`/api/admin/perf`). These are the slowest queries; the app
already batches (1 query/panel), pushes all filters into DAX, caches + prewarms. The
remaining cost is **in the model**, so the big wins are model-side.

## Measured slowest queries (cold, max ms)
| Query | Max | What it computes |
|---|---|---|
| landing_ops_matrix | ~94s | Brand x Location: Avg Prep, Delivery, Complaint, Rating |
| landing_ops / ops_kpis | ~60s | Prep / Delivery / Complaint / Rating / Offline / Discount |
| landing_hourly | ~50s | Net + benchmarks by hour |
| landing_achievement | ~55s | MTD/month sales vs target/forecast (app now trims unused QTD/YTD) |
| landing_channels | ~24s | Channel net + comparisons |

## Root cause #1 - Avg Prep Time (the biggest)
The app calls `'Append1'[Avg Prep Time (min)]` wrapped in an inline row filter to drop
outliers:
```
CALCULATE('Append1'[Avg Prep Time (min)],
  KEEPFILTERS(FILTER(TALABAT_LOGISTICS,
    VAR __pm = (TALABAT_LOGISTICS[VENDOR_PREPARED_AT] - TALABAT_LOGISTICS[ACCEPTED_BY_VENDOR_AT]) * 24 * 60
    RETURN NOT ISBLANK(__pm) && __pm >= 5 && __pm <= 30)))
```
This recomputes `__pm` **per row of the multi-million-row logistics table, for every
comparison period (current/WoW/MoM/YoY) and every matrix cell (brand x location)**.
That is the ~60-94s.

**Fix (model):** add a **computed column** on `TALABAT_LOGISTICS`:
```
PrepMinutes = (TALABAT_LOGISTICS[VENDOR_PREPARED_AT] - TALABAT_LOGISTICS[ACCEPTED_BY_VENDOR_AT]) * 24 * 60
ValidPrep   = NOT ISBLANK([PrepMinutes]) && [PrepMinutes] >= 5 && [PrepMinutes] <= 30
```
Then the measure becomes a plain average over a pre-computed, pre-filtered column
(`CALCULATE(AVERAGE([PrepMinutes]), [ValidPrep] = TRUE())`) - no per-row arithmetic in a
`FILTER`. Expected: **~60s -> a few seconds.** (Same pattern for any complaint/offline
measure that does per-row computation inside a FILTER.)

## Root cause #2 - dataset contention
~38 visuals (landing + operations + overview) all live on the **main** dataset, and Power
BI serializes `executeQueries` per dataset. A cold operations page = 15 heavy queries run
essentially back-to-back. Two options:
- **Aggregation / summary tables** in the model at the visual grains (e.g. Date x Hour x
  Branch x Channel x Category with the sales/orders/prep measures pre-summed) so heavy
  visuals read a small agg table instead of scanning the fact.
- Or the app's **worker + Redis pre-compute** (Phase 3) so users never wait on these at
  all - that removes the runtime dependency regardless of model speed. (In progress.)

## Root cause #3 - capacity
If these datasets are **DirectQuery** or on **shared / Pro** capacity, 11s+/query is
expected. **Import mode on Premium/Fabric capacity** typically drops the same queries to
sub-second. Confirm storage mode + capacity per dataset.

## Priority
1. `PrepMinutes`/`ValidPrep` computed columns (fixes the top 3 offenders). **Do first.**
2. Confirm capacity / storage mode.
3. Aggregation tables for the heavy landing/ops grains.

The app side is already optimized (batched, filtered, cached, prewarmed) and value-gated
against golden fixtures - these model changes are where the remaining seconds are.

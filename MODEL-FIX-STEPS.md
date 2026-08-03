# Make the Operations tiles fast — step-by-step for the Power BI model owner

**Who this is for:** whoever edits the `.pbix` / semantic model in Power BI Desktop.
**Time:** ~15 minutes per model. **Risk:** low (adds two columns, simplifies one measure — numbers stay identical).
**Result:** the Operations queries drop from **~60 seconds to ~2 seconds**, permanently, for every user and every date. No app changes needed.

---

## Why this works (one line)
Today the `Avg Prep Time (min)` measure **calculates prep-minutes for every row of the logistics table, every time it runs, for each comparison period**. We move that calculation to a **stored column** that is computed once at data-refresh — so the measure just **averages a stored number** instead of recomputing millions of rows on every query.

---

## Step 1 — Add two computed columns on `TALABAT_LOGISTICS`

In Power BI Desktop: **Model/Data view → select the `TALABAT_LOGISTICS` table → New column.** Paste each of these (one column each):

```DAX
PrepMinutes =
( TALABAT_LOGISTICS[VENDOR_PREPARED_AT] - TALABAT_LOGISTICS[ACCEPTED_BY_VENDOR_AT] ) * 24 * 60
```

```DAX
ValidPrep =
NOT ISBLANK ( TALABAT_LOGISTICS[PrepMinutes] )
    && TALABAT_LOGISTICS[PrepMinutes] >= 5
    && TALABAT_LOGISTICS[PrepMinutes] <= 30
```

`PrepMinutes` = the prep time in minutes for that order. `ValidPrep` = TRUE only for the
"real" range (5–30 min), which is the same outlier filter the current measure uses.

> These are **calculated columns** (computed at refresh and stored), *not* measures.

---

## Step 2 — Rewrite the measure to read the stored column

Find the existing measure **`Avg Prep Time (min)`** (in the `Append1` table). Replace its
definition with:

```DAX
Avg Prep Time (min) =
CALCULATE (
    AVERAGE ( TALABAT_LOGISTICS[PrepMinutes] ),
    TALABAT_LOGISTICS[ValidPrep] = TRUE ()
)
```

That's it — no `FILTER`, no per-row arithmetic. Same result, computed from stored values.

---

## Step 3 — Confirm the numbers are identical (do NOT skip)

Before / after, check the measure gives the **same value**:
1. Put `Avg Prep Time (min)` in a simple card or table visual, sliced to one day (e.g. a
   recent date with data).
2. Note the number **before** you change the measure, then again **after**.
3. They must match (to the decimal). If they match → you're done and it's now fast. If they
   differ, the old measure had an extra condition — tell the app team the old definition and
   we'll adjust the column filter to match.

---

## Step 4 — Publish

**Home → Publish** (or refresh in the Service). The app picks up the faster model
automatically — no code deploy, no app restart needed.

---

## Step 5 — Repeat for the other models

The same `Avg Prep Time (min)` measure lives in **each brand's model** that has a
`TALABAT_LOGISTICS` table (BBT, MM, Tabel, Shakir, Yelo, the main SWiSH model). Apply Steps
1–4 to each. (Skip any model that doesn't have the logistics table.)

---

## Same pattern for the other slow ops measures (optional, same idea)
If **Complaint ratio**, **Offline rate**, or **Delivery time** also do per-row math inside a
`FILTER`, give them the same treatment: add a stored column for the row-level value, then
make the measure a plain `AVERAGE`/`SUM`/`DIVIDE` over it. Prep time is the biggest offender,
so do it first and measure the improvement before deciding whether the others are worth it.

---

## What NOT to do
- Don't convert the model to DirectQuery (it's Import/Premium today — that's the fast tier;
  keep it).
- Don't remove the 5–30 minute outlier filter — it's preserved as `ValidPrep`.
- Don't change any column names the app already reads; you're only **adding** `PrepMinutes`
  / `ValidPrep` and **simplifying** the one measure's formula.

---

### Summary for a non-technical sign-off
> "We're pre-calculating the prep-time-per-order once when the data refreshes, instead of
> re-calculating it live every time someone opens the Operations page. Same numbers, but the
> page loads in ~2 seconds instead of ~60. It's a 15-minute change per dashboard, no app
> deployment, and it's reversible."

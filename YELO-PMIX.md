# Yelo Product Mix — how the page works (fields, filters, queries)

**Data source:** the Yelo semantic model, one table: **`LINE`** (grain = one order line).
**Date column:** `LINE[VoucherDate]`.
**Money:** `SUM(LINE[SalesAmount])`. **Quantity:** `SUM(LINE[AdjustedQuantity])`.

---

## 1. Guard filters — applied to EVERY Yelo query
These run on every visual, always:

| Guard | Rule | Why |
|---|---|---|
| `__gl` | `LINE[LocationId] NOT IN {"CAT","COOP","CT2"}` | excludes catering / co-op / test locations |

_(The `SellingPrice > 0` guard was **removed** — zero-price bundle/component lines now count, so items like the individual flavours inside a "4 for 4" deal are included.)_

---

## 2. Page filter bar → the column each filter hits
(top of the page; "All" = no filter)

| Filter label | Column filtered |
|---|---|
| Product | `LINE[NewItemName]` |
| Menu Category | `LINE[CategoryDescription]` → `OPTION_PARENT_CATEGORY_NAME` fallback |
| Size | `LINE[Category]` |
| **Pizza Type** | `LINE[PizzaCategory]` (crust) |
| Flavour | `LINE[PizzaFlavour]` |
| Source | `LINE[Ordersource]` |
| Order Type | `LINE[Ordertype]` |
| Location | `LINE[LocationId]` |
| Group | `LINE[ItemGroup]` |
| (price range) | `LINE[UNIT_PRICE]` between min/max |

Plus the global **date slicer** → `LINE[VoucherDate]`.

---

## 3. The four pizza dimensions (all computed columns in the model)

| We call it | Column | What it is | Example values |
|---|---|---|---|
| **Flavour** | `PizzaFlavour` | the flavour | Pepperoni, Margharita, BBQ Chicken. **BLANK for Half&Half** |
| **Size** | `Category` | size bucket, derived from the item name | Medium Pizza, Large Pizza, **Half&Half Pizza** |
| **Pizza Type / Crust** | `PizzaCategory` | crust, derived from the item name | New York, Pan, Long Pizza, Thin Crust, **All For One**, Cheezy Pepperoni Crust, Cheesy Jalapeno Crust |
| **Pizza Item** | `NewItemName` | full cleaned product name (crust+size+flavour) | *NY Medium Classic Pepperoni Pizza* |
| Half&Half halves | `PIZZA_CHOICE_NAME` | the chosen flavour of each half | (only on Half&Half lines) |

`Category`, `PizzaCategory`, `PizzaFlavour`, `NewItemName` are all **calculated columns** — big DAX `SWITCH`/`SEARCH` blocks that parse the raw item name. They are only as clean as those rules.

---

## 4. "Is this line a pizza?"
The pizza analysis (drilldown, size/crust/flavour mixes, All Pizzas, Half&Half) counts a line as a pizza **when `PizzaCategory` is not blank**.
The model fills `PizzaCategory` (the crust) only when the item matches a crust keyword (NY / Pan / Thin / Long / Square→All For One / Cheesy…) and leaves it **blank** for pasta and for sides — so this cleanly:
- ✅ keeps every real pizza and every crust
- ❌ excludes sides (garlic bread, wedges, wings) and pasta automatically.

---

## 5. AdjustedQuantity — how quantity is counted
```
AdjustedQuantity =
  IF Brand = "YP":
     IF flavour is set AND (item starts "HALF" OR contains "Long Pizza")  → Qty ÷ 2
     ELSE                                                                 → Qty
  ELSE Qty
```
So it **halves** Half and Long Pizza, and leaves everything else as-is. **Square-Pan / All For One pizzas get no adjustment** — if their `Qty` is recorded per-square they'd over-count (this is a model rule to review).

---

## 6. Every visual on the page

| Widget | Query | Grain / dims | Measures |
|---|---|---|---|
| KPIs | `yp_kpis` | totals | Qty, Net Sales, Orders, Pizza Qty, AOV |
| New Item Launch | `yp_launch_detail` | NewItemName × Category | Sales, Qty, Velocity, Penetration %, is-new |
| Hero Items / Bestsellers | `yp_hero` | NewItemName × Category | Penetration %, Velocity, Sales, Orders |
| Frequently Bought Together | `yp_together` | NewItemName | co-purchase % |
| Cross-Sell & Attach | `yp_xa_cards` | NewItemName × MAIN_ITEM × ITEM_ROLE | cross-sell / attach % |
| Menu Item Category / Category Performance | `yp_menucat` | Menu Item Category | Qty, Sales, Mix % |
| Category Sales Mix | `yp_cat_month` | CategoryDescription × Month | sales-mix % per month |
| Product Mix Detail | `yp_products` | Category › Main Product › Item | Mix %, Amount, Qty (+WoW/MoM/YoY), Pen %, Velocity |
| Pizza Type (crust) | `yp_pizzatype` | PizzaCategory | Qty |
| Pizza · Size mix | `yp_pz_size` | Category (pizza sizes) | Sales |
| Pizza · Flavour analysis | `yp_pz_flavour` | PizzaFlavour | Sales, Pizzas sold, Order share % (incidence) |
| Pizza · Drilldown (reorderable) | `yp_pz_grid` | any order of Flavour/Size/Crust/Item | Sales, Qty |
| Pizza · All Pizzas | `yp_pz_grid` | NewItemName | Sales, Qty |
| Pizza · Half & Half combinations | `yp_pz_halfhalf` | PIZZA_CHOICE_NAME (Half&Half lines) | Sales, Qty |

---

## 7. Data-quality checklist (to clean the source)
1. **Half&Half has no `PizzaFlavour`** → shows "—". If you want a flavour for it, populate `PizzaFlavour` or rely on `PIZZA_CHOICE_NAME`.
2. **`AdjustedQuantity` doesn't adjust Square-Pan / All For One** — decide the rule (1 pan = 1 pizza? ÷ N squares?) and fix the column.
3. **Sides tagged crust "All For One"** (garlic bread, wedges, wings) — ideally give them a non-pizza crust/blank so they never look like pizzas.
4. **`Category` (size) can be blank** for some items → shows "—". Extend the size-parsing rules if you want them bucketed.
5. **Calculated columns parse the item name** — any new/oddly-named product won't be classified until its name matches the SWITCH/SEARCH rules. Keeping item names consistent = clean mix data.
6. Revenue excludes `SellingPrice = 0` lines; all metrics exclude locations `CAT / COOP / CT2`.

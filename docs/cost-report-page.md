# Cost Report page — implementation brief

Port of `~/Repos/work/management/scripts/ai-cost-report.py` into omnifex as a page.

**The headline: this is not a data-collection project.** `session_cost_daily` already holds
almost everything the Python script computes from, for **both** accounts, updated by a startup
backfill and a periodic sweep. What is missing is (a) six columns, (b) a set of aggregate
queries, (c) a page. The script's actual value — per-project attribution, cost by component,
caching ROI — is all derivable from data already on disk.

Verified 2026-08-26: `session_cost_daily` holds 1,130 rows / 933 sessions / $6,407.68 spanning
2026-06-10 → 2026-08-26. August Work = $866.48 against the Python script's ~$880 (1.5% apart —
see "Reconcile the dedup" below, which is probably the whole difference).

---

## 1. What the script produces, and where each piece comes from

| Report section | Data today | Work needed |
|---|---|---|
| Total $, tokens, active days | `aggregate()` | none |
| **Request count** | not stored — rows are pre-aggregated per (session, date, model) | **new column** |
| **Component split** (cache read / write / output / fresh input) | computed in `session-cost-core.ts` as `SessionCostSnapshot.breakdown`, then **thrown away** | **4 new columns** |
| Caching ROI (read:write, saved-vs-uncached, 1h premium) | `cache_read_tokens`, `cache_write_5m_tokens`, `cache_write_1h_tokens` all stored separately | query only |
| By project | `project_path` column | query + display-name mapping |
| By model | `model` column | query |
| Weekly | `PERIOD_EXPR.week` in `cost-history.ts` | none |
| Project × model | both columns | query |
| **Subagent vs main loop** | computed as `subagentUsd`, **not persisted** | **2 new columns** |
| **Unpriced models** | silently priced at Sonnet tier — see §5 | **behaviour change** |
| Console reconciliation | n/a | UI input |

Two things the omnifex version gets **for free that the Python script never had**:

- **Both accounts.** The script reads `~/.claude-work` only. `session_cost_daily.account_name`
  covers Work and Personal, so the Max-vs-Enterprise split becomes visible in one place. Default
  the page to a single account and make it a filter — mixing them in one total is misleading,
  they are different bills.
- **Real project paths** rather than the script's `pretty_project()` guesswork on encoded
  directory names.

---

## 2. Migration

```sql
ALTER TABLE session_cost_daily ADD COLUMN request_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN input_usd          REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN output_usd         REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN cache_read_usd     REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN cache_write_usd    REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN subagent_usd       REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN subagent_requests  INTEGER NOT NULL DEFAULT 0;
```

Follow the existing migration pattern in `electron/services/database.ts` (the
`session_cost_daily` migration at ~line 592 is the model to copy).

**Persist the component costs; do not recompute them at query time.** This is the one design
decision that matters. `cost_usd` is computed at ingest using the rates in force then. If the
page recomputes the component split from tokens × *current* rates, the parts stop summing to the
whole the moment a price changes — and they will disagree silently. Store the split at ingest,
next to the total it belongs to.

Backfill: existing rows get zeros. Force a one-time full re-scan by bumping the stored file
signature scheme, or accept that history has no component split until each session is touched
again. Recommend the former — `backfill()` already re-reads everything when the signature misses.

---

## 3. Wiring the page in

The tab system is small and explicit. Four edits:

1. `src/contexts/TabContext.tsx:11` — add `'cost-report'` to the `type` union.
2. `src/components/TabContent.tsx` — add a `case 'cost-report':` beside `case 'usage':` (~line 692).
   Lazy-import like `UsageDashboard` does at line 28.
3. `src/components/TabManager.tsx:50` — add the tab label/icon beside the `'usage'` case.
4. `src/hooks/useTabState.ts:87` — add an opener following the `usage` singleton pattern
   (find-existing-or-create, so it can't be opened twice).

`CostsView.tsx` (191 lines) is the closest existing model for the page itself: range presets,
account filter, `groupBy`, a refresh that calls `rescan`. Read it before writing anything.

**Charts: `recharts` ^3.8.1 is already a dependency.** The Python version's chart rules carry
over and matter — model→colour must be **fixed per model**, not assigned by rank, so the legend
means the same thing across months, and the palette deliberately matches the Anthropic console's
so the two can be read side by side. Do not recolour by rank.

---

## 4. Service layer

Extend `electron/services/cost/cost-history.ts` — it already owns `aggregate()`, `sessions()`,
`backfill()` and the `whereClause()` filter builder. Add sibling query functions rather than a
new service:

- `byProject(filters)` — `GROUP BY project_path`
- `byModel(filters)` — `GROUP BY model`
- `byProjectModel(filters)` — `GROUP BY project_path, model`
- `components(filters)` — `SUM` of the four new `*_usd` columns
- `cachingRoi(filters)` — read:write ratio, saved-vs-uncached, 1h premium
- `subagentSplit(filters)` — main vs subagent

Expose through the existing IPC surface at `electron/main.ts:1402-1404`, which already routes
`aggregate` / `sessions` / `rescan`. Add the new names to the same object; mirror the types into
`src/lib/api.ts` next to `CostHistoryPeriod` (line ~518).

**Caching ROI formulas**, from the Python (`ai-cost-report.py`):

```
saved   = cache_read_tokens × input_rate × (1 − 0.10)     // vs paying full input rate
ratio   = cache_read_tokens ÷ cache_write_tokens          // break-even ≈ 2:1
premium = cache_write_1h_tokens × input_rate × (2.00 − 1.25)
```

The ratio is the headline number. Above ~2:1 caching is net-positive; Greg's has been 35–39:1.
If it ever approaches 2:1, that is a real finding and the UI should say so loudly rather than
just printing a number.

---

## 5. Three defects to fix in the port, not carry over

**(a) Unknown models are silently mispriced.** `src/lib/pricing.ts:82` —
`DEFAULT_RATES = { inputPerM: 3, outputPerM: 15 }`, a Sonnet-tier fallback applied to any model
whose id matches no `RATE_TABLE` pattern. A newly released model gets billed at Sonnet rates with
no warning. The Python script instead collects unmatched models into an "unpriced records"
section and prints a count — which is how `<synthetic>` records were found. Port that behaviour:
surface unpriced models, never silently default. `is_estimated` already exists as a carrier flag;
it needs to actually reach the UI.

**(b) `RATE_TABLE` has no effective dating.** Rates are flat, so a price change re-prices all
history the next time a session is re-scanned. The stored `cost_usd` protects already-ingested
rows, but any re-scan re-prices them. Port the effective-dated structure now in
`~/Repos/work/management/scripts/pricing.json`: each model maps to a list of
`{ from: "YYYY-MM-DD", input, output }` periods, and the applicable one is the latest `from` on
or before the row's date. Cache multipliers need the same treatment.

Note omnifex *already* has the no-recompile half of this: `pricing_overrides` in `app_settings`,
edited via `src/components/PricingOverridesEditor.tsx`, read at `electron/main.ts:914`. It has
**never been set** (no row in `app_settings`). The override shape needs extending with `from`
dates, and then it becomes the single rate source for both omnifex and the Python scripts —
at which point `scripts/pricing.json` can be deleted and the Python reads the DB.

**(c) Reconcile the dedup.** `electron/services/cost/usage-extract.ts:43` keys rows by
`requestId || message.id || lineIndex`. The Python script collapses on **`message.id` alone**,
and `management/CLAUDE.md` records that as a hard invariant — adding fields to the key made it
weaker, not stronger, and silently overstated June/July by 8–12%. These two schemes can disagree.
Given August Work reads $866.48 here vs ~$880 there, **check this before trusting either number**;
it is the most likely source of the 1.5% delta. Decide one scheme, write down why, and make both
implementations use it.

---

## 6. What the page should say, not just show

The Python version's value is the interpretation, and it should survive the port. Four framings
worth building into the UI rather than leaving to the reader:

- **Component split as a sentence.** "87% of spend is context, 13% is generated output" reframes
  "we spend a lot on AI" into "we spend a lot on *re-sending context*" — a different and more
  fixable problem. Put the sentence above the table.
- **Subagent vs main loop.** August: subagents cost **$0.066/request vs $0.149** on the *same*
  model — 2.2× cheaper, because they carry less context. 18.7% of requests for 9.4% of spend.
  This is the evidence for "delegate to a fresh context", and it is the single most useful number
  the analysis produced. It is also currently computed and discarded.
- **Per-project mismatch.** The question is whether the biggest project matches where attention
  actually went. A repo burning money after its branch merged is the failure this catches.
- **Burstiness.** Name the two or three heavy days. Aggregate months look alarming and are usually
  a couple of heavy sessions.

---

## 7. Scope note

Do this as **two** changes, not one:

1. **Migration + ingest** (columns, persist the split, dedup decision, unpriced surfacing). Ships
   without UI; verifiable by querying the DB directly against the Python script's output for
   August. That comparison is the acceptance test — the two should agree to well under 1%.
2. **The page.** Only worth building on data you have already reconciled.

Effective-dated pricing (§5b) is independent of both and can land first or last, but landing it
first avoids re-doing the backfill.

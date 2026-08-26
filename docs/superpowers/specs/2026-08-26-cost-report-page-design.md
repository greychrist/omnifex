# Cost Report page — design

Status: approved 2026-08-26. Supersedes the exploratory brief at
`docs/cost-report-page.md`, which was written before the numbers were checked and gets
§5c wrong (see §1.2).

Ports the analysis in `~/Repos/work/management/scripts/ai-cost-report.py` into OmniFex as a
first-class page, reachable from a titlebar button beside Lima and Brain.

---

## 1. What is actually wrong today

The brief's premise — "this is not a data-collection project, the data is already there" — is
half right. `session_cost_daily` holds 1,130 rows / 933 sessions / $6,409 spanning 2026-06-10 →
2026-08-26, for both accounts. But the ingest that fills it has a real defect, and so does the
Python script it is being reconciled against.

### 1.1 Measured, not assumed

August 2026 / Work account, three ways of counting the same transcripts:

| | total | opus-5 records | output tokens | cache-read tokens |
|---|---|---|---|---|
| OmniFex today | $868.28 | 5,889 | 4,748,414 | 997,370,709 |
| `ai-cost-report.py` today | $883.85 | 6,424 | 4,187,335 | 1,036,743,929 |
| **Correct** | **$905.69** | 6,424 | 5,061,048 | 1,036,743,929 |

The OmniFex row reproduces `session_cost_daily` exactly, so the reproduction is trustworthy.

Two independent defects, pointing in opposite directions, which is why they nearly cancel and
looked like a single ~1.5% "dedup drift":

**(a) OmniFex misses workflow subagents.** `cost-history.ts:backfill()` lists
`<session>/subagents/` non-recursively for `agent-*.jsonl`. The CLI also writes
`<session>/subagents/workflows/wf_<id>/agent-*.jsonl` — one directory deeper. 16 such files in
August/Work, worth **$37.41**. `session-cost.ts` (the live watcher behind the header cost
widget) has the identical blind spot at lines 101–118, so live session cost under-reports too.

**(b) The Python's dedup understates output.** Not the key — the tie-break. The CLI writes one
JSONL line per content block and `output_tokens` *grows* across them as the response streams.
OmniFex keeps last-occurrence-wins (correct: the final line carries the full count). The Python
keeps first-wins. Worth **$21.84** on the Python side.

### 1.2 The dedup key is a non-issue

The brief's §5c asks us to reconcile `requestId || message.id || lineIndex` against
`message.id` alone, on the theory that the extra fields weaken the key. Measured over August/Work:

- zero `message.id` values appear in more than one file,
- zero assistant-usage records lack a `message.id`,
- `requestId` never splits a `message.id` group.

The two schemes produce byte-identical record sets. **Keep OmniFex's key unchanged.** The
`management/CLAUDE.md` invariant that motivated the concern is about a different, real bug —
adding `output_tokens` to the key — which OmniFex never had.

### 1.3 Consequence

The acceptance test for the data layer is August/Work reconciling to **$905.69**, not to either
implementation's current output. Fixing OmniFex to agree with the Python would be fixing it to
the wrong number.

---

## 2. Data layer

### 2.1 Shared recursive subagent walk

Extract a helper — `collectSubagentFiles(fsDeps, subagentsDir): string[]` — that walks
`<session>/subagents/` recursively and returns every `agent-*.jsonl` at any depth. Both
`cost-history.ts` and `session-cost.ts` consume it, replacing their two copies of the flat
`listDir().filter()` idiom.

The file signature used for change detection must fold in the full relative path, not the bare
basename, so that adding `workflows/wf_b/agent-x.jsonl` invalidates a session whose
`subagents/agent-x.jsonl` is unchanged.

### 2.2 Schema (migration 22)

Departs from the brief. The brief adds `subagent_usd` and `subagent_requests`; this design adds
`is_subagent` to the primary key instead.

```sql
ALTER TABLE session_cost_daily ADD COLUMN is_subagent     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN request_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN input_usd       REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN output_usd      REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN cache_read_usd  REAL    NOT NULL DEFAULT 0;
ALTER TABLE session_cost_daily ADD COLUMN cache_write_usd REAL    NOT NULL DEFAULT 0;
```

`is_subagent` joins the primary key, which SQLite cannot do with `ALTER TABLE`. The migration
therefore rebuilds: create `session_cost_daily_new` with
`PRIMARY KEY (session_id, date, model, is_subagent)`, copy the old rows in with zeros for the new
columns, drop, rename, recreate both indexes.

**Why the split row rather than two columns.** Two columns split only *cost*. Splitting the row
splits every metric — tokens, requests, cache ratios, component costs — for one column instead
of eight, and turns the main-vs-subagent toggle into an ordinary `WHERE` clause rather than a
special-cased display mode. It also composes: main-vs-subagent *within* a project *within* a
model needs no new code.

**Component costs are stored at ingest, never recomputed at query time.** This is the one design
decision the brief is unambiguously right about. `cost_usd` is computed with the rates in force
on the row's date; recomputing the split from tokens × current rates makes the parts stop summing
to the whole the moment a rate changes, and they would disagree silently.

### 2.3 Backfill

Existing rows keep `is_subagent = 0`, `request_count = 0`, and zeroed component costs until
re-scanned. No separate backfill pass is needed: `scannedSignatures` is a per-service **in-memory**
Map that starts empty on every process, so the first `backfill()` after launch already re-reads
every surviving session and rewrites its rows through `replaceSession`. History is fully populated
one sweep after the migration ships.

This also means the signature change in §2.1 costs nothing extra — it only matters within a
running process, where it is what makes a newly-created workflow subagent file get noticed.

### 2.4 Unpriced models

`<synthetic>` gets an explicit zero-cost `RATE_TABLE` entry, so it stops setting `is_estimated`.
It carries no usage and is expected; leaving it flagged trains the warning to be ignored.

Any other model matching no pattern still gets priced at the fallback (dropping it would
understate cost silently, which is worse) but sets `is_estimated = 1`. A new
`unpriced(filters)` query returns `{ model, records, cost_usd }` for flagged rows, driving a
banner on the page. Silent Sonnet-tier defaulting stops being invisible — this is exactly how
the Python found `<synthetic>` in the first place.

---

## 3. Effective-dated pricing

`RATE_TABLE` entries gain a period list:

```ts
{ pattern: 'opus-5', periods: [
  { from: '2024-01-01', inputPerM: 5, outputPerM: 25, fastInputPerM: 10, fastOutputPerM: 50 },
] }
```

`resolveRates(model, overrides, { speed, date })` selects the period with the latest `from` on or
before `date`. Cache multipliers become an effective-dated list for the same reason. Every
current rate becomes a single `from: '2024-01-01'` period, so today's numbers are provably
unchanged — the migration to this shape is rate-neutral by construction, and a test asserts it.

`date` is optional and defaults to today, so the renderer's per-message cost footer — which has
no date in hand and only ever prices a live turn — keeps working with no call-site change.
`computeSessionCost` passes each row's own date.

`PricingOverride` gains an optional `from`. `parsePricingOverrides` accepts both the flat shape
(treated as `from: '1970-01-01'`, i.e. always applicable) and a period array.
`PricingOverridesEditor` is not changed this round; the flat shape it writes stays valid.

`~/Repos/work/management/scripts/pricing.json` is **not** touched, and OmniFex does not read it.
The brief's end-state — one rate source shared with the Python — requires editing the work repo
and belongs to a `claude-work` session.

---

## 4. Service and IPC surface

`CostHistoryFilters` widens:

```ts
interface CostHistoryFilters {
  startDate?: string;
  endDate?: string;
  accountName?: string | string[];
  projectPath?: string | string[];
  model?: string | string[];
  projectSearch?: string;   // LIKE %…% over project_path
  isSubagent?: boolean;     // undefined = both
}
```

`whereClause()` expands arrays to `IN (?,?,…)`; an empty array means "no filter", not "match
nothing". Existing single-string callers — `CostsView`, the `cost:history` IPC adapter — are
unaffected.

New sibling queries in `cost-history.ts`, alongside `aggregate` / `sessions` / `backfill`:

| function | groups by |
|---|---|
| `byProject(filters)` | `project_path` |
| `byModel(filters)` | `model` |
| `byProjectModel(filters)` | `project_path, model` |
| `components(filters)` | none — `SUM` of the four `*_usd` columns |
| `cachingRoi(filters)` | none — read:write ratio, saved-vs-uncached, 1h premium |
| `subagentSplit(filters)` | `is_subagent` |
| `unpriced(filters)` | `model`, `WHERE is_estimated = 1` |
| `facets(filters)` | distinct accounts / models / projects, to populate the filter controls |

`aggregate()` gains `request_count` and the four component sums so the chart and KPI tiles come
from one round trip.

Caching-ROI formulas, carried over from the Python:

```
saved   = cache_read_tokens × input_rate × (1 − 0.10)
ratio   = cache_read_tokens ÷ cache_write_tokens
premium = cache_write_1h_tokens × input_rate × (2.00 − 1.25)
```

`ratio` is the headline. Below ~2:1 caching is net-negative and the UI must say so loudly rather
than printing a number. Because rates are per-model, these are computed per model and summed,
not derived from a blended rate.

All eight register on the existing `cost:` adapter object in `electron/main.ts` and mirror into
`src/lib/api.ts` beside `CostHistoryPeriod`. Each new channel goes in the `electron/preload.ts`
allow-list.

---

## 5. The page

`src/components/CostReportView.tsx`, opened as a singleton `cost-report` tab.

Wiring, following the Lima/Brain pattern exactly:

1. `src/contexts/TabContext.tsx:11` — add `'cost-report'` to the type union.
2. `src/hooks/useTabState.ts` — `createCostReportTab`, find-existing-or-create.
3. `src/components/TabManager.tsx` — `case 'cost-report': return DollarSign` in `getTabIcon`.
4. `src/components/TabContent.tsx` — `case 'cost-report':`, lazy-imported like `UsageDashboard`.
5. `src/components/CustomTitlebar.tsx` — an `onCostClick` button in the segmented group after
   Brain, wired from `src/App.tsx`.

`CostsView` stays where it is, inside the Usage dashboard. The two are allowed to coexist;
`CostsView` is the glance, this is the deep-dive.

### 5.1 Filters

A filter bar across the top, its state the single source of truth for every query on the page:

- **Date range** — presets (this month / last month / last 30d / last 90d / all time) plus
  explicit start/end date inputs. Choosing a custom date clears the preset selection.
- **Account, model, project** — multi-select checkbox lists, populated from `facets()`. Empty
  selection means "all", not "none".
- **Project search** — free-text, filters the project list and applies as `projectSearch`.
- **Main loop / subagent / both** — a three-way toggle mapping to `isSubagent`.

Default: all accounts, this month, both. Mixing accounts in one total is misleading — they are
different bills — so the account breakdown is always visible when more than one is selected.

### 5.2 Content

KPI tiles (total, requests, active days, $/request), then:

- **Daily/weekly stacked area by model.** `recharts` ^3.8.1, already a dependency.
- **Component split** — cache read / cache write / output / fresh input.
- **Caching ROI** — ratio, saved-vs-uncached, 1h premium.
- **Main loop vs subagent** — cost, requests, and $/request side by side.
- **By project**, and **project × model**.
- **Top sessions**, reusing `sessions()`.
- **Unpriced-models banner** when `unpriced()` is non-empty.

Model → colour is **fixed per model** via a lookup keyed on model id, never assigned by rank, so
the legend means the same thing across months. The palette matches the Anthropic console's so the
two read side by side. Chart work follows the `dataviz` skill.

### 5.3 Say it, don't just show it

The Python's value is the interpretation, and it has to survive the port. Each of these renders
as a sentence above its table, computed from the same query that fills the table:

- **Component split.** "87% of spend is context, 13% is generated output" reframes "we spend a
  lot on AI" as "we spend a lot on *re-sending context*" — a different and more fixable problem.
- **Subagent vs main loop.** August: $0.066/request vs $0.149 on the same model, 2.2× cheaper
  because they carry less context; 18.7% of requests for 9.4% of spend. This is the evidence for
  "delegate to a fresh context" and it is currently computed and thrown away.
- **Per-project mismatch.** Whether the biggest project matches where attention actually went. A
  repo burning money after its branch merged is the failure this catches.
- **Burstiness.** Name the two or three heaviest days. Aggregate months look alarming and are
  usually a couple of heavy sessions.

The Anthropic console remains the billing source of truth. The page must not present its dollars
as authoritative over it; a footnote says so.

---

## 6. Testing

TDD throughout, tests in `electron/__tests__/`, `createDatabase(':memory:')` for DB-backed work.

- **Failing first:** a fixture session with `subagents/workflows/wf_x/agent-y.jsonl` whose cost
  is currently dropped. Covers both `cost-history.ts` and `session-cost.ts`.
- Signature invalidation when a nested workflow file appears.
- Migration 22: rebuild preserves existing rows and totals; `is_subagent` in the PK lets a main
  and a subagent row coexist for one `(session, date, model)`.
- Component costs sum to `cost_usd` per row, to within float tolerance.
- Effective-dated pricing: the single-period table reproduces current prices exactly; a
  two-period model prices days either side of the boundary differently.
- `<synthetic>` no longer sets `is_estimated`; an invented model still does and appears in
  `unpriced()`.
- `whereClause()` array expansion, empty-array-means-all, and `projectSearch` escaping.
- `merge`-style idempotence: backfilling twice produces identical rows.

Verification gate (cross-cutting): `npm run check`, `npm run build`, `npm run test:coverage`.
Then `npm run rebuild:electron` before the app is restarted.

---

## 7. Build order

1. **Recursive subagent walk** + tests. Reconcile August/Work to $905.69 by direct query.
2. **Effective-dated pricing.** Rate-neutral; lands before the backfill so history is not
   re-priced twice.
3. **Migration 22 + ingest** — `is_subagent`, `request_count`, component costs.
4. **Service queries + IPC + api.ts.**
5. **The page**, titlebar button, tab wiring.

Steps 1–3 are verifiable against the database with no UI.

---

## 8. Out of scope, deliberately

- `brain/sources/session-transcripts.ts`, `sessions/subagent-meta.ts` and `tab-status.ts` glob
  `subagents/` with the same non-recursive pattern and probably have the same gap. Flagged, not
  fixed — each has different semantics for what counts as a subagent.
- Fixing the Python's first-wins dedup (§1.1b). A `claude-work` job.
- Sharing one rate source between OmniFex and `scripts/pricing.json` (§3).
- `PricingOverridesEditor` UI for effective dates. The parser accepts them; the editor does not
  yet write them.
- Console-total reconciliation input. The number it would compare against is the one §1.3
  establishes we do not yet trust; revisit once a month reconciles cleanly.

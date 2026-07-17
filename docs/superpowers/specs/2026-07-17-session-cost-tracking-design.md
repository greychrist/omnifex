# Session Cost Tracking — Design

**Date:** 2026-07-17
**Status:** Draft — awaiting Greg's review
**Motivation:** The work account is token-billed (Enterprise API), not subscription. OmniFex must show an accurate running cost per session in the account header widget, and keep a durable cost history that can be filtered and compared against Anthropic's console billing.

## Problem

Three cost calculations exist today; all are wrong for token-billed accounts:

1. **Header `CostWidget`** (`src/components/claude-code-session/CostWidget.tsx`, fed by `AccountCard.tsx`): shows the scraped `/usage` TUI's "session Total cost". The usage-runner spawns its *own* CLI session to scrape, so the figure is that session's cost — always ~$0.00, never the user's session.
2. **Per-message footer** (`src/lib/sessionStreamReducer.ts:284-294`): hardcodes Sonnet rates ($3/M in, $15/M out) regardless of model and prices cache tokens at $0. Cache-read tokens routinely dominate real cost (e.g. 190k cached tokens ≈ $0.095 at Opus rates vs the $0.078 shown for output).
3. **Usage dashboard** (`electron/services/usage.ts:166-171` `getCostPerToken`): Opus priced at $15/$75 (Opus 4.1-era; current Opus 4.6+ is $5/$25 — a 3× overestimate), Haiku at 3.5-era rates, cache tokens ignored. Additionally `extractUsageRows` sums every JSONL line: the CLI writes one line per content block sharing the same `message.id`/`requestId` with identical usage, so multi-block messages are double-counted.

The session JSONL transcripts carry everything needed for exact computation: per-assistant-message `message.model`, `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and the `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` write-TTL split.

## Decisions (settled with Greg 2026-07-17)

- **Data source:** compute from session JSONL transcripts (works in TUI and chat mode; exact; live).
- **Pricing table:** hardcoded current Anthropic rates + per-model user overrides in Settings. No runtime fetch.
- **Scope:** fix all three surfaces (header widget, per-message footer, usage dashboard) against one shared pricing module.
- **Subagents:** included — sum `subagents/agent-*.jsonl` alongside the main transcript.
- **Persistence:** durable per-session cost history in SQLite with a filterable "Costs" page (added in round 2).
- **Retention:** `cleanupPeriodDays: 365` set on the work account (done 2026-07-17) so raw transcripts outlive the default 30-day prune.

## 1. Shared pricing module

Pure, dependency-free module at `src/lib/pricing.ts`. Renderer imports it as `@/lib/pricing`; electron imports it by relative path (no Node/DOM APIs, so it type-checks under both `tsconfig.json` and `tsconfig.electron.json`). This is the repo's first electron→src import; if it fights the forge/vite build, fallback is relocating to a `shared/` dir with path mappings — decided during implementation, not a design change.

**Rate table** (USD per MTok, keyed by model-id substring, longest/most-specific match wins):

| Model family | Input | Output |
|---|---|---|
| `fable-5`, `mythos` | 10.00 | 50.00 |
| `opus-4-5` … `opus-4-8` | 5.00 | 25.00 |
| legacy `opus` (4.1, 4.0, 3) | 15.00 | 75.00 |
| `sonnet` (all) | 3.00 | 15.00 |
| `haiku-4-5` | 1.00 | 5.00 |
| legacy `haiku` (3.x) | 0.25 | 1.25 |

**Cache pricing:** read = 0.1× input rate; write = 1.25× input (5-minute TTL) or 2× input (1-hour TTL). Use the `cache_creation.ephemeral_5m/1h` split when present; assume 1.25× when only aggregate `cache_creation_input_tokens` exists.

**Unknown models:** fall back to Sonnet rates and set `estimated: true` in the result so UIs can prefix `~`.

**API:** `computeMessageCost(model, usage, overrides?) → { usd, estimated }` plus a `resolveRates(model, overrides?)` helper.

**User overrides:** per-model-pattern rate overrides `{ input, output, cacheRead, cacheWrite5m, cacheWrite1h }` stored in OmniFex settings, editable in Settings. Escape hatch for price drift and intro pricing (e.g. Sonnet 5's $2/$10 through 2026-08-31 — we ship standard rates, no date logic). Renderer fetches overrides via IPC once per session for the footer.

## 2. Session cost service (main process)

New `electron/services/sessions/session-cost.ts`, factory function with injected fs (same pattern as `subagent-meta.ts`, which already shows path resolution: `<configDir>/projects/<encodeProjectKey(projectPath)>/<sessionId>.jsonl` and `<sessionId>/subagents/agent-*.jsonl`).

- **Initial scan** on session start / tab mount: main JSONL + all subagent JSONLs → per-message costs → totals.
- **Dedup:** key each usage-bearing assistant line by `requestId` (fallback `message.id`); last occurrence wins. Lines without either key count individually.
- **Incremental:** reuse the `jsonl-tail.ts` offset-tailing pattern on the main file; watch `subagents/` for new agent files; recompute only affected files; debounce ~1s.
- **Push:** `session-cost:<sessionId>` renderer events (prefix added to preload event allow-list). **Pull:** `session_cost_get` invoke channel for mount/reconnect (handlers.ts → preload allow-list → api.ts, camelCase+snake_case params, strip undefined).
- **Payload:** `{ totalUsd, estimated, breakdown: { inputUsd, outputUsd, cacheReadUsd, cacheWriteUsd }, subagentUsd, byModel, tokens }`.
- **Persistence hook:** every recompute upserts the session's rows into `session_cost_daily` (Section 4). Dedup makes upserts idempotent.
- Lifecycle: watching starts on tab mount, stops on tab close. Rejected alternative: computing on the 30s `/usage` refresh cadence — not live, and the tailing infra already exists.

## 3. UI changes

- **`CostWidget`**: value = computed session cost (live). Tooltip gains in/out/cache-read/cache-write/subagent breakdown; `~` prefix when `estimated`. Click still opens `UsageDetailPopover`, which gains a "This session" computed-breakdown section above the existing scraped account-level `/usage` data (retained for account stats; no longer presented as session cost).
- **Per-message footer**: `sessionStreamReducer` calls `computeMessageCost` with the message's actual model and full usage including cache tokens.
- **Usage dashboard**: `usage.ts` replaces `getCostPerToken` with the shared module (cache tokens now priced) and adds the requestId dedup to `extractUsageRows`.

## 4. Persistent cost history

New table via the `database.ts` migration path:

```sql
CREATE TABLE session_cost_daily (
  session_id            TEXT NOT NULL,
  date                  TEXT NOT NULL,   -- UTC calendar date (console comparability)
  model                 TEXT NOT NULL,
  account_name          TEXT NOT NULL,
  config_dir            TEXT NOT NULL,
  project_path          TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL,
  is_estimated          INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (session_id, date, model)
);
```

- Granularity session × UTC day × model: supports every planned filter, stays small (thousands of rows per heavy month). Raw tokens stored so history is recomputable from the DB alone if pricing was wrong.
- **Backfill + sweep:** on first run and via a manual "rescan" action, walk all config dirs' surviving JSONLs (reusing the `usage.ts` scan walk) and upsert. A periodic sweep on the existing usage-refresh cadence catches sessions run outside OmniFex (e.g. `claude-work` in a terminal) — required for monthly reconciliation against Anthropic. Rows are never deleted when transcripts age out.
- Rescan doubles as the repair tool after a pricing/override correction; rows whose transcripts are gone keep last-computed values.

## 5. Costs page

New **"Costs" tab in the existing Usage dashboard**, reading only from `session_cost_daily`:

- Time-series bar chart (day/week/month grouping toggle) + totals table.
- Filters: date range, account, project, model. Default: current UTC calendar month, work account.
- Per-period drill-down to sessions with cost + token breakdown.
- IPC: `session_cost_history(filters)` doing SQL aggregation.
- ⓘ reconciliation note: Anthropic's console bills the org in UTC calendar months and includes usage OmniFex can't see (teammates, CI, other machines/tools, pre-feature sessions). Expect OmniFex ≤ console; the gap is itself informative.

## 6. Retention

`cleanupPeriodDays` is a Claude Code setting (per config dir `settings.json`); the CLI prunes transcripts at startup after that many days (default 30, min 1). Set to 365 on the work account 2026-07-17. Optional follow-up (not in this scope unless Greg asks): surface per-account retention in OmniFex Settings via the existing Claude-settings service, with a keep-≥365 nudge on cost-based accounts.

## 7. Error handling

- Missing/unreadable JSONL → widget shows the existing "no data" placeholder; service logs via LoggingService, no throw.
- Malformed lines skipped (existing `parseJsonlLine` behavior).
- DB upsert failure → log, keep live widget working (in-memory total is independent of persistence).
- Unknown model → Sonnet-rate estimate, flagged, never a crash.

## 8. Testing (TDD, `electron/__tests__/`, 80% line floor)

- **pricing:** each family's rates, cache multipliers, 5m/1h split + aggregate fallback, override precedence, unknown-model flag, substring-match specificity.
- **session-cost service:** injected in-memory fs — initial scan, requestId dedup, incremental append, subagent file appearing mid-session, missing files.
- **usage.ts:** corrected rates, cache pricing, dedup (lock in that multi-line messages count once).
- **DB:** migration, upsert idempotency, history-query aggregation with filters (in-memory sqlite via `createDatabase(':memory:')`).
- **Renderer:** sessionStreamReducer footer tests updated for model-aware + cache-aware cost.
- Verification gate (cross-cutting): `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron`.

## Out of scope

- Codex-engine cost (different pricing; engine wiring is partial).
- Live pricing fetch (LiteLLM-style) — revisit if overrides become tedious.
- Encoding intro/date-based pricing.
- Backfilling or migrating the Usage dashboard's existing live-scan aggregates (that tab keeps live scanning; only the Costs tab reads the DB).

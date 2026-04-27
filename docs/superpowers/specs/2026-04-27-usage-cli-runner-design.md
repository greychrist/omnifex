# `/usage` CLI Runner — Design

**Status:** Approved 2026-04-27
**Follow-on to:** `2026-04-27-rate-limit-tracking-design.md`

## Problem

The rate-limit widgets in `SessionHeader` (5h, 7d) currently rely on the Claude Agent SDK's `rate_limit_event` system messages, which the SDK only emits on threshold crossings — not on every turn. Live data is therefore sparse and often hours stale.

The existing manual-refresh path in `electron/services/rate-limits.ts` (`refresh()` shelling out to `claude -p "/status" --output-format json`) is silently broken: `/status` is gated on having a real TTY and returns `"/status isn't available in this environment."` in non-interactive mode. The button it powers parses zero events and returns `null`.

A spike confirmed the SDK's streaming-input mode (`AsyncIterable<SDKUserMessage>` to `query()`) suffers the same TUI gating: sending `/usage` returns the synthetic *"You are currently using your subscription to power your Claude Code usage"* short-circuit, with zero `local_command_output` messages.

The rich `/usage` view (5h/week-all-models/week-Sonnet bars, reset times, contributing-factors breakdown) is only rendered when the CLI detects a real TTY.

## Goal

Provide on-demand and periodic refresh of the rate-limit widgets in `SessionHeader` using the rich `/usage` data, and surface the full `/usage` detail in a popover when a widget is clicked.

## Non-goals

- Multi-account aggregate view in `UsageDashboard` (separate future change).
- User-configurable refresh cadence (YAGNI).
- Capturing `/usage` history over time (current snapshot only).
- Displaying CLI usage data for accounts that have no active session.

## Approach

Spawn `claude` in a real pseudo-terminal via `node-pty`, send `/usage`, capture rendered output, strip ANSI, parse into a structured shape. Feed the per-window utilization back into the existing `rate-limits` snapshot store, and cache the full parsed result for the popover.

### Why PTY scraping

Three alternatives were ruled out by the spike:
1. **SDK streaming-input** — same TUI gating; returns the synthetic subscription string.
2. **`claude -p "/usage"` / `claude -p "/status"`** — same TUI gating.
3. **Reverse-engineering the underlying API endpoint** — invasive, unofficial header surface, requires intercepting HTTPS in the SDK.

PTY is the only path that produces the rendered output. It is brittle to TUI layout changes; we mitigate with fixture-driven parser tests and a captured CLI version stamp.

## Architecture

```
[periodic timer | refresh button | session mount | popover refresh]
                        │
                        ▼
                 runUsageCli(account)
              spawn pty → wait quiet → send /usage
              wait quiet → /quit → kill → strip ANSI → parse
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
     rate-limits.recordUtilization   in-mem cache (per account)
     (updates 5h / 7d / 7d-Sonnet     full UsageData payload
      utilization + resets_at,        used by UsageDetailPopover
      preserving SDK status)
```

A single write path keeps the existing `RateLimitWidget` wiring untouched: those widgets read from `rate-limits` snapshots exactly as they do today.

## Service — `electron/services/usage-runner.ts`

```ts
export interface UsageRunnerService {
  run(accountName: string): Promise<UsageRunResult>;
  getLast(accountName: string): UsageRunResult | null;
}

export type UsageRunResult =
  | { ok: true; observed_at: number; cli_version: string | null;
      raw: string; parsed: UsageData }
  | { ok: false; observed_at: number; error: string; raw?: string };

export interface UsageRunnerDeps {
  accounts: AccountsService;
  rateLimits: RateLimitsService;
  spawnPty?: PtySpawner;          // injected; defaults to node-pty
  findClaudeBinary?: () => string | null;
  now?: () => number;
  logging?: LoggingService | null;
}
```

### Run sequence

1. Resolve `account` from `accounts`. If unknown → `{ ok: false }`.
2. Resolve binary: prefer `account.cli_path` (per-account override) when set; otherwise `findClaudeBinary()` on PATH. If neither resolves → `{ ok: false }`.
3. Per-account in-flight dedup: if a run is already underway for this account, return its promise.
4. Spawn the resolved binary via `node-pty` with:
   - `cols: 200`, `rows: 60` (wide enough that `/usage` doesn't wrap or get truncated)
   - `cwd: os.homedir()` (no project context, no hooks, no plugin load)
   - `env: { ...process.env, CLAUDE_CONFIG_DIR: account.config_dir }`
5. Buffer stdout. Wait for the TUI to settle: 750 ms with no new bytes.
6. Write `/usage\r`. Buffer stdout until next 1500 ms quiet window, or hard 20 s timeout.
7. Write `/quit\r`; kill PTY after 500 ms grace.
8. Strip ANSI from buffered output. Pass to `parseUsageOutput`. Stamp `observed_at`, capture `cli_version` from the cached `claude --version` value.
9. Write each window into `rateLimits.recordUtilization(...)` (see below). Cache the full `UsageRunResult`.

### Concurrency

- One in-flight promise per account name; concurrent callers receive the same promise.
- Cache is overwritten by each successful run. Failed runs do not overwrite a prior successful cache entry; they are still returned to the caller.

## Parser — `electron/services/usage-runner/parser.ts`

Pure function. ANSI-stripped input → structured output.

```ts
export type UsageData = {
  session: {
    cost_usd: number;
    api_duration_s: number;
    wall_duration_s: number;
    code_added: number;
    code_removed: number;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_write: number;
  };
  windows: Array<{
    label: 'current_session' | 'week_all_models' | 'week_sonnet';
    pct_used: number;
    resets_at_label: string;   // raw, e.g. "9:40am (America/New_York)"
    resets_at_epoch: number | null;  // best-effort parse to UTC seconds
  }>;
  contributing: Array<{ headline: string; detail: string }>;
};
```

### Parser strategy

- Section-anchored: split on the known headers (`Session`, `Current session`, `Current week (all models)`, `Current week (Sonnet only)`, `What's contributing to your limits usage?`).
- Within each section, regex extract numeric fields and the `% used` value.
- `resets_at_epoch` is best-effort: parse `"9:40am (America/New_York)"` against the user's local clock to a UTC second. If parsing fails, leave `null` and let the UI fall back to the raw label.
- Unknown sections are ignored, not errored.
- Missing-but-expected sections (e.g. only one weekly bar present for a fresh account) yield a partial `UsageData` with the absent windows omitted from `windows[]`.

### Failure modes the parser must tolerate

- TUI prompt characters bleeding into the buffer (cursor jumps, repaint frames).
- Partial output if the quiet-window timeout fires mid-render.
- Plan types other than Max (Pro shows different sections; we degrade gracefully).
- `What's contributing` absent on accounts with no recent local sessions.

If the parser cannot extract *any* `windows[]` entries, the run is treated as a parse failure: the runner returns `{ ok: false, error: 'parse_failed', raw }`. Partial successes (≥1 window) are returned as `{ ok: true }`.

## Rate-limits service — additive change

Add a new method to `RateLimitsService` that updates utilization without clobbering SDK-derived `status`:

```ts
recordUtilization(
  configDir: string,
  rateLimitType: RateLimitType,
  utilization: number,
  resetsAt: number | null,
): void;
```

Behavior:
- If a snapshot already exists for `(account, rate_limit_type)`, update `utilization`, `resets_at`, and `observed_at`. Leave `status` as-is.
- If no prior snapshot exists, create one with `status: 'allowed'` (PTY data has no rejection signal; SDK events will overwrite once they fire).

Side fix in the same change:
- Delete `refresh()` and `parseStatusOutput()` from `rate-limits.ts`.
- Remove the `rate_limits_refresh` IPC handler and preload entry.
- Reroute the existing 7-day refresh button to `usage_run_cli`.

## IPC

New channels (added to `electron/ipc/handlers.ts` and the preload allow-list):

- `usage_run_cli` — `{ accountName: string }` → `UsageRunResult`. Triggers a PTY run; returns when complete.
- `usage_get_last` — `{ accountName: string }` → `UsageRunResult | null`. Cache read for the popover; cheap.

`src/lib/api.ts` exposes:

```ts
runUsageCli(accountName: string): Promise<UsageRunResult>;
getLastUsageCli(accountName: string): Promise<UsageRunResult | null>;
```

## Renderer

### Auto-refresh hook — `src/hooks/useUsageAutoRefresh.ts`

```ts
useUsageAutoRefresh(accountName: string | null): {
  data: UsageRunResult | null;
  loading: boolean;
  refresh: () => Promise<void>;
};
```

- On mount, reads `getLastUsageCli`. If absent or older than 5 min → fires `runUsageCli` immediately.
- Sets a 5-minute interval that fires `runUsageCli` while `document.visibilityState === 'visible'` and the tab is active.
- Pauses on `visibilitychange` to hidden; resumes on visible (and fires immediately if interval would have elapsed during the hidden period).
- Manual `refresh()` resets the interval clock.
- Multiple subscribers (multiple session tabs for the same account) each subscribe independently; the service-level dedup ensures only one PTY run executes.

### `SessionHeader` integration

- `SessionHeader` calls `useUsageAutoRefresh(activeAccountName)`.
- Passes utilization + reset data to the existing `RateLimitWidget` instances via the existing snapshot props (no widget API changes; data arrives through the rate-limits snapshot path).
- Existing 7-day refresh button → `refresh()` from the hook.
- Click handlers on either widget open `UsageDetailPopover`, anchored to the clicked widget.

### `UsageDetailPopover.tsx` (new)

Built on Radix Popover (already in the shadcn/ui stack).

Layout — top to bottom, scaled to the screenshot:
1. **Session** — cost, API/wall durations, code lines, tokens (input/output/cache split).
2. **Three windows** — labelled rows with bar + `% used` + reset label. Sonnet-only window is shown here even though it has no header widget.
3. **What's contributing** — list of `{ headline, detail }`.
4. **Footer** — "observed Xm ago • Refresh" — the Refresh button calls the hook's `refresh()` and shows an inline spinner; the popover stays open and swaps data on completion.

Failure / partial states:
- `ok: false` → red banner with `error` and a `<details>` containing `raw` when present.
- `ok: true` with missing sections → omit those sections silently (e.g. fresh account without contributing data).

## Per-account CLI path

To support setups where different accounts use different Claude installations (stable vs beta builds, wrapper scripts, etc.), the `accounts` table gains an optional override.

### Schema migration

Append to the existing `database.ts` migration block (same pattern as the `color` and `icon` ALTERs already there):

```sql
ALTER TABLE accounts ADD COLUMN cli_path TEXT;
```

### Type changes

```ts
export interface Account {
  // ...existing fields
  cli_path: string | null;
}
```

`createAccount` and `updateAccount` gain an optional `cliPath?: string | null` parameter at the end of their argument lists. When `null` (the default for existing rows after migration), the runner falls back to `findClaudeBinary()` on PATH — this keeps current behavior unchanged for everyone.

### UI

`AccountSettings.tsx` adds an optional **CLI path** field per account:
- Text input + a "Browse..." button that opens an Electron file picker (`dialog.showOpenDialog` with `properties: ['openFile']`).
- Help text: *"Defaults to `claude` on PATH. Override only for a specific binary or wrapper. Shell aliases (`claude-personal`, `claude-work`) are resolved by your interactive shell and won't work here — paste the resolved path instead, e.g. `~/.local/bin/claude`."*
- Validation: if non-empty, must point to an existing executable file (checked at save time via a new IPC `accounts_validate_cli_path`). Empty / null is always valid.

### IPC

- New: `accounts_validate_cli_path` — `{ path: string }` → `{ ok: true } | { ok: false; error: string }`.
- Existing `account_create` / `account_update` handlers gain the optional field; preload allow-list unchanged.

## Native module — `node-pty`

`node-pty` is a native module and joins the existing `better-sqlite3` ABI-rebuild dance.

- Add to `dependencies` in `package.json`.
- Verify `npm run rebuild:electron` rebuilds it for Electron's Node ABI; if the script targets only `better-sqlite3`, generalize it.
- The pretest hook that rebuilds for Node-vitest must include `node-pty` too.

## Testing

Per `CLAUDE.md`, TDD with the failing test first.

### Parser fixtures (`electron/__tests__/fixtures/usage-output/`)

At least five real captures:
1. `max-full.txt` — Max plan with all three windows + contributing.
2. `pro.txt` — Pro plan layout.
3. `fresh-account.txt` — no contributing section yet.
4. `partial-render.txt` — buffer cut mid-render at the 1500 ms quiet timeout.
5. `error-banner.txt` — CLI error overlay (e.g. expired auth) before any usage data.

Each fixture has a peer `.expected.json` containing the canonical `UsageData` (or `{ ok: false }` for #5). Tests live in `electron/__tests__/usage-runner-parser.test.ts`.

### Runner tests (`electron/__tests__/usage-runner.test.ts`)

`spawnPty` is dependency-injected. Tests script the byte stream:
- happy path → asserts `recordUtilization` called for each window with the expected args
- timeout → asserts kill + `{ ok: false, error: 'timeout' }`
- missing binary → asserts early return without spawning
- concurrent calls → asserts a single underlying spawn
- prior cached success preserved on a later failure

### IPC handler test

Round-trip through `registerIpcHandlers` with a mocked service.

### Live-CLI integration test

Out of scope for the unit suite (requires a logged-in account). Manual verification against `claude-personal` and `claude-work` is part of the implementation task list.

## Verification gate (`/verify` per CLAUDE.md)

Cross-cutting change: `npm run check`, `npm run build`, `npm run test:coverage` (target ≥ 80% lines on backend code).

## Open considerations

- **CLI version drift.** Stamp every `UsageRunResult` with `cli_version` (from `claude --version`). When the parser fails on a newer CLI, the error message names the version so we know which fixture to capture.
- **Refresh cadence (5 min).** Defensible default. If real usage shows the PTY spawn cost is too high, a per-tab "is the user actively typing?" gate could be added later.
- **Concurrent multiple accounts.** Each tab refreshes only its own account. The service dedups per-account, not globally — two tabs on different accounts spawn two PTYs concurrently, which is fine.

## Files touched

**New**
- `electron/services/usage-runner.ts`
- `electron/services/usage-runner/parser.ts`
- `electron/__tests__/usage-runner.test.ts`
- `electron/__tests__/usage-runner-parser.test.ts`
- `electron/__tests__/fixtures/usage-output/*`
- `src/hooks/useUsageAutoRefresh.ts`
- `src/components/claude-code-session/UsageDetailPopover.tsx`

**Modified**
- `electron/services/rate-limits.ts` — add `recordUtilization`; delete `refresh` + `parseStatusOutput`
- `electron/services/accounts.ts` — add `cli_path` to `Account`, `AccountRow`, `createAccount`, `updateAccount`
- `electron/services/database.ts` — `ALTER TABLE accounts ADD COLUMN cli_path TEXT` migration
- `electron/main.ts` — construct usage-runner service, wire deps
- `electron/ipc/handlers.ts` — register `usage_run_cli`, `usage_get_last`, `accounts_validate_cli_path`; remove `rate_limits_refresh`
- `electron/preload.ts` — allow-list updates
- `src/lib/api.ts` — typed wrappers (incl. `cliPath` field on account types)
- `src/components/AccountSettings.tsx` — CLI path input + browse + validation
- `src/components/SessionHeader.tsx` — wire hook + popover triggers
- `src/components/claude-code-session/RateLimitWidget.tsx` — accept onClick that opens popover (no data shape changes)
- `package.json` — add `node-pty`

**Removed**
- `rate_limits_refresh` IPC channel + handler + preload entry + any UI calls into it

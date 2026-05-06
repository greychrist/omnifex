# Session Summaries — Design

**Date:** 2026-05-05
**Status:** Approved (brainstorming session 2026-05-05)

## Problem

The OmniFex project tab shows a row per Claude Code session, but the only content preview is the truncated first user message. This is useless for "what did I do last week" — the first message is rarely a description of the work that followed. Greg wants a real, AI-generated summary of each session visible on the project tab.

## Goal

Generate a short, structured summary (one-line headline + 2–3 sentence paragraph) for each session, visible inline in `SessionList.tsx`. Generation is automatic on tab close, manually triggerable per row, gated by a per-account opt-in, and skipped when nothing has changed since the last summary.

## Non-goals

- Bulk backfill of historical sessions (no auto-summarize-everything button).
- Cross-account aggregate summaries.
- Overhauling the existing usage-tracker pricing (which still has Haiku 3 rates baked in — separate cleanup).
- Force-compacting sessions to harvest the SDK's compaction summary (more expensive than just running our own Haiku call; rejected during design).

## UX

### Trigger model

- **Automatic on tab close.** Fires when the user closes a chat tab. Account-toggle gated. Fire-and-forget — close completes immediately; the summary lands when the API call returns. Re-runs every close, so resumed sessions get re-summarized to pick up the new content.
- **Manual `↻` button per session row.** One click = one regen. Same account-toggle gate. Always overwrites any existing summary.
- **No bulk backfill.** Older sessions stay summary-less until the user clicks `↻`.

### Account-level controls

A new card in `AccountSettings.tsx` per account:

- **Toggle:** *"Generate summaries when sessions close"*
- **Model dropdown:** *"Summary model"* — populated from that account's `query.supportedModels()` result (only models actually available to the account: plan tier, Bedrock/Vertex restrictions, etc., handled for free).
- **Cost estimate line** under the dropdown, model-dependent:
  - Haiku: `~$0.005–$0.05 / session`
  - Sonnet: `~$0.015–$0.15 / session`
  - Opus: `~$0.075–$0.75 / session`
- Help line: *"Costs come out of this account's plan allotment for Pro/Max, billed per token for API keys."*

**Default values at account-add time** (computed from the SDK's `AccountInfo`):

- `subscriptionType ∈ {pro, max, pro_max}` AND `apiProvider === 'firstParty'` → toggle defaults **ON**, model defaults to the cheapest Haiku in `supportedModels()`.
- Anything else (`enterprise`, `team`, Bedrock, Vertex, console_user, missing fields) → toggle defaults **OFF**.
- Toggle on but no Haiku available in `supportedModels()` → toggle defaults **OFF**, dropdown shows hint *"No Haiku available — pick a model to enable"*. The toggle is **disabled** in the UI whenever `summaryModel == null`, regardless of plan; the user must choose a model before they can enable summarization.

"Cheapest Haiku" means: prefer the highest version number available (Haiku 4.5 → Haiku 3.5 → Haiku 3) since the price-per-token gap between Haiku versions is small and quality scales meaningfully. The default is fixed at account-add time and not auto-upgraded later — if Haiku 5 ships, the user can manually switch via the dropdown.

Persisted to the SQLite `accounts` table; survives restart and respects existing multi-account isolation.

### Row layout in `SessionList.tsx`

- Existing date columns + session-ID column unchanged.
- **Body row:**
  - With summary → `headline` (bold, single line) + chevron that expands to the paragraph.
  - Without summary → existing `first_message` truncation (current behavior is the fallback).
- **`↻` button** on each row:
  - **Hidden** when the session's resolved account has `summarizeOnClose: false`.
  - **Disabled** when `currentJsonlSize === cached.jsonlSize` (no new content). Tooltip: *"No new messages since last summary."*
  - **Enabled** when sizes differ or no summary exists.
  - Click → spinner during the `summary_generate` IPC call → row updates on resolve.

## Data model

### Sidecar JSON

One file per session, next to its JSONL:

```
~/.claude/projects/<encoded-project-id>/<session-uuid>.jsonl
~/.claude/projects/<encoded-project-id>/<session-uuid>.summary.json   ← new
```

**Why sidecar over SQLite:**

- The summary is *of* a specific JSONL. Moves and deletes with it; no orphan rows in `greychrist.db`.
- Multi-account already routes JSONL reads through the resolved account's `CLAUDE_CONFIG_DIR`. Sidecar inherits that for free.
- Survives reinstalling OmniFex with no migration code.
- Doesn't pollute the JSONL itself; other tools that read `~/.claude/projects/` are unaffected.

### Schema

```json
{
  "version": 1,
  "headline": "Migrated SessionList to a paginated table and added a refresh affordance.",
  "paragraph": "Started by virtualizing the list, then pivoted to pagination after measuring scroll perf. Pulled the optimized variant into a deletion candidate. Left first_message preview as the fallback when no summary exists.",
  "messageCount": 73,
  "jsonlSize": 184302,
  "generatedAt": "2026-05-05T16:42:11.038Z",
  "model": "claude-haiku-4-5",
  "accountName": "Greg Personal",
  "truncated": false
}
```

Field semantics:

- `version` — schema version. Mismatch on read → treat as no summary.
- `headline` / `paragraph` — extracted from the model's XML response.
- `messageCount` — count of user + assistant text turns at generation time. Shown in tooltips: *"73 messages summarized"*.
- `jsonlSize` — bytes from `fs.stat()`. Cheap-path change signal. Compared against the live JSONL's size to decide whether to skip regeneration.
- `generatedAt` — ISO timestamp. Diagnostic.
- `model` — the model ID actually used for this generation. Records which model produced the cached output.
- `accountName` — the user-defined account label from the `accounts` table (not the SDK email). Diagnostic.
- `truncated` — `true` only when the input transcript exceeded the safety cap and the middle was elided. Omitted when `false`.

### File ops

- **Read:** `try { JSON.parse(fs.readFileSync(...)) } catch { return null; }` — corrupt or missing sidecar = no summary = render fallback.
- **Write:** `fs.writeFileSync(tmpPath, ...); fs.renameSync(tmpPath, finalPath)` — atomic so a crash mid-write can't leave a half-written file.

### Accounts table migration

Two new columns:

```sql
ALTER TABLE accounts ADD COLUMN summarizeOnClose INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN summaryModel TEXT;
```

Migration follows the existing pattern in `electron/services/database.ts`. Default `0` is safe for existing rows (opt-in only); the renderer's account-add flow is what flips it to `1` for personal-subscription accounts.

## Generation pipeline

### Service interface

A new module: `electron/services/sessions-summary.ts`. One factory function returning:

```ts
interface SessionsSummaryService {
  /** Read the cached sidecar for a session. Null when missing or unreadable. */
  getSummary(sessionUuid: string, projectPath: string): SessionSummary | null;

  /**
   * Generate (or regenerate) a summary for a session. Resolves the account,
   * checks the toggle, checks the size-change gate, calls the SDK, parses
   * the response, writes the sidecar atomically, and returns the result.
   * Returns null when skipped (toggle off, size unchanged) or when generation
   * failed for a recoverable reason (auth expired, bad XML).
   */
  generateSummary(sessionUuid: string, projectPath: string): Promise<SessionSummary | null>;
}
```

Constructed in `electron/main.ts` and passed into `registerIpcHandlers`. Dependencies (accounts service, sessions filesystem path resolver, SDK `query` factory) injected for tests.

### Steps inside `generateSummary`

1. **Resolve the session's account.** Same resolution order used at session-launch time: explicit project override → longest-matching path rule → `null`. Bail with `null` if no account resolves.
2. **Load account toggle and model.** Bail if `summarizeOnClose === false` or `summaryModel == null`.
3. **Size gate.** Read `fs.stat(jsonlPath).size`. Read existing sidecar (if any). If `currentSize === cached.jsonlSize`, return `null` without calling the model.
4. **Extract transcript** from the JSONL (see below).
5. **Truncation safety net.** If the transcript exceeds 720K characters (~180K tokens at the conventional 4-chars-per-token heuristic), keep first 240K characters + `\n\n[… ~N tokens elided …]\n\n` + last 240K characters. Mark `truncated: true`. Precise tokenization is overkill for a safety net that fires on <1% of sessions.
6. **Call SDK `query()`** with the parameters described below. Await the first assistant text block. Tear down.
7. **Parse XML response.** If `<headline>` or `<paragraph>` is missing, return `null` and leave the existing sidecar untouched.
8. **Write sidecar atomically.** Emit `session-summary:updated` event.
9. **Return the result.**

### Transcript extraction

Walk the JSONL, keep:

- `type === 'user'` messages, **dropping** entries with `isMeta: true` and entries whose text starts with `<command-name>` or `<command-stdout>` (matches the existing filter in `extractSessionMetadata` in `electron/services/claude.ts`).
- `type === 'assistant'` messages — **only** the `text` content blocks. Drop `tool_use` blocks. Drop `tool_result` blocks (those live on `user`-type entries anyway).

Format as:

```
USER: <content>
ASSISTANT: <content>
USER: <content>
...
```

`messageCount` in the sidecar is the count of lines emitted into this transcript (not the JSONL line count, which includes tool noise).

### Prompt shape

Single user-message turn. XML-tagged output for forgiving extraction:

```
You are summarizing a coding-assistant session for a developer's records.
Produce a one-line headline (8–14 words) and a 2–3 sentence paragraph (~50 words).
The headline answers "what was this about?" The paragraph answers "what did I
do, what worked, what's still open?" Be concrete — name files, libraries,
decisions. No filler. No hedging.

Format your response EXACTLY:
<headline>...</headline>
<paragraph>...</paragraph>

<transcript>
USER: ...
ASSISTANT: ...
...
</transcript>
```

Extracted via regex: `<headline>([\s\S]*?)<\/headline>` and `<paragraph>([\s\S]*?)<\/paragraph>`. Trim whitespace. Both required; if either is missing, the call counts as a failure (existing sidecar untouched).

### SDK call configuration

```ts
const result = query({
  prompt: <transcript prompt above>,
  options: {
    cwd: projectPath,
    model: account.summaryModel,
    env: { CLAUDE_CONFIG_DIR: account.configDir },
    permissionMode: 'bypassPermissions',
    disallowedTools: ['*'],
  },
});
```

- `env.CLAUDE_CONFIG_DIR` ensures the call bills against the resolved account's plan allotment, matching how live sessions are routed.
- `permissionMode: 'bypassPermissions'` and `disallowedTools: ['*']` together guarantee no tool use can leak in — pure text in / text out.

### Async + concurrency

- **On tab close:** `electron/services/sessions/lifecycle.ts` already has the close path. Add a single `sessions-summary.generateSummary(uuid, projectPath).catch(logSilently)` call there. Tab close is not awaited on the result.
- **Manual button:** synchronous IPC (`summary_generate`). Returns the sidecar contents. Renderer shows a spinner.
- **Renderer refresh:** new event channel `session-summary:updated` carrying `{ sessionUuid }`. `SessionList.tsx` subscribes and refetches the matching row.
- **Concurrency dedup:** a per-`sessionUuid` `Map<string, Promise<SessionSummary | null>>` inside the service. Second call for the same UUID returns the in-flight promise.
- **App-quit while sessions still running:** explicitly **not** handled. Close-during-quit may not generate a summary; user can click `↻` next time.

### Failure modes

| Failure | Behavior |
|---|---|
| No account resolves for the session | Return `null`. Log to dev log. Existing sidecar untouched. |
| Account auth missing / OAuth token expired | Return `null`. Surface error message to renderer for toast on manual button. Existing sidecar untouched. |
| Network error / API rate limit | Same as above. Toast shows the API error message. |
| Model returns malformed XML (missing tag) | Return `null`. Log raw response. Existing sidecar untouched. |
| Sidecar JSON corrupt on read | Treat as no summary. Falls through to `first_message`. Next regen rewrites. |
| Schema version mismatch on read | Same as corrupt: treat as no summary. |
| Session JSONL deleted between kick-off and read | Bail with logged warning. No sidecar write. |
| Two parallel `generateSummary(uuid)` calls | In-flight map dedups; one model call, both promises resolve to the same result. |

## IPC surface

New channels (all account-aware in their downstream effects):

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `summary_get` | renderer → main | `{ sessionUuid, projectPath }` | `SessionSummary \| null` |
| `summary_generate` | renderer → main | `{ sessionUuid, projectPath }` | `SessionSummary \| null` (null on skip or recoverable failure; throws on hard error) |
| `session-summary:updated` | main → renderer (event) | `{ sessionUuid }` | — |

All three added to the preload allow-list (`electron/preload.ts`). The event channel matches the existing `session-summary:` prefix pattern (verify the prefix allow-list covers it).

Renderer wrappers in `src/lib/api.ts`:

```ts
summaryGet(sessionUuid: string, projectPath: string): Promise<SessionSummary | null>
summaryGenerate(sessionUuid: string, projectPath: string): Promise<SessionSummary | null>
```

Strip `undefined` optional params before crossing IPC (per repo rule).

## Testing strategy

TDD throughout. Tests live in `electron/__tests__/` (backend) and `src/components/__tests__/` + `src/lib/__tests__/` (renderer). Target ≥ 80% line coverage on touched modules.

### Backend — `electron/__tests__/sessions-summary.test.ts` (new)

Use real `tmp` dirs and sidecar files (same pattern as `slash-commands.test.ts`); mock the SDK `query()` with a `vi.fn` returning canned assistant responses.

| Concern | Test |
|---|---|
| Transcript extraction | Walks fixture JSONL with mixed user/assistant/tool/meta entries → returns text-only transcript in expected shape; drops `tool_use`, `tool_result`, `isMeta`, `<command-name>` user messages |
| Truncation | 200K-token transcript → first-60K + elision marker + last-60K, `truncated: true` |
| Truncation | <180K transcript → no truncation, no marker |
| XML parsing | Well-formed → both fields populated |
| XML parsing | Prose before/after tags → still extracted |
| XML parsing | Missing `<headline>` → returns null, no sidecar write |
| XML parsing | Missing `<paragraph>` → returns null, no sidecar write |
| Size gate | `jsonlSize === cached.jsonlSize` → returns null without invoking `query` mock |
| Size gate | First-time (no sidecar) → invokes `query` |
| Size gate | Sizes differ → invokes `query` |
| Toggle gate | Account `summarizeOnClose: false` → returns null, no `query` call |
| Toggle gate | Toggle on but `summaryModel` null → returns null with logged warning |
| Account routing | `query` called with `env.CLAUDE_CONFIG_DIR` matching resolved account |
| Account routing | Resolution order matches `accounts.resolve()`: explicit > longest match > null |
| Sidecar I/O | Atomic write: simulated rename failure → no partial sidecar visible |
| Sidecar I/O | Corrupt JSON read → returns null |
| Sidecar I/O | Schema version mismatch → returns null |
| Concurrency dedup | Two parallel `generateSummary(uuid)` → one `query` invocation, both promises resolve to same result |
| Concurrency dedup | Manual click while auto-on-close in flight → second call returns in-flight promise |
| Failure paths | `query` throws (auth) → returns null, error propagated for toast |
| Failure paths | `query` throws (rate limit) → same |
| Failure paths | JSONL deleted mid-call → bails with logged warning, no sidecar write |

### Renderer — `src/components/__tests__/SessionList.test.tsx` (new)

Mock `api.getProjectSessions` and `api.summaryGet`. Cover:

| Concern | Test |
|---|---|
| Display | Row with summary → headline visible, paragraph hidden until chevron clicked |
| Display | Row without summary → falls back to existing `first_message` truncation |
| Display | Chevron toggles paragraph visibility |
| Refresh button state | Sizes equal → button disabled, tooltip "No new messages since last summary" |
| Refresh button state | Sizes differ → button enabled |
| Refresh button state | No sidecar at all → button enabled |
| Account-toggle visibility | Account `summarizeOnClose: false` → button absent |
| Account-toggle visibility | Account `summarizeOnClose: true` → button present |
| Click → IPC | Click triggers `api.summaryGenerate`, spinner during await, row updates on resolve |
| Event subscription | `session-summary:updated` for matching uuid → row re-fetches |
| Event subscription | Event for different uuid → no refetch on this row |

### Renderer — `src/components/__tests__/AccountSettings.test.tsx` (extend existing)

| Concern | Test |
|---|---|
| Toggle persistence | Toggle change → calls `api.accountUpdate` with `summarizeOnClose: <new value>` |
| Model dropdown | Populated from account's `supportedModels()` cache |
| Model dropdown | Disabled when toggle off |
| Default selection | Cheapest Haiku in `supportedModels()` selected at account-add |
| Default selection | No Haiku available → toggle defaults off, dropdown shows hint |
| Cost estimate | Haiku → `$0.005–$0.05/session`; Sonnet → `$0.015–$0.15/session`; Opus → `$0.075–$0.75/session` |

### IPC plumbing — extend `electron/__tests__/handlers.test.ts`

| Concern | Test |
|---|---|
| `summary_generate` invokes service with right args |
| `summary_get` returns sidecar contents or null |
| `session-summary:updated` event fires after a successful write |
| All three channels in preload allow-list (existing pattern) |

### What we deliberately do not test

- Actual Anthropic API calls — always mocked.
- Real sidecar files in user `~/.claude` — always tmp dirs.
- Tab-close orchestration timing under load — covered indirectly by concurrency-dedup tests.

## Build sequence

Five slices, each independently shippable behind tests. Each slice ends green on the verification gate (`npm run check && npm run build && npm test`). One commit per slice (or a small commit train within a slice). Title prefix: `feat(sessions-summary): slice N — <name>`.

### Slice 1 — Backend service skeleton, no UI yet

- New `electron/services/sessions-summary.ts` with `getSummary` + `generateSummary` interfaces. `generateSummary` is a stub that returns `null`.
- Sidecar I/O: read, atomic write, schema versioning. Full TDD coverage.
- Transcript extractor: pure function on JSONL. Full TDD coverage.
- XML parser: pure function. Full TDD coverage.
- Truncation safety net: pure function. Full TDD coverage.
- IPC handlers (`summary_get`, `summary_generate`) registered as no-ops returning `null`. Preload allow-list updated.

Ships: a backend that can read and write sidecars but never generates them. UI unaffected.

### Slice 2 — SDK wiring, manual button only

- `generateSummary` actually calls `query()` with the right `CLAUDE_CONFIG_DIR`, model, transcript, `bypassPermissions`. Mock-based tests for routing, dedup, failure paths.
- Renderer: add `↻` button to each row in `SessionList.tsx`, calls `api.summaryGenerate(uuid)`, spinner during await, updates on resolve.
- Account toggle reads from the existing accounts table — for now, hardcode `summarizeOnClose: true` for all accounts so the button works during dev. Slice 4 wires the real column.
- Headline + paragraph rendering in `SessionList.tsx` — replaces `first_message` when sidecar exists.

Ships: working manual summary button. No auto-on-close yet, no per-account control yet.

### Slice 3 — Auto-on-close + size-change gate + concurrency dedup

- Hook into the close path in `electron/services/sessions/lifecycle.ts`. Fire-and-forget `generateSummary` call.
- Size-change gate via `fs.stat()`. Manual button reads `jsonlSize`, disables itself when unchanged.
- In-flight `Map<sessionUuid, Promise>` for dedup.
- New event channel `session-summary:updated`. Add to preload prefix allow-list. `SessionList.tsx` subscribes.

Ships: auto-summarization on close, change-aware refresh, no double-billing on concurrent triggers.

### Slice 4 — Per-account settings (toggle + model picker)

- Schema migration: add `summarizeOnClose INTEGER NOT NULL DEFAULT 0` and `summaryModel TEXT` columns. Migration follows the existing pattern in `electron/services/database.ts`.
- `AccountsService.update` accepts the new fields.
- `AccountSettings.tsx`: toggle + model dropdown + cost line. Default-value logic at account-add (cheapest Haiku from `supportedModels()`; toggle off if none).
- `sessions-summary.generateSummary` now reads the account's toggle and model — bails when off.
- Manual button hidden in `SessionList.tsx` rows belonging to toggle-off accounts.

Ships: feature is fully under user control. Default-on for personal-subscription accounts, default-off for everything else.

### Slice 5 — Polish

- Error toasts for the manual button (auth expired, network, rate limit).
- Help text in the account settings panel: tooltip explaining the cost model.
- `CHANGELOG.md` entry for the upcoming release.

Ships: production polish.

## Out of scope

- Bulk backfill of historical sessions.
- Multi-account aggregate summaries.
- Updating the usage-tracker pricing (still on Haiku 3 rates — separate cleanup).
- Force-compacting sessions to harvest the SDK's compaction summary (rejected during design as more expensive than running our own Haiku call).
- App-quit graceful summarization for in-flight sessions (explicit non-goal).

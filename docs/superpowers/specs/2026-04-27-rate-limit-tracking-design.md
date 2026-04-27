# Rate-Limit Tracking & Header Reorg — Design

Date: 2026-04-27
Status: Draft (awaiting user review)

## Problem

GreyChrist has no visibility into Anthropic's rate-limit windows. The user recently exhausted their 5-hour window in a few hours of heavy use without warning. Today's only signals are:

- The Claude CLI's own `/status` output — useful, but only when the user thinks to check it.
- Aggregated historical usage in `UsageDashboard` — backward-looking, not predictive.

There is currently no surface in GreyChrist that answers *"how close am I to my limit right now?"* and no notification when the answer becomes "very close."

## Goals

1. Always-visible indicator of the current account's 5-hour and 7-day window utilization while in a session.
2. OS notifications when the 5-hour window crosses configurable thresholds (default 75% and 90%).
3. Authoritative data (no estimation/calibration) — sourced directly from Anthropic via the Agent SDK.
4. Per-account, since each Claude account has independent rate-limit windows.
5. Consolidate the session header to free space for the new widget.

## Non-goals

- Hard-blocking of new sessions/messages near the limit (rejected during brainstorming — too brittle since limits are server-authoritative and our local view can be stale).
- Estimating utilization decay between SDK readings. When data is stale, we say so; we do not extrapolate.
- Notifications for the 7-day window in v1 (config defaults to off; user can flip on).
- Background polling via no-op queries when no session is active. The widget will show "last seen Nm ago" when stale.
- Tray-icon presence outside the app window.

## Data Source — Authoritative Finding

The Agent SDK already streams `SDKRateLimitEvent` messages during `query()` execution. The event carries an `SDKRateLimitInfo` payload with:

- `status`: `'allowed' | 'allowed_warning' | 'rejected'`
- `utilization`: number (0–100)
- `rateLimitType`: `'five_hour' | 'seven_day' | ...`
- `resetsAt`: Unix timestamp seconds

Source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (types `SDKRateLimitEvent`, `SDKRateLimitInfo`).

Today, GreyChrist consumes only `SDKControlGetContextUsageResponse` via `handle.query.getContextUsage()` (`electron/services/sessions/queries.ts:113-124`). Rate-limit events flow through the message stream but are dropped on the floor. Capturing them is the foundation of this feature.

## Architecture

### New main-process service: `electron/services/rateLimits.ts`

Factory pattern, dependencies injected:

```
createRateLimitsService({ db, logging, notifications, accounts }) -> RateLimitsService
```

Responsibilities:

1. **Capture.** Provide a hook (`recordEvent(accountName, event)`) that the session-stream consumer in `electron/services/sessions/queries.ts` calls on every `SDKRateLimitEvent`.
2. **Persist latest snapshot.** New SQLite table `rate_limit_snapshots(account_name TEXT PRIMARY KEY, payload_json TEXT, observed_at INTEGER)`. Upsert on every event. Survives restart so the widget can render immediately on app start with last-known data.
3. **Threshold detection.** On each event, compare against the previous snapshot:
   - If utilization crossed upward through any configured threshold for that `rateLimitType`, fire a notification (subject to the dedup table).
   - If `status === 'allowed_warning'` and we have not already fired a warning notification for the current window, fire one. (Treat the SDK's own warning as authoritative regardless of percent threshold.)
   - If `status === 'rejected'`, fire a "limit hit" notification with distinct copy.
4. **Dedup.** New SQLite table `rate_limit_fired_thresholds(account_name TEXT, rate_limit_type TEXT, window_resets_at INTEGER, threshold_key TEXT, fired_at INTEGER, PRIMARY KEY(account_name, rate_limit_type, window_resets_at, threshold_key))`. `threshold_key` is `'pct_75'`, `'pct_90'`, `'sdk_warning'`, or `'sdk_rejected'`. Rows whose `window_resets_at` is in the past are ignored (and may be GC'd lazily).
5. **API surface.**
   - IPC `get_rate_limits()` → `{ [accountName]: SnapshotRow }`
   - IPC `get_rate_limit_settings()` / `update_rate_limit_settings(...)` → reads/writes user prefs
   - Event channel `rate_limits:updated` — pushes new snapshots to the renderer when an event lands.

### Session-stream wiring

In `electron/services/sessions/queries.ts`, where the SDK message stream is consumed, add a branch for `event.type === 'rate_limit'` (or whatever the discriminant is on `SDKRateLimitEvent`) that calls `rateLimits.recordEvent(session.accountName, event.info)`. The session resolves its account via the existing accounts service, so we already know `accountName` at that point.

### IPC and preload

- Add `get_rate_limits`, `get_rate_limit_settings`, `update_rate_limit_settings` to the IPC allow-list in `electron/preload.ts`.
- Add `rate_limits:updated` to the event-channel allow-list.
- Register handlers in `electron/ipc/handlers.ts`. Adapter accepts both camelCase and snake_case params per repo convention.
- Renderer typed surface in `src/lib/api.ts`.

### Settings persistence

User prefs stored as JSON in the existing settings store (or a new `rate_limit_settings` table — pick whichever pattern the repo already uses for analogous prefs). Schema:

```ts
type RateLimitSettings = {
  notifications_enabled: boolean;          // default: true
  five_hour_thresholds_pct: number[];      // default: [75, 90]
  seven_day_notifications_enabled: boolean;// default: false
  seven_day_thresholds_pct: number[];      // default: [75, 90] (only used when enabled)
  sound_enabled: boolean;                  // default: inherit from existing notification sound setting
};
```

## UI Layer

### Header reorganization in `src/components/ClaudeCodeSession.tsx`

Current header (around line 1354) becomes:

**Top row:**
`[← Back to Project] | [folder · branch · worktrees]`

(The vertical separator is a 1px divider matching existing border-color tokens.)

**Bottom row:**
`[account] [status] [rate-limit widget]` ............ `[context] [restart/Clear]`

Removed from header (moved to chat bar — see below):
- `[mode: SDK | Terminal]`
- `[output style: Compact | Verbose]`

### Rate-limit widget — `src/components/RateLimitWidget.tsx`

Two pills side-by-side, styled to match the existing `context` widget (label above, icon + value + mini bar + tail-text inside):

```
5-hour                       7-day
[⏱  73% ████░░░ 1h 12m]    [📅 18% ██░░░░░░ 4d 6h]
```

(Icons in the mockup are placeholders — actual icons should match the Lucide-style icon set used by the existing `context` widget. Suggested: `Clock` for 5-hour, `CalendarDays` for 7-day.)

- **Bar color**: green <50, yellow 50–74, orange 75–89, red ≥90.
- **Tail text**: human-friendly time-to-reset derived from `resetsAt` (e.g. `"1h 12m"`, `"4d 6h"`, `"resets <1m"`).
- **Stale state**: when `now - observed_at > 10 min`, dim the row and append `· last seen Nm ago`. No decay extrapolation.
- **Click**: opens `UsageDashboard` filtered to this account.
- **Hover tooltip**: raw `status`, `resetsAt` ISO, `observed_at` ISO. (Useful for debugging.)
- **Data source**: subscribes to `rate_limits:updated` event for live updates; initial fetch via `get_rate_limits` IPC on mount; renders the snapshot for the session's resolved account.
- **Empty state**: when no snapshot exists yet for the account, render the pills in a muted "—" state. The first SDK event during a session will populate them.

### Chat-bar additions

Above the existing chat-bar control rows (model/thinking selectors and copy/permissions buttons), add two new rows:

- Row above model/thinking selectors → `[mode: SDK | Terminal]` (same control that was in the header).
- Row above copy/permissions buttons → `[output style: Compact | Verbose]` (same control).

These are direct moves of existing controls, not redesigns. Underlying state and IPC stay identical.

### Settings UI

Extend the existing settings surface with a "Rate Limits" section:

- Toggle: notifications enabled
- Editable list: 5-hour thresholds (default `[75, 90]`)
- Toggle: 7-day notifications enabled (default off)
- Editable list: 7-day thresholds (default `[75, 90]`)
- Read-only: "We notify you whenever Anthropic's SDK reports a warning, regardless of these thresholds."

## Data Flow Summary

```
Anthropic API
   │  (SDKRateLimitEvent in stream)
   ▼
electron/services/sessions/queries.ts
   │  rateLimits.recordEvent(accountName, info)
   ▼
electron/services/rateLimits.ts
   ├── upsert rate_limit_snapshots
   ├── threshold detection vs prior + settings
   │       └── notifications.send(...) [via existing service]
   │       └── insert rate_limit_fired_thresholds
   └── emit IPC event 'rate_limits:updated'
           ▼
       preload.ts (allow-listed event channel)
           ▼
       src/components/RateLimitWidget.tsx (re-renders)
```

## Notification Copy

- 75% (5h): `gpchristie · 5-hour usage at 75% — resets in 1h 12m`
- 90% (5h): `gpchristie · 5-hour usage at 90% — wrap up soon, resets in 0h 38m`
- SDK warning: `gpchristie · 5-hour usage approaching limit (Anthropic warning)`
- Rejected: `gpchristie · 5-hour limit hit — paused until 14:32`

Click action: focus app window + navigate to `UsageDashboard` filtered to the account.

## Error Handling

- If the SDK event payload is malformed (missing fields), log a warning via `LoggingService` and skip — never throw out of the stream consumer (would kill the session).
- DB write failures are logged but do not block notification firing; in-memory copy of latest snapshot is kept by the service for the renderer.
- If `notifications_enabled` is false, threshold detection still runs and updates the dedup table, so toggling notifications back on doesn't re-fire stale crossings.

## Testing

Per repo TDD convention, tests in `electron/__tests__/`:

1. `rateLimits.test.ts` — unit tests against `createRateLimitsService` with `createDatabase(':memory:')`:
   - Records snapshot on event; second event upserts.
   - Crossing 75% upward fires once; subsequent events at 80% do not re-fire 75%.
   - Crossing 90% fires once even if 75% already fired in the same window.
   - New `resetsAt` (window rolled over) re-arms thresholds.
   - `status: 'allowed_warning'` fires SDK-warning notification at most once per window.
   - `status: 'rejected'` fires distinct rejection notification.
   - 7-day events do not fire notifications when `seven_day_notifications_enabled` is false.
   - Stale-data flag is computed correctly relative to `observed_at`.
2. `sessions/queries.test.ts` — integration: feeding a fixture `SDKRateLimitEvent` into the stream consumer invokes `recordEvent` with the right account name.
3. Renderer tests on `RateLimitWidget` — color thresholds, stale-state rendering, click handler, empty state.

Coverage target: 80% lines on `rateLimits.ts` per repo policy.

## Migration / Rollout

- New SQLite tables created via existing migration pattern in `electron/services/database.ts`.
- Default settings inserted on first run.
- No data migration needed — feature is purely additive; old sessions that streamed before this change simply have no historical snapshots, which is fine.

## Open Questions for Spec Review

1. Settings persistence — does GreyChrist already have a key/value settings store the new prefs should slot into, or should we add a dedicated `rate_limit_settings` row in a settings table? (Implementation will follow whichever pattern already exists.)
2. Chat-bar layout — exact placement of mode and output-style rows depends on the chat bar's current structure; specifics will be confirmed during planning.
3. Settings UI location — new "Rate Limits" section in the existing global Settings panel, or attach to the per-account `AccountSettings`? Default assumption: global (since thresholds are user-level prefs, not per-account).

---

## Acceptance criteria (for the implementation plan)

- The session header matches the new layout shown in the brainstorming image (folder/branch up top, rate-limit widget where folder/branch was, restart paired with context, mode and output style moved to the chat bar).
- The rate-limit widget renders both 5-hour and 7-day pills, styled consistently with the context widget, populated from authoritative SDK data.
- An OS notification fires when 5-hour utilization crosses 75% and again at 90% (configurable), and again when the SDK emits an `allowed_warning` or `rejected` status.
- Notifications do not re-fire within the same window after firing once for a given threshold.
- The dashboard remains the click-through destination for both the widget and notifications.
- All new main-process logic has tests at ≥80% line coverage.
- `npm run check`, `npm run build`, and `npm test` all pass.

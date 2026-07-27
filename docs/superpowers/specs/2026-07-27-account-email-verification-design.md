# Account Email Verification — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending implementation

## Problem

OmniFex routes projects to Claude accounts by config dir (`CLAUDE_CONFIG_DIR`), resolved
via explicit project override → longest matching path rule → null. Nothing in that chain
verifies *who is actually logged in* to the resolved config dir. A dir can be silently
re-authenticated as a different account, or logged out entirely, and OmniFex will happily
launch a session against it. The user finds out only when work lands on the wrong
subscription.

We want a secondary confirmation: an expected email recorded on the account, compared
against the identity actually authenticated in that config dir, checked **at session
start**.

## What already exists

- `SessionAccountInfo` (`src/lib/api.ts:747`) with `email` / `organization` /
  `subscriptionType` / `apiProvider` / `tokenSource`, fetched via the
  `session_account_info` IPC channel → `getAccountInfo()`
  (`electron/services/sessions/queries.ts:187`), which reads `account` off the
  stream-json `system:init` payload. Rendered by `AccountCard.tsx:134`.
  **Limitation:** only populates for a live rich-mode session. `getInitData()` is null in
  TUI mode, and Settings never sees it.
- `codexAuth.getStatus(configDir)` (`electron/services/auth/codex-auth.ts`) already
  returns `{ authenticated, mode, email }` for Codex accounts.
- `usage-runner/scratch-cwd.ts` already writes `<configDir>/.claude.json` (trust flags) but
  never reads `oauthAccount` from it.

## Sources of truth (verified 2026-07-27 against the installed CLI)

1. **`claude auth status --json`** — a real subcommand; `--json` is the default. Honors
   `CLAUDE_CONFIG_DIR`. Returns:
   ```json
   { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
     "email": "…", "orgId": "…", "orgName": "…", "subscriptionType": "max" }
   ```
   Authoritative, but costs a CLI spawn (~1s).
2. **`<configDir>/.claude.json` → `oauthAccount`** — `emailAddress`, `displayName`,
   `organizationName`, `organizationType`. Instant file read, no spawn. Caveat:
   `oauthAccount` lingers after logout, so it detects the wrong-account case but not
   reliably the logged-out case.
3. **stream-json `system:init` → `account`** — free, and it is the identity of the *actual
   running process*, not a proxy for it. Rich mode only.

## Design

### 1. Data model

One migration, **version 17** in `electron/services/database.ts` (the migration array
currently ends at v16), following the existing guarded-`ALTER` pattern:

```
ALTER TABLE accounts ADD COLUMN expected_email TEXT
```

- `Account` (`electron/services/accounts.ts`) gains `expected_email: string | null`.
- `CreateAccountOptions` / `UpdateAccountOptions` gain `expectedEmail?: string | null`.
- **Null means "do not check."** Accounts that have not opted in stay entirely silent and
  do zero I/O at session start.

### 2. New service — `electron/services/account-identity.ts`

Factory-function pattern (`createAccountIdentityService(deps)`), consistent with
`electron/services/`. Two operations with deliberately different costs:

- `readOauthIdentity(configDir): OauthIdentity | null`
  Reads `<configDir>/.claude.json`, returns
  `{ email, displayName, organizationName, organizationType }` from `oauthAccount`, or
  `null` when the file is absent, unparseable, or has no `oauthAccount`. Never throws.
  **This is the hot path.**

- `probeAuthStatus(configDir, cliPath?): AuthStatus`
  Spawns `claude auth status --json` with `CLAUDE_CONFIG_DIR=configDir`, parses the JSON,
  returns `{ loggedIn, authMethod, apiProvider, email, orgName, subscriptionType }`.
  Binary located via the existing `electron/services/claude-binary.ts` resolver, honoring
  the account's `cli_path` override. Used **only** for the Settings "Detect" button and
  prefill — never on session start.

Engine dispatch: Codex accounts route to the existing `codexAuth.getStatus(configDir)`.
No new Codex code path.

Two IPC channels added to `electron/ipc/channels.ts` and the `electron/preload.ts`
allow-list: `account_identity_read`, `account_identity_probe`.

### 3. Session-start check

The core requirement. Two checks, cheap first.

**Pre-flight (both modes).** In `electron/services/sessions/lifecycle.ts` `start()`, after
the configDir re-resolution (`lifecycle.ts:118-135`) and **before** the spawn: if the
resolved account has a non-null `expected_email`, call `readOauthIdentity(configDir)` and
compare. Same hook in `startTuiColdStart` (`lifecycle.ts:672`).

**Post-init confirmation (rich mode only).** `runtime.ts:148` already captures
`handle.initData` from `system:init`. When it lands, compare `initData.account.email`
against `expected_email`. This is the stronger signal — the file read can be stale, the
init payload cannot.

**On mismatch** (either check): emit `session-account-mismatch:<tabId>` carrying
`{ expected, detected, configDir, source: 'oauth-file' | 'session-init' }`. The
`session-` prefix is already in `EVENT_CHANNEL_PREFIXES` (`electron/ipc/channels.ts:229`),
so no preload allow-list change is needed for the event.

**Non-blocking.** The session starts regardless. The warning informs; it does not gate.

**Logged-out is treated as a mismatch** — a config dir with no active login is exactly the
failure being guarded against. Emitted with `detected: null`.

**Comparison** is trimmed and case-insensitive. No further normalization — no Gmail
dot-stripping or plus-address folding, which would be surprising and could mask a real
mismatch between two addresses the user considers distinct.

**Cost:** zero when `expected_email` is null. One small file read otherwise. No CLI spawn
on the session-start path, ever.

**Known limitation:** TUI sessions get only the pre-flight file-read check, because TUI
mode produces no init data. Documented in `docs/session-lifecycle.md` rather than
worked around.

### 4. UI

- **`src/components/AccountDialog.tsx`** — an "Email" text input beside the existing
  subscription-label field (`AccountDialog.tsx:283`), plus a **Detect** button that runs
  `probeAuthStatus` and fills the field. Claude engine only; the Codex branch already
  renders its own auth email at `AccountDialog.tsx:340`.
- **`src/components/AccountSettings.tsx`** — each account row shows the detected email;
  amber badge on mismatch, grey "not signed in" when logged out, nothing when the account
  has no `expected_email`. The row's detected value comes from `account_identity_read`
  (the cheap file read) so opening Settings never spawns N CLIs; `account_identity_probe`
  runs only when the user presses **Detect** in the dialog.
- **Session header** — a dismissible warning banner driven by
  `session-account-mismatch:<tabId>`, stating expected vs. detected.
- **`electron/services/first-run-discovery.ts`** — prefills `expected_email` from
  `readOauthIdentity` when seeding accounts, so the feature works without the user typing
  anything. The dialog field exists to correct it, not to bootstrap it.

### 5. Testing

TDD — failing tests first, per CLAUDE.md.

`electron/__tests__/account-identity.test.ts`
- `readOauthIdentity`: valid file; missing file; malformed JSON; file present but no
  `oauthAccount` key. Returns null (never throws) on all failure shapes.
- `probeAuthStatus`: parses the documented JSON; handles a logged-out response; handles
  non-JSON stdout without throwing.

`electron/__tests__/accounts.test.ts` (extend)
- Migration v17 adds the column and is idempotent.
- `createAccount` / `updateAccount` round-trip `expectedEmail`; passing `null` clears it.

`electron/__tests__/sessions-account-resolution.test.ts` (extend — the pre-flight check
sits directly downstream of resolution, so it belongs with those tests)
- Mismatch emits `session-account-mismatch:<tabId>` **and the session still starts.**
- Match emits nothing.
- `expected_email === null` performs no file read at all (assert the injected reader is
  never called) — proves the zero-cost claim.
- Logged-out (`readOauthIdentity` → null) emits with `detected: null`.

`electron/__tests__/sessions-runtime.test.ts` (extend)
- Rich-mode init disagreeing with `expected_email` emits with `source: 'session-init'`.

`electron/__tests__/sessions-tui-coldstart.test.ts` (extend)
- The TUI cold-start path runs the pre-flight check and emits on mismatch.

Renderer tests
- `AccountDialog` renders and round-trips the email field; Detect fills it.
- `AccountSettings` row shows the mismatch badge only when expected and detected differ.

Coverage gate: 80% lines on the new backend service, per CLAUDE.md.

## Out of scope

- Blocking or gating session start on a mismatch (explicitly rejected — becomes a
  reflex-dismissed modal on a hot path).
- Periodic background re-probing of every account.
- Any change to account resolution order. Resolution stays override → rule → null; this
  feature only observes and reports.
- Auto-correcting a mismatch by switching accounts or re-authenticating.

## Verification

Per CLAUDE.md's cross-cutting gate: `npm run check`, `npm run build`, and
`npm run test:coverage`. Followed by `npm run rebuild:electron` so the app can be launched
after the vitest run.

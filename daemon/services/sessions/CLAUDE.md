# Sessions

## Three state axes

`conversationStatus` is a renderer rollup of axes 2 and 3, not a fourth axis.

1. `sessionStatus`: is the CLI process up? `starting | started | error | stopped`. There is no `idle` or `running` here.
   - `error` is a failed `start()`/restart spawn; the next send retries via `restartQuery`.
   - A mid-stream stderr line never sets `error`: it is surfaced as a toast and the session stays live. A CLI crash exits to `stopped`, and the next prompt does a fresh `--resume` start.
2. `turn`: `{ status: 'idle' | 'running', since }`, owned by the session handle here and mirrored by the renderer.
   - `idle → running` in `sendMessage` / `sendStructuredMessage`, before the write, so a fast `result` cannot be missed. Auto-recap (`auto-recap.ts`) sends `/recap` itself after an idle delay, once per turn.
   - `running → idle` on the CLI's `result` row (`runtime.ts`), on `stopped`/`error` (`status.ts`), or on `stop()`.
   - Announced on `session-turn:<tabId>`; also in `session_get_health` and the wire's `session.state`.
3. Tasks and subagents: per-item `pending | running | complete`, derived from the transcript (`hasOpenTasks` / `hasOpenSubagents` in `src/lib/sessionDerivedState.ts`).

The turn is never inferred from the transcript. A resumed session whose process died mid-turn has a transcript that ends open (`tool_use` + `tool_result`, no `result`), and the new process is working on nothing. Walking it put the spinner on WORKING forever.

## Invariants

- `turn.status === 'running'` implies `sessionStatus === 'started'`; `setStatus` closes the turn on stop/error.
- `sessionStatus` and `turn` transitions are owned here. The renderer may only set an optimistic `starting`, a synchronous `stopped` in its own teardown, and reset `turn` to idle on start or reset.
- `conversationStatus` = `turn running || open task || open subagent`, computed in `useSessionLifecycle`; it never crosses IPC or the wire.
- No component `useState` mirrors any axis; components read the hook's derived values.
- In-flight (spinners, send gating, tab status, updater gate) = `conversationStatus === 'running'`. `starting`, `error` and `stopped` are not in-flight. The daemon's `SessionSummary.inFlight` and `/healthz` `sessions.inFlight` count turns plus pending permissions.
- `bridge.ts` caches both axes for reconnecting clients but never closes a turn on a `result` row. A reconnect replays `session.state`, `event` and `permission.request`.

## Anti-patterns

- Two booleans for one enum; reading `sessionStatus === 'idle' | 'running'`.
- Synthesizing a transcript node to close a turn on resume.
- Dropping a `cli-stream-result` row from `messages[]`: it triggers `refreshContextUsage` and the queue drain. Rewrite its presentation instead.
- Closing the turn when a usage limit parks it. With `autoContinueAtUsageLimit` (default on for claude.ai logins) the CLI waits for the reset and continues; the turn is genuinely running. `usageLimitWait` explains it, it does not end it.

## Account identity

An account with `expected_email` is checked twice at start, both non-blocking: `.claude.json`'s `oauthAccount.emailAddress` for the re-resolved config dir (`lifecycle.start()`), then `account.email` in the CLI's `system:init` (`runtime.ts`). Both emit `session-account-mismatch:<tabId>`; `detected: null` (signed out) counts as a mismatch. Never run `claude auth status` on the start path: it costs a spawn.

A CLI whose OAuth refresh fails stays signed out until restarted, while `.claude.json` still looks fine. Only the transcript shows it: `sessionAuthFailure` plus `useSessionAuthExpiry`, which restarts on `announceAccountSignedIn` unless a turn is running.

## Permission decider (`permissions.ts`)

OmniFex is a `--permission-prompt-tool stdio` host; it sees only what the CLI chooses to ask.

- `acceptEdits`: auto-allow a file edit only when the CLI did not escalate it (`isEscalatedEdit`). A `workingDir` ask defaults to an `Edit(<dir>/**)` rule. A symlink escape (`safetyCheck` with `blocked_path`) can only be cleared by adding the directory (`directory_grant` → `addDirectories`); no `Edit` rule works.
- `suppress_always_allow_rule: true`: forward it and offer allow-once / deny only, no rule.
- Bypass: every Claude ask that reaches the decider is one the CLI insists on, so prompt for all of them. Codex approvals still auto-allow; `dontAsk` still denies.
- Bypass mid-session works only in a session launched in Bypass. `queries.ts` refuses the switch otherwise (Restart in Bypass is the path), and any refused mode switch is rolled back on `handle.permissionMode` and in the picker.
- Never reach the decider, so never show a card: auto-mode classifier denials (`system/permission_denied`, rebuilt from the tool_result text after a reload by `src/lib/permissionDenial.ts`) and `permissions.blockReadsOutsideWorkingDirectories` refusals (true in any source wins, enforced even in Bypass, covers Read/Grep/Glob/LSP).
- `apply_flag_settings {permissions}` replaces the flag layer's lists: send the full set, never a delta.

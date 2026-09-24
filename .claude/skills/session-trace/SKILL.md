---
name: session-trace
description: Use when Greg points at a specific OmniFex session — a UUID, "check on a session", "this session seems stuck", a spinner that never stops, a tab that will not resume, or a pasted JSONL excerpt — before reading any source code.
argument-hint: "<session-uuid>"
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/*)
---

# Session Trace

Start from the evidence on disk, not from the code. One command gathers it:

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/session-trace.sh $ARGUMENTS
```

A prefix of the UUID is enough. It reads, in order:

| Source | What it tells you |
|---|---|
| `~/.omnifex{,-dev}/sessions/<id>.meta.json` | project, config dir (= account), model, permission mode, resume |
| `<id>.events.jsonl` `session.state` rows | the daemon's own `sessionStatus` + `turn` — the authoritative in-flight state |
| `<configDir>/projects/<project>/<id>.jsonl` | what the CLI wrote: last records, `stop_reason`, open `tool_use` without a result |
| `app_logs` in `greychrist.db` | main/daemon errors around the session (there is no log file) |
| `/healthz` on 47700 (installed) / 47701 (dev) | whether a daemon is even up |

## Reading it

- **`turn.status: running` with a `result` as the last CLI record** → the
  daemon missed the result row. Look at `electron/services/sessions/runtime.ts`.
- **`turn.status: idle` but the UI spins** → renderer rollup: open tasks or
  subagents in the transcript (`sessionDerivedState.ts`), or a stale mirror in
  `useSessionLifecycle`. The turn is never inferred from the transcript — see
  `docs/session-lifecycle.md` before proposing a fix that does.
- **Transcript ends on `tool_use` with no `tool_result`, daemon says idle** →
  the process died mid-turn; a `--resume` starts idle by construction. Not a
  bug unless the UI disagrees.
- **No daemon session, transcript exists** → the tab was opened outside the
  daemon or on the other account; check which config dir the transcript is in
  against what `accounts.resolve()` would pick (`multi-account-debugging`).
- **`configDir` differs from where the transcript lives** → account mis-route.

Then, and only then, open the code path the evidence points at. Quote the
`session.state` row and the last CLI records in the report so the diagnosis is
checkable.

---
name: multi-account-debugging
description: Use when a bug may involve the mapping from project path to Claude account, config directory, sessions, usage, or process environment.
---

# Multi-Account Debugging

This repo's core feature is mapping one project path to the correct Claude
subscription/config directory.

## Objective

Trace one concrete `project_path` from UI intent to backend resolution to
on-disk session state.

## Debug Loop

1. Start with one exact project path.
2. Determine which account should win, in `resolve()`'s order:
   - explicit project override (`project_account_overrides`)
   - longest matching path rule (`account_path_rules`)
   - unambiguous on-disk ownership — `projects/<encoded>` under exactly one
     account's config dir (Claude slot only)
   - `null` — **there is no default account.** An all-null pair is an error
     condition (`NoAccountError` / `NO_ACCOUNT_FOR_PROJECT`), never a fallback.
3. Confirm the resolved `config_dir`.
4. Confirm the expected on-disk locations:
   - `projects/<encoded project path>`
   - `todos/`
   - account-specific `settings.json`
5. Confirm any spawned process sets `CLAUDE_CONFIG_DIR` correctly.
6. Confirm the frontend shows the same resolved account.

## Files To Check

- `electron/services/accounts.ts` — `resolve()`, `resolveOnDisk()`,
  `explainResolution()`, path rules, overrides, discovery
- `electron/services/claude.ts` — `listProjects()`, `getProjectSessions()`,
  `createProject()`, `NoAccountError`
- `electron/services/project-paths.ts` — `encodeProjectId` / `decodeProjectId`
  / `recoverProjectPath` (encoding is lossy; recovery reads dir contents)
- `electron/services/sessions/lifecycle.ts` + `electron/services/agents/` —
  where `CLAUDE_CONFIG_DIR` reaches a spawned process
- `electron/services/util/claude-env.ts` — `buildClaudeEnv`
- `src/App.tsx` — project open flow, `NO_ACCOUNT_FOR_PROJECT` banner
- `src/components/AccountPickerDialog.tsx` — persists a project override
- `src/components/AccountSettings.tsx` — path-rule UI and the resolution tester
- `src/components/AccountCard.tsx` — `matchType` → user-facing label

## Useful Queries

The dev database lives at
`~/Library/Application Support/OmniFex/greychrist.db` (see the `app_logs`
table for errors — there is no log file).

```sql
SELECT * FROM account_path_rules;
SELECT * FROM project_account_overrides;
SELECT id, name, config_dir, engine, color FROM accounts;
SELECT level, message FROM app_logs ORDER BY id DESC LIMIT 20;
```

## Common Failure Modes

- path prefix match succeeds on a non-canonical path (normalize first)
- the project physically lives under a different account than the rules imply —
  check on-disk ownership before assuming the rules are wrong
- on-disk ownership declines to answer because the folder exists under two
  accounts; that is correct behavior, and the picker should ask
- session lookup falls back to `~/.claude` (it must not; that is a bug)
- usage attribution resolves account by project path differently than session
  lookup does
- a fresh `--user-data-dir` profile has discovered accounts but **no** path
  rules, so every project resolves to `null` until one is added

## Output

Report:

- expected account
- actual account
- exact divergence point
- smallest safe fix

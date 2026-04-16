---
name: multi-account-debugging
description: Use when a bug may involve the mapping from project path to Codex account, config directory, sessions, usage, or process environment.
---

# Multi-Account Debugging

This repo's core feature is mapping one project path to the correct Codex subscription/config directory.

## Objective

Trace one concrete `project_path` from UI intent to backend resolution to on-disk session state.

## Debug Loop

1. Start with one exact project path.
2. Determine which account should win:
   - project override
   - longest matching path rule
   - default account
3. Confirm the resolved `config_dir`.
4. Confirm the expected on-disk locations:
   - `projects/<encoded project path>`
   - `todos/`
   - account-specific `settings.json`
5. Confirm any spawned process sets `CLAUDE_CONFIG_DIR` correctly.
6. Confirm the frontend shows the same resolved account.

## Files To Check

- `src-tauri/src/accounts/mod.rs`
- `src-tauri/src/commands/accounts.rs`
- `src-tauri/src/commands/Codex.rs`
- `src-tauri/src/commands/agents.rs`
- `src-tauri/src/commands/usage.rs`
- `src/App.tsx`
- `src/components/AccountSettings.tsx`
- `src/components/ClaudeCodeSession.tsx`

## Common Failure Modes

- path prefix match succeeds on a non-canonical path
- project exists under a different account than the default resolution suggests
- session lookup falls back to `~/.Codex`
- web mode appears broken because the endpoint is stubbed
- usage attribution resolves account by project path differently than session lookup

## Output

Report:
- expected account
- actual account
- exact divergence point
- smallest safe fix

---
name: opcode-targeted-workflow
description: Use when working in the opcode codebase. Helps Codex spend context carefully, trace the right execution path, and avoid broad repo reads or speculative fixes.
---

# Opcode Targeted Workflow

Use this skill when implementing or debugging in `opcode`.

## Goal

Make progress with the smallest useful context. Prefer reading 5 precise files over 50 vaguely related ones.

## Workflow

1. Classify the request first:
   - account routing / project isolation
   - Codex session execution / process spawning
   - usage attribution / cost display
   - frontend UI behavior
   - desktop vs web parity
   - general build/config/tooling
2. Trace the narrowest end-to-end path for that request before editing.
3. Read only the files on that path.
4. Implement the smallest fix that preserves existing architecture.
5. Run the narrowest relevant verification, then `/verify` for broader or risky work.

## High-Value Traces

### Multi-account or project isolation issues

Trace in this order:
- `src-tauri/src/accounts/mod.rs`
- `src-tauri/src/commands/accounts.rs`
- `src-tauri/src/commands/Codex.rs`
- `src-tauri/src/commands/agents.rs`
- `src-tauri/src/commands/usage.rs`
- `src/App.tsx`
- `src/components/AccountSettings.tsx`
- `src/components/ClaudeCodeSession.tsx`

### Frontend API or session issues

Trace in this order:
- `src/lib/api.ts`
- `src/lib/apiAdapter.ts`
- calling component
- corresponding Tauri command
- `src-tauri/src/web_server.rs` only if web mode is involved

### Desktop vs web parity issues

Never assume parity exists. Confirm:
- Tauri command exists
- REST endpoint exists
- adapter maps the command

## Context Discipline

- Prefer `rg` plus line-ranged reads.
- Do not dump entire large files unless the request truly needs them.
- Avoid broad architecture summaries unless the user asked for them.
- Do not inspect unrelated feature areas "just in case."

## Editing Rules

- Keep account-aware behavior explicit. Do not add silent fallbacks that hide routing bugs.
- Do not bypass `apiAdapter` from frontend components.
- If the change touches `CLAUDE_CONFIG_DIR`, verify the resolved account path explicitly.

## Verification

- Frontend-only: `npm run check`, `npm run build`
- Rust/backend: `npm run check`, then `cd src-tauri && cargo test`
- If Rust tools are missing: use `nix-shell`

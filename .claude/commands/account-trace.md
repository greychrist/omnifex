# Account Trace - Trace a project path through opcode's multi-account flow.

Use this command when account selection, project routing, session lookup, usage attribution, or `CLAUDE_CONFIG_DIR` behavior looks wrong.

## Trace Path

For the target `project_path`, inspect these layers in order:

1. `src-tauri/src/accounts/mod.rs`
   - override lookup
   - path rule matching
   - default account fallback
2. `src-tauri/src/commands/accounts.rs`
   - API-facing resolution behavior
3. `src-tauri/src/commands/claude.rs`
   - project creation/listing
   - session lookup
   - process spawning
4. `src-tauri/src/commands/agents.rs`
   - agent execution and run/account recording
5. `src-tauri/src/commands/usage.rs`
   - usage aggregation and account-type annotation
6. Frontend
   - `src/App.tsx`
   - `src/components/AccountSettings.tsx`
   - `src/components/ClaudeCodeSession.tsx`
   - `src/lib/api.ts`

## Output

Report:

- resolved account according to current code
- where the path can diverge from expected behavior
- whether the issue is in:
  - resolution policy
  - filesystem lookup
  - process environment
  - usage aggregation
  - frontend state/UI
- the smallest safe fix

## Rules

- Trace the same concrete project path through every layer.
- Prefer end-to-end reasoning over isolated file edits.
- If desktop and web behavior differ, call that out explicitly.

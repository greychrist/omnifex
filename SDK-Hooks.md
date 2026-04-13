# Claude Agent SDK Hooks Reference

> SDK version **0.2.104** | GreyChrist wiring status as of 2026-04-12

All hooks receive shared `BaseHookInput` fields: `session_id`, `transcript_path`, `cwd`, `permission_mode?`, `agent_id?`, `agent_type?`.

## Hook Status

| # | Hook | Status | Fires When | Our Wiring / Planned Use |
|---|------|--------|------------|--------------------------|
| 1 | **PreToolUse** | ✅ | Before Claude executes any tool call | Audit log (tool name + input). Can return `permissionDecision`, `updatedInput`. |
| 2 | **PostToolUse** | ✅ | After a tool call completes successfully | Audit log (tool name + input + response). |
| 3 | **PostToolUseFailure** | ✅ | After a tool call fails | Error-level audit log (tool name + error message). |
| 4 | **Notification** | ✅ | SDK emits a notification (MCP disconnect, warnings, errors) | Audit log + OS notification + inline chat message (`subtype: 'notification'`). |
| 5 | **SubagentStart** | ✅ | A subagent (Agent tool worker) begins execution | Audit log + renderer event on `claude-subagent:<tabId>`. |
| 6 | **SubagentStop** | ✅ | A subagent finishes | Audit log + renderer event on `claude-subagent:<tabId>`. |
| 7 | **PreCompact** | ✅ | Just before context compaction begins | Warning-level log + renderer event on `claude-compact:<tabId>`. |
| 8 | **FileChanged** | ✅ | A watched file is created, modified, or deleted | Audit log (file path + event type). Can return `watchPaths`. |
| 9 | **SessionStart** | ✅ | Session begins (startup, resume, clear, or after compaction) | Audit log with `source` field. Inline `session_lifecycle` event (`event: 'start'`). |
| 10 | **SessionEnd** | ✅ | Session terminates | Audit log with exit `reason`. Inline `session_lifecycle` event (`event: 'end'`). |
| 11 | **Stop** | ✅ | Assistant's turn completes (naturally or by interruption) | Audit log with `last_assistant_message`. |
| 12 | **StopFailure** | ✅ | Assistant's turn ends due to an error (model error, prompt too long, etc.) | Error-level log. Inline `stop_failure` card with error details. |
| 13 | **PostCompact** | ✅ | After context compaction finishes | Audit log with `compact_summary`. Inline `post_compact` card with summary. |
| 14 | **PermissionRequest** | ✅ | Claude requests permission to execute a tool (before user sees prompt) | Replaces `canUseTool`. Emits `permission_request` to renderer with `permission_suggestions`. Awaits user decision. Returns `hookSpecificOutput` with `allow`/`deny` + `updatedPermissions` for rule persistence at session/project/account scope. |
| 15 | **PermissionDenied** | ✅ | After a tool permission request is denied | Warn-level log. Inline `permission_denied` card with tool name and reason. |
| 16 | **UserPromptSubmit** | ❌ | User submits a prompt (before Claude processes it) | Inject account/project context. Auto-set session titles. Log prompt submissions. Could implement prompt templates/macros. |
| 17 | **Setup** | ❌ | Session initialization (`init`) or periodic maintenance | Inject account-aware setup context. Log init/maintenance cycles. |
| 18 | **TeammateIdle** | ❌ | A teammate in a team session becomes idle | Future multi-agent UI: teammate status indicators, idle logging. |
| 19 | **TaskCreated** | ❌ | A task is created (team/multi-agent context) | Future task sidebar: show active tasks across teammates. |
| 20 | **TaskCompleted** | ❌ | A task completes | Update task sidebar. Trigger notifications when background tasks finish. |
| 21 | **Elicitation** | ❌ | MCP server requests user input; hooks can auto-respond | Render Electron dialog for MCP elicitation instead of terminal prompts. Auto-approve known MCP servers by account policy. `mode: 'url'` opens browser for OAuth. |
| 22 | **ElicitationResult** | ❌ | User responds to MCP elicitation (before response reaches server) | Audit log. Validate/modify responses before they reach MCP server. |
| 23 | **ConfigChange** | ❌ | Claude Code config changes (settings, skills, etc.) | Log config changes. Trigger UI refresh on project settings change. Detect mid-session CLAUDE.md edits. |
| 24 | **WorktreeCreate** | ❌ | Git worktree created during a session | Track active worktrees per session. Worktree indicator in session header. |
| 25 | **WorktreeRemove** | ❌ | Git worktree removed | Clean up worktree tracking state. |
| 26 | **InstructionsLoaded** | ❌ | Claude loads instruction files (CLAUDE.md, etc.) | Show active instruction files in diagnostics panel. Debug "why did Claude do that?" Log instruction loading with `memory_type` and `load_reason`. |
| 27 | **CwdChanged** | ❌ | Session working directory changes | Update session header. Re-resolve account if new cwd falls under a different path rule. |

## Priority

| Tier | Hooks | Rationale |
|------|-------|-----------|
| **High** | ~~SessionStart~~, ~~SessionEnd~~, ~~Stop~~, ~~StopFailure~~, ~~PostCompact~~, ~~PermissionDenied~~ | All wired -- session lifecycle, error surfacing, compaction visibility, audit trail |
| **Medium** | UserPromptSubmit, CwdChanged, InstructionsLoaded, ConfigChange | Context injection, live config awareness |
| **Future** | Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, WorktreeCreate, WorktreeRemove | Multi-agent team UI, MCP elicitation dialogs, worktree tracking |

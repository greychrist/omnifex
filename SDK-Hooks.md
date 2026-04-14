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
| 16 | **UserPromptSubmit** | ✅ | User submits a prompt (before Claude processes it) | Audit log (prompt length + session title). Inline `user_prompt_submit` event to renderer. |
| 17 | **Setup** | ✅ | Session initialization (`init`) or periodic maintenance | Audit log (trigger). Inline notification to renderer. |
| 18 | **TeammateIdle** | ❌ | A teammate in a team session becomes idle | Future multi-agent UI: teammate status indicators, idle logging. |
| 19 | **TaskCreated** | ✅ | A task is created (team/multi-agent context) | Audit log + inline `task_event` (created) to renderer with task details. |
| 20 | **TaskCompleted** | ✅ | A task completes | Audit log + inline `task_event` (completed) + native OS notification + dock badge. |
| 21 | **Elicitation** | ✅ | MCP server requests user input; hooks can auto-respond | Audit log. Auto-accept. URL mode opens browser for OAuth. `onElicitation` fallback when logging disabled. |
| 22 | **ElicitationResult** | ✅ | User responds to MCP elicitation (before response reaches server) | Audit log (server name + action + content). |
| 23 | **ConfigChange** | ✅ | Claude Code config changes (settings, skills, etc.) | Audit log + inline `config_change` event to renderer with source + file path. |
| 24 | **WorktreeCreate** | ❌ | Git worktree created during a session | Track active worktrees per session. Worktree indicator in session header. |
| 25 | **WorktreeRemove** | ❌ | Git worktree removed | Clean up worktree tracking state. |
| 26 | **InstructionsLoaded** | ✅ | Claude loads instruction files (CLAUDE.md, etc.) | Audit log (file path + memory type + load reason). Inline `instructions_loaded` event to renderer. |
| 27 | **CwdChanged** | ❌ | Session working directory changes | Update session header. Re-resolve account if new cwd falls under a different path rule. |

## Priority

| Tier | Hooks | Rationale |
|------|-------|-----------|
| **High** | ~~SessionStart~~, ~~SessionEnd~~, ~~Stop~~, ~~StopFailure~~, ~~PostCompact~~, ~~PermissionDenied~~ | All wired — session lifecycle, error surfacing, compaction visibility, audit trail |
| **Medium** | ~~UserPromptSubmit~~, CwdChanged, ~~InstructionsLoaded~~, ~~ConfigChange~~ | Context injection, live config awareness. CwdChanged still TODO. |
| **Done** | ~~Setup~~, TeammateIdle, ~~TaskCreated~~, ~~TaskCompleted~~, ~~Elicitation~~, ~~ElicitationResult~~, WorktreeCreate, WorktreeRemove | TeammateIdle, WorktreeCreate, WorktreeRemove still TODO. |

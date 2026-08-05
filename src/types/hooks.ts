/**
 * Types for Claude Code hooks configuration
 */

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number; // Optional timeout in seconds (default: 60)
}

export interface HookMatcher {
  matcher?: string; // Pattern to match tool names (regex supported)
  hooks: HookCommand[];
}

/**
 * Every hook event the CLI fires, in lifecycle order.
 * Source: https://code.claude.com/docs/en/hooks (checked 2026-08-05, CLI
 * 2.1.222). The editor previously knew only five of these.
 */
export const HOOK_EVENTS = [
  // Session
  'SessionStart', 'Setup', 'SessionEnd', 'Stop', 'StopFailure',
  // Prompt
  'UserPromptSubmit', 'UserPromptExpansion', 'MessageDisplay',
  // Tools
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  // Permissions
  'PermissionRequest', 'PermissionDenied',
  // Subagents & tasks
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle',
  // Context
  'PreCompact', 'PostCompact', 'InstructionsLoaded',
  // Workspace
  'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged',
  'WorktreeCreate', 'WorktreeRemove',
  // Notifications
  'Notification',
  // MCP
  'Elicitation', 'ElicitationResult',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Hooks as they appear in settings.json.
 *
 * EVERY event uses the same nesting — `Event → [{matcher?, hooks: [...]}]` —
 * including the events that ignore `matcher` and always fire. An earlier
 * version of this type modelled Notification/Stop/SubagentStop as a flat
 * `HookCommand[]`, which mis-read real configs and wrote back a shape the CLI
 * silently never executes.
 */
export type HooksConfiguration = Partial<Record<HookEvent, HookMatcher[]>>;

export const HOOK_EVENT_GROUPS = [
  'Session',
  'Prompt',
  'Tools',
  'Permissions',
  'Subagents & Tasks',
  'Context',
  'Workspace',
  'Notifications',
  'MCP',
] as const;

export type HookEventGroup = (typeof HOOK_EVENT_GROUPS)[number];

export interface HookMatcherInfo {
  /** What the matcher filters on, shown next to the field. */
  hint: string;
  /** Concrete values the CLI accepts — the vocabulary is per-event and not
   *  guessable, so the editor offers these directly. */
  examples: string[];
}

/** Tool-name patterns offered for the five events whose matcher is a tool. */
export const COMMON_TOOL_MATCHERS = [
  'Task',
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'WebFetch',
  'WebSearch',
  'Notebook.*',
  'Edit|Write',
  'mcp__.*',
  'mcp__memory__.*',
  'mcp__filesystem__.*',
  'mcp__github__.*',
];

export interface HookEventInfo {
  label: string;
  description: string;
  group: HookEventGroup;
  /** `false` for events that always fire and silently ignore `matcher`. */
  matcher: false | HookMatcherInfo;
}

export const HOOK_EVENT_INFO: Record<HookEvent, HookEventInfo> = {
  SessionStart: {
    label: 'Session Start',
    description: 'A session begins or resumes',
    group: 'Session',
    matcher: { hint: 'How the session started', examples: ['startup', 'resume', 'clear', 'compact', 'fork'] },
  },
  Setup: {
    label: 'Setup',
    description: 'Claude Code starts with --init-only, or --init / --maintenance in -p mode',
    group: 'Session',
    matcher: { hint: 'Which CLI flag triggered setup', examples: ['init', 'maintenance'] },
  },
  SessionEnd: {
    label: 'Session End',
    description: 'A session terminates',
    group: 'Session',
    matcher: {
      hint: 'Why the session ended',
      examples: ['clear', 'resume', 'logout', 'prompt_input_exit', 'bypass_permissions_disabled', 'other'],
    },
  },
  Stop: {
    label: 'Stop',
    description: 'Claude finishes responding',
    group: 'Session',
    matcher: false,
  },
  StopFailure: {
    label: 'Stop (Failure)',
    description: 'The turn ends due to an API error',
    group: 'Session',
    matcher: {
      hint: 'Error type',
      examples: ['rate_limit', 'overloaded', 'authentication_failed', 'billing_error'],
    },
  },
  UserPromptSubmit: {
    label: 'Prompt Submit',
    description: 'You submit a prompt, before Claude processes it',
    group: 'Prompt',
    matcher: false,
  },
  UserPromptExpansion: {
    label: 'Prompt Expansion',
    description: 'A typed command expands into a prompt, before it reaches Claude',
    group: 'Prompt',
    matcher: { hint: 'Command name', examples: ['commit', 'verify'] },
  },
  MessageDisplay: {
    label: 'Message Display',
    description: 'Assistant message text is displayed',
    group: 'Prompt',
    matcher: false,
  },
  PreToolUse: {
    label: 'Pre Tool Use',
    description: 'Before a tool call executes — can block and provide feedback',
    group: 'Tools',
    matcher: { hint: 'Tool name (regex)', examples: COMMON_TOOL_MATCHERS },
  },
  PostToolUse: {
    label: 'Post Tool Use',
    description: 'After a tool call succeeds',
    group: 'Tools',
    matcher: { hint: 'Tool name (regex)', examples: COMMON_TOOL_MATCHERS },
  },
  PostToolUseFailure: {
    label: 'Post Tool Use (Failure)',
    description: 'After a tool call fails',
    group: 'Tools',
    matcher: { hint: 'Tool name (regex)', examples: COMMON_TOOL_MATCHERS },
  },
  PostToolBatch: {
    label: 'Post Tool Batch',
    description: 'After a batch of parallel tool calls resolves, before the next model call',
    group: 'Tools',
    matcher: false,
  },
  PermissionRequest: {
    label: 'Permission Request',
    description: 'A tool call needs a permission decision',
    group: 'Permissions',
    matcher: { hint: 'Tool name (regex)', examples: COMMON_TOOL_MATCHERS },
  },
  PermissionDenied: {
    label: 'Permission Denied',
    description: 'A tool call is denied by the auto-mode classifier',
    group: 'Permissions',
    matcher: { hint: 'Tool name (regex)', examples: COMMON_TOOL_MATCHERS },
  },
  SubagentStart: {
    label: 'Subagent Start',
    description: 'A subagent is spawned',
    group: 'Subagents & Tasks',
    matcher: { hint: 'Agent type', examples: ['general-purpose', 'Explore', 'Plan'] },
  },
  SubagentStop: {
    label: 'Subagent Stop',
    description: 'A subagent finishes',
    group: 'Subagents & Tasks',
    matcher: { hint: 'Agent type', examples: ['general-purpose', 'Explore', 'Plan'] },
  },
  TaskCreated: {
    label: 'Task Created',
    description: 'A task is created via TaskCreate',
    group: 'Subagents & Tasks',
    matcher: false,
  },
  TaskCompleted: {
    label: 'Task Completed',
    description: 'A task is marked completed',
    group: 'Subagents & Tasks',
    matcher: false,
  },
  TeammateIdle: {
    label: 'Teammate Idle',
    description: 'An agent-team teammate is about to go idle',
    group: 'Subagents & Tasks',
    matcher: false,
  },
  PreCompact: {
    label: 'Pre Compact',
    description: 'Before context compaction',
    group: 'Context',
    matcher: { hint: 'What triggered compaction', examples: ['manual', 'auto'] },
  },
  PostCompact: {
    label: 'Post Compact',
    description: 'After context compaction completes',
    group: 'Context',
    matcher: { hint: 'What triggered compaction', examples: ['manual', 'auto'] },
  },
  InstructionsLoaded: {
    label: 'Instructions Loaded',
    description: 'A CLAUDE.md or .claude/rules/*.md file is loaded into context',
    group: 'Context',
    matcher: {
      hint: 'Load reason',
      examples: ['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact'],
    },
  },
  ConfigChange: {
    label: 'Config Change',
    description: 'A configuration file changes during a session',
    group: 'Workspace',
    matcher: {
      hint: 'Configuration source',
      examples: ['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills'],
    },
  },
  CwdChanged: {
    label: 'Directory Changed',
    description: 'The working directory changes',
    group: 'Workspace',
    matcher: false,
  },
  DirectoryAdded: {
    label: 'Directory Added',
    description: 'A working directory is added mid-session via /add-dir',
    group: 'Workspace',
    matcher: { hint: 'How the directory was added', examples: ['slash_command', 'register_repo_root'] },
  },
  FileChanged: {
    label: 'File Changed',
    description: 'A watched file changes on disk',
    group: 'Workspace',
    matcher: { hint: 'Literal filenames to watch', examples: ['.envrc|.env', 'package.json'] },
  },
  WorktreeCreate: {
    label: 'Worktree Create',
    description: 'A worktree is created via --worktree, isolation: "worktree", or a background session',
    group: 'Workspace',
    matcher: false,
  },
  WorktreeRemove: {
    label: 'Worktree Remove',
    description: 'A worktree is removed at session exit or when a subagent finishes',
    group: 'Workspace',
    matcher: false,
  },
  Notification: {
    label: 'Notification',
    description: 'Claude Code sends a notification',
    group: 'Notifications',
    matcher: {
      hint: 'Notification type',
      examples: ['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog'],
    },
  },
  Elicitation: {
    label: 'Elicitation',
    description: 'An MCP server requests user input during a tool call',
    group: 'MCP',
    matcher: { hint: 'MCP server name', examples: ['context7', 'serena'] },
  },
  ElicitationResult: {
    label: 'Elicitation Result',
    description: 'After you respond to an MCP elicitation, before the response goes back',
    group: 'MCP',
    matcher: { hint: 'MCP server name', examples: ['context7', 'serena'] },
  },
};

/** Whether the CLI honours a `matcher` on this event. */
export function eventSupportsMatcher(event: HookEvent): boolean {
  return HOOK_EVENT_INFO[event].matcher !== false;
}

/**
 * Events bucketed for the picker, in `HOOK_EVENT_GROUPS` order (lifecycle,
 * not alphabetical) with events in `HOOK_EVENTS` order inside each bucket.
 */
export function groupedHookEvents(): [HookEventGroup, HookEvent[]][] {
  return HOOK_EVENT_GROUPS.map((group) => [
    group,
    HOOK_EVENTS.filter((e) => HOOK_EVENT_INFO[e].group === group),
  ]);
}

export interface ClaudeSettingsWithHooks {
  hooks?: HooksConfiguration;
  [key: string]: any;
}

export interface HookValidationError {
  event: string;
  matcher?: string;
  command?: string;
  message: string;
}

export interface HookValidationWarning {
  event: string;
  matcher?: string;
  command: string;
  message: string;
}

export interface HookValidationResult {
  valid: boolean;
  errors: HookValidationError[];
  warnings: HookValidationWarning[];
}

export type HookScope = 'user' | 'project' | 'local';

// Hook templates
export interface HookTemplate {
  id: string;
  name: string;
  description: string;
  event: HookEvent;
  matcher?: string;
  commands: string[];
}

export const HOOK_TEMPLATES: HookTemplate[] = [
  {
    id: 'log-bash-commands',
    name: 'Log Shell Commands',
    description: 'Log all bash commands to a file for auditing',
    event: 'PreToolUse',
    matcher: 'Bash',
    // NOTE: jq's string-interpolation syntax is `\(...)` (e.g.
    // `"\(.tool_input.command)"`). To put a literal `\(` in this JS
    // source string we'd need `\\(`. The original author wrote `\(`,
    // which JS resolves to `(`, so the resulting jq command logs the
    // literal text instead of interpolating. Removing the unnecessary
    // JS escapes here matches today's runtime exactly; users who want
    // real interpolation should swap `(` → `\\(` in their hook.
    commands: ['jq -r \'"(.tool_input.command) - (.tool_input.description // "No description")"\' >> ~/.claude/bash-command-log.txt']
  },
  {
    id: 'format-on-save',
    name: 'Auto-format Code',
    description: 'Run code formatters after file modifications',
    event: 'PostToolUse',
    matcher: 'Write|Edit|MultiEdit',
    commands: [
      'if [[ "$( jq -r .tool_input.file_path )" =~ \\.(ts|tsx|js|jsx)$ ]]; then prettier --write "$( jq -r .tool_input.file_path )"; fi',
      'if [[ "$( jq -r .tool_input.file_path )" =~ \\.go$ ]]; then gofmt -w "$( jq -r .tool_input.file_path )"; fi'
    ]
  },
  {
    id: 'git-commit-guard',
    name: 'Protect Main Branch',
    description: 'Prevent direct commits to main/master branch',
    event: 'PreToolUse',
    matcher: 'Bash',
    commands: ['if [[ "$(jq -r .tool_input.command)" =~ "git commit" ]] && [[ "$(git branch --show-current 2>/dev/null)" =~ ^(main|master)$ ]]; then echo "Direct commits to main/master branch are not allowed"; exit 2; fi']
  },
  {
    id: 'custom-notification',
    name: 'Custom Notifications',
    description: 'Send custom notifications when Claude needs attention',
    event: 'Notification',
    commands: ['osascript -e "display notification \\"$(jq -r .message)\\" with title \\"$(jq -r .title)\\" sound name \\"Glass\\""']
  },
  {
    id: 'continue-on-tests',
    name: 'Auto-continue on Test Success',
    description: 'Automatically continue when tests pass',
    event: 'Stop',
    commands: ['if grep -q "All tests passed" "$( jq -r .transcript_path )"; then echo \'{"decision": "block", "reason": "All tests passed. Continue with next task."}\'; fi']
  }
]; 

// Fixture content for each message kind in the Appearance preview.
// Keyed by registry id (KIND_REGISTRY keys). Keep entries short — a card
// worth of text, not a full stream.

export const KIND_FIXTURES: Record<string, string> = {
  // ── user ──
  "user.prompt": "Can you refactor the auth middleware to use the new token format?",
  "user.command": "/verify",
  "user.commandOutput": "✓ TypeScript check passed · ✓ Tests passed (42/42)",
  "user.subagentPrompt": "Subagent: review src/auth/*.ts for security issues and report findings.",
  "user.skillInjection": "# Code-Review Skill\nYou are a senior code reviewer. Look for correctness, clarity, and edge-case handling.",
  "user.systemContext": "You are a code-review subagent. Check src/auth/*.ts for security issues.",
  "user.sdkSystemBracket": "[Request interrupted by user]",
  "user.tool-result": "The file src/auth/middleware.ts has been updated successfully.",
  "user.image": "(image attachment)",

  // ── agent ──
  "assistant.text": "I'll update `auth.ts` to read the new token format and add a migration helper. Starting with the tests now.",
  "assistant.text.endTurn": "Done — auth middleware now reads the new token format and tests pass.",
  "assistant.thinking": "Let me think about backwards compatibility before touching the auth flow. Existing sessions must not break.",
  "assistant.tool-use": "Edit · src/auth/middleware.ts",
  "assistant.askUserQuestion": "The function name is ambiguous — did you mean `validateToken` or `verifyToken`?",

  // ── system ──
  "system.notification.info": "Session ready. Model: claude-opus-4-7. Dir: /Users/greg/Repos/omnifex. 14 tools (6 MCP).",
  "system.notification.warn": "Approaching context limit — consider compacting the conversation.",
  "system.notification.error": "503 Service Unavailable from api.anthropic.com — retrying.",
  "system.notification.stop": "Stopped by user request.",
  "system.hook_started": "Hook: PreToolUse · Bash",
  "system.hook_response": "Hook response: approved (0 ms)",
  "system.permission_denied": "Permission denied: Bash · rm -rf /tmp/scratch",
  "system.userPromptSubmit": "UserPromptSubmit · 1 message",
  "system.api_error": "503 Service Unavailable from api.anthropic.com — retrying.",
  "system.unknown": "(unrecognized system subtype — raw payload shown above)",
  "permission.request": "Allow Bash to run: git diff HEAD~1 --stat?",
  "permission.askUserQuestion": "Should I proceed with the destructive rename, or create a copy first?",
  "summary.compaction": "Earlier the user asked to refactor auth; the agent edited middleware.ts and added tests.",
  "unknown": "(unrecognized message type — raw payload shown above)",

  // ── bookkeeping (real JSONL lines) ──
  "permission-mode": "Permission → acceptEdits",
  "last-prompt": "Bookmarked prompt",
  "ai-title": 'Session titled "Refactor auth"',
  "queue-operation": "Background: enqueue",
  "file-history-snapshot": "File snapshot",

  // ── synthetic control-change markers ──
  "control.effort": "Effort → high",
  "control.model": "Model → opus",
  "control.permission": "Permission → acceptEdits",
};

export function previewTextForKindId(kindId: string): string {
  return KIND_FIXTURES[kindId] ?? "(no preview available)";
}

/** Preview text for a category, keyed by category name. */
export const CATEGORY_FIXTURES: Record<string, string> = {
  user: "Can you refactor the auth middleware to use the new token format?",
  agent: "I'll update `auth.ts` to read the new token format and add a migration helper.",
  system: "Session ready. Model: claude-opus-4-7. 14 tools (6 MCP).",
};

export function previewTextForCategory(category: string): string {
  return CATEGORY_FIXTURES[category] ?? "(no preview available)";
}

// ─── fake turn ──────────────────────────────────────────────────────────────
// A representative sequence used in the compact/verbose turn preview, ordered
// to mirror a realistic turn: user sends → context injected → assistant thinks
// + acts → result lands → system notification.
// Every id must be a real KIND_REGISTRY key. Hidden-in-compact kinds collapse
// into a "Hidden Events" group in compact mode, exercising both variants.

export const FAKE_TURN_KIND_IDS: string[] = [
  // ── boundary-locked: always visible ──
  "user.prompt",               // card · right-aligned · compactBoundaryLocked

  // ── harness injections ──
  "user.systemContext",        // collapsible · visible in compact
  "user.skillInjection",      // collapsible · hidden in compact (agent default)

  // ── assistant turn ──
  "assistant.thinking",        // collapsible · hidden in compact
  "assistant.tool-use",        // card · hidden in compact
  "user.tool-result",          // side-line · hidden in compact
  "assistant.tool-use",        // card · hidden in compact (second tool call)
  "user.tool-result",          // side-line · hidden in compact
  "assistant.text",            // card · visible in compact (agent default)
  "assistant.text.endTurn",    // card · green completion · locked

  // ── system ──
  "system.notification.error", // card · visible in compact
  "system.api_error",          // card · visible in compact

  // ── unknown fallback ──
  "unknown",                   // side-line · dashed · visible in compact
];

// Fixture content for each message kind in the Appearance preview.
// Keep these short — a card worth of text, not a full stream.

export const KIND_FIXTURES: Record<string, string> = {
  // ── user ──
  "user.prompt": "Can you refactor the auth middleware to use the new token format?",
  "user.tool-result": "The file src/auth/middleware.ts has been updated successfully.",
  "user.systemContext": "You are a code-review subagent. Check src/auth/*.ts for security issues.",
  "user.command": "/verify",

  // ── assistant ──
  "assistant.text":
    "I'll update `auth.ts` to read the new token format and add a migration helper. Starting with the tests now.",
  "assistant.text.endTurn": "Done — auth middleware now reads the new token format and tests pass.",
  "assistant.thinking":
    "Let me think about backwards compatibility before touching the auth flow. Existing sessions must not break.",
  "assistant.tool-use": "Edit · src/auth/middleware.ts",

  // ── system ──
  "cli-stream-init":
    "Session ready. Model: claude-opus-4-7. Dir: /Users/greg/Repos/omnifex. 14 tools (6 MCP).",
  "system.notification.error": "503 Service Unavailable from api.anthropic.com — retrying.",
  "system.api_error": "503 Service Unavailable from api.anthropic.com — retrying.",
  "system.compact_boundary": "Conversation was compacted here.",
  "summary.compaction": "Earlier the user asked to refactor auth; the agent edited middleware.ts and added tests.",
  "cli-stream-result":
    "Turn result · success · 4.3 s · $0.0012",

  // ── attachment ──
  "attachment.todo_reminder": "Reminder: 3 todos still open in this session.",
  "attachment.diagnostics": "Diagnostics: 0 errors, 2 warnings in src/auth/middleware.ts.",

  // ── bookkeeping ──
  "pr-link": "github.com/greg/omnifex/pull/412 — Refactor auth middleware",
  "queue-operation": "queue-operation · enqueue",
  "permission-mode": "Permission mode changed to: acceptEdits",
  "last-prompt": "(last prompt bookmark)",
  "ai-title": "Refactor auth middleware",
  "file-history-snapshot": "file-history-snapshot · src/auth/middleware.ts",

  // ── unknown fallback ──
  "unknown": "(unrecognized message type — raw payload shown above)",
};

export function previewTextForKindId(kindId: string): string {
  return KIND_FIXTURES[kindId] ?? "(no preview available)";
}

/** Preview text for a category, keyed by category name. */
export const CATEGORY_FIXTURES: Record<string, string> = {
  user: "Can you refactor the auth middleware to use the new token format?",
  agent: "I'll update `auth.ts` to read the new token format and add a migration helper.",
  system: "Session ready. Model: claude-opus-4-7. 14 tools (6 MCP).",
  attachment: "Reminder: 3 todos still open in this session.",
  bookkeeping: "file-history-snapshot · src/auth/middleware.ts",
};

export function previewTextForCategory(category: string): string {
  return CATEGORY_FIXTURES[category] ?? "(no preview available)";
}

// ─── fake turn ──────────────────────────────────────────────────────────────
// A representative sequence used in the compact/verbose turn preview, ordered
// to mirror a realistic turn: user sends → context injected → assistant thinks
// + acts → result lands. Every id resolves through the v3 category model
// (originOf + category default ⊕ override). Hidden-in-compact kinds collapse
// into a "Hidden Events" group in compact mode, so both variants are exercised.

export const FAKE_TURN_KIND_IDS: string[] = [
  // ── boundary-locked: always visible ──
  "user.prompt",            // card · right-aligned · compactBoundaryLocked

  // ── harness injections ──
  "user.systemContext",     // collapsible · visible in compact (override)
  "attachment.todo_reminder", // collapsible · hidden in compact (attachment)

  // ── assistant turn ──
  "assistant.thinking",     // collapsible · hidden in compact (override)
  "assistant.tool-use",     // card · hidden in compact (override)
  "user.tool-result",       // side-line · hidden in compact (override)
  "assistant.tool-use",     // card · hidden in compact (second tool call)
  "user.tool-result",       // side-line · hidden in compact
  "assistant.text",         // card · visible in compact (agent default)
  "assistant.text.endTurn", // card · green completion · locked (override)

  // ── system ──
  "system.notification.error", // card · visible in compact (override)
  "system.api_error",          // card · visible in compact (override)

  // ── bookkeeping ──
  "pr-link",                // side-line · visible (override)

  // ── cli stream ──
  "cli-stream-result",      // card · hidden in compact (system default)

  // ── unknown fallback ──
  "unknown",                // side-line · dashed · visible in compact (override)
];

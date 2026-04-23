// Fixture content for each message kind in the Appearance preview.
// Keep these short — a card worth of text, not a full stream.

import type { MessageKindConfig } from "@/lib/messageRenderingConfig";

export const KIND_FIXTURES: Record<string, string> = {
  "user.prompt": "Can you refactor the auth middleware to use the new token format?",
  "user.image": "(pasted screenshot — 1024×768)",
  "user.subagentPrompt":
    "You are a code-review subagent. Review the diff in src/auth/*.ts for security issues.",
  "user.sdkSystemBracket": "[Request interrupted by user]",
  "user.systemContext":
    "CLAUDE.md loaded. Project conventions: TDD required, services in electron/services/, IPC via preload allow-list.",
  "assistant.text":
    "I'll update `auth.ts` to read the new token format and add a migration helper. Starting with the tests now.",
  "assistant.thinking":
    "The user wants me to change the auth flow. Let me think about backwards compatibility with existing sessions before I touch anything.",
  "assistant.toolUse": "Running: Edit src/auth/middleware.ts",
  "tool.result.generic": "The file src/auth/middleware.ts has been updated.",
  "tool.result.systemReminder":
    "Remember: integration tests must hit a real database, not mocks.",
  "result.success":
    "Successfully updated auth middleware and migration helper.\n\nTokens refreshed cleanly for the three sample sessions.",
  "result.error":
    "Failed to apply edit: file was modified since read. Please re-read and retry.",
  "system.init":
    "Session ready. Model: claude-opus-4-7. Working dir: /Users/greg/Repos/greychrist. 14 tools loaded (6 MCP).",
  "system.notification.error": "API rate limit reached — retrying in 30s",
  "system.notification.stop": "User interrupted execution",
  "system.notification.warn": "Tool call exceeded 10s — continuing",
  "system.notification.info": "Session resumed from transcript",
  "permission.request":
    "Claude wants to run: npm install @anthropic-ai/sdk. Allow this time?",
  "summary.compaction":
    "Turn summary: user asked to refactor auth middleware; agent edited three files and ran the test suite.",
};

export function previewTextForKind(kind: MessageKindConfig): string {
  return KIND_FIXTURES[kind.id] ?? "(no preview available)";
}

// ─── fake turn ──────────────────────────────────────────────────────────────
// A short realistic sequence used in the compact/verbose turn preview. Kind
// ids reference the same defaults.

export const FAKE_TURN_KIND_IDS: string[] = [
  "user.prompt",
  "user.systemContext",
  "assistant.thinking",
  "assistant.toolUse",
  "tool.result.generic",
  "assistant.toolUse",
  "tool.result.generic",
  "assistant.text",
  "result.success",
];

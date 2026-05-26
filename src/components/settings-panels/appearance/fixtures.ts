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
  "assistant.tool-use": "Running: Edit src/auth/middleware.ts",
  "tool.result.generic": "The file src/auth/middleware.ts has been updated.",
  "tool.result.systemReminder":
    "Remember: integration tests must hit a real database, not mocks.",
  "result.success":
    "Successfully updated auth middleware and migration helper.\n\nTokens refreshed cleanly for the three sample sessions.",
  "result.error":
    "Failed to apply edit: file was modified since read. Please re-read and retry.",
  "result.awaiting_background":
    "Will be notified when verify completes.",
  "system.init":
    "Session ready. Model: claude-opus-4-7. Working dir: /Users/greg/Repos/omnifex. 14 tools loaded (6 MCP).",
  "system.notification.error": "API rate limit reached — retrying in 30s",
  "system.notification.stop": "User interrupted execution",
  "system.notification.warn": "Tool call exceeded 10s — continuing",
  "system.notification.info": "Session resumed from transcript",
  "permission.request":
    "Claude wants to run: npm install @anthropic-ai/sdk. Allow this time?",
  "permission.askUserQuestion":
    "Which library should we use for date formatting? (Choose: date-fns, dayjs, luxon, Other)",
  "summary.compaction":
    "Turn summary: user asked to refactor auth middleware; agent edited three files and ran the test suite.",
};

export function previewTextForKind(kind: MessageKindConfig): string {
  return KIND_FIXTURES[kind.id] ?? "(no preview available)";
}

// Raw SDK type/subtype labels matching what the renderer's debug overlay
// shows on each kind. Used in SamplePreview when the debug toggle is on so
// the preview's bottom-left label matches what the live cards print.
export const KIND_DEBUG_LABELS: Record<string, string> = {
  "user.prompt": "user",
  "user.image": "user",
  "user.subagentPrompt": "user",
  "user.sdkSystemBracket": "user",
  "user.systemContext": "user",
  "assistant.text": "assistant",
  "assistant.thinking": "assistant",
  "assistant.tool-use": "assistant",
  "tool.result.generic": "user",
  "tool.result.systemReminder": "user",
  "result.success": "result · success",
  "result.error": "result · error",
  "result.awaiting_background": "result · success (bg)",
  "system.init": "system · init",
  "system.notification.error": "system · notification",
  "system.notification.stop": "system · notification",
  "system.notification.warn": "system · notification",
  "system.notification.info": "system · notification",
  "permission.request": "permission_request",
  "permission.askUserQuestion": "permission_request · AskUserQuestion",
  "summary.compaction": "summary",
};

export function debugLabelForKind(kind: MessageKindConfig): string {
  return KIND_DEBUG_LABELS[kind.id] ?? kind.id;
}

// Fixed sample timestamp shown on every preview card, formatted to match
// the live renderer's CardTimestamp output (M/D/YY H:MM:SS AM/PM).
export const SAMPLE_TIMESTAMP = "4/29/26 12:34:56 PM";

// ─── fake turn ──────────────────────────────────────────────────────────────
// A short realistic sequence used in the compact/verbose turn preview. Kind
// ids reference the same defaults.

export const FAKE_TURN_KIND_IDS: string[] = [
  "user.prompt",
  "user.systemContext",
  "assistant.thinking",
  "assistant.tool-use",
  "tool.result.generic",
  "assistant.tool-use",
  "tool.result.generic",
  "assistant.text",
  "result.success",
];

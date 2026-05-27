// Fixture content for each message kind in the Appearance preview.
// Keep these short — a card worth of text, not a full stream.

import type { MessageKindConfig } from "@/lib/messageRenderingConfig";

export const KIND_FIXTURES: Record<string, string> = {
  // ── user ──
  "user.prompt": "Can you refactor the auth middleware to use the new token format?",
  "user.tool-result": "The file src/auth/middleware.ts has been updated successfully.",
  "user.meta.skill": "You are a code-review subagent. Check src/auth/*.ts for security issues.",
  "user.meta.attachment": "(pasted screenshot — 1024×768 PNG)",
  "user.meta.other": "[harness injection — meta record]",

  // ── assistant ──
  "assistant.text":
    "I'll update `auth.ts` to read the new token format and add a migration helper. Starting with the tests now.",
  "assistant.thinking":
    "Let me think about backwards compatibility before touching the auth flow. Existing sessions must not break.",
  "assistant.tool-use": "Edit · src/auth/middleware.ts",

  // ── system ──
  "system.init":
    "Session ready. Model: claude-opus-4-7. Dir: /Users/greg/Repos/omnifex. 14 tools (6 MCP).",
  "system.notification": "API rate limit reached — retrying in 30 s.",
  "system.api_error": "503 Service Unavailable from api.anthropic.com — retrying.",
  "system.stop_hook_summary": "Stop hook ran: verify passed (2.1 s).",
  "system.local_command": "/verify",
  "system.turn_duration": "Turn completed in 4.3 s.",
  "system.away_summary": "While you were away: agent edited 3 files and ran the test suite.",
  "system.compact_boundary": "Conversation was compacted here.",
  "system.informational": "Context window is 72% full.",

  // ── cli stream ──
  "cli-stream-init":
    "Engine-mode init · claude-opus-4-7 · /Users/greg/Repos/omnifex",
  "cli-stream-result":
    "Turn result · success · 4.3 s · $0.0012",

  // ── bookkeeping ──
  "attachment": "attachment · queued_command (task launch)",
  "queue-operation": "queue-operation · enqueue",
  "permission-mode": "Permission mode changed to: acceptEdits",
  "last-prompt": "(last prompt bookmark)",
  "ai-title": "Refactor auth middleware",
  "file-history-snapshot": "file-history-snapshot · src/auth/middleware.ts",

  // ── unknown fallback ──
  "unknown": "(unrecognized message type — raw payload shown above)",
};

export function previewTextForKind(kind: MessageKindConfig): string {
  return KIND_FIXTURES[kind.id] ?? "(no preview available)";
}

// Raw SDK type/subtype labels matching what the renderer's debug overlay
// shows on each kind. Used in SamplePreview when the debug toggle is on so
// the preview's bottom-left label matches what the live cards print.
export const KIND_DEBUG_LABELS: Record<string, string> = {
  // user
  "user.prompt": "user",
  "user.tool-result": "user · tool_result",
  "user.meta.skill": "user · meta · skill",
  "user.meta.attachment": "user · meta · attachment",
  "user.meta.other": "user · meta · other",
  // assistant
  "assistant.text": "assistant",
  "assistant.thinking": "assistant · thinking",
  "assistant.tool-use": "assistant · tool_use",
  // system
  "system.init": "system · init",
  "system.notification": "system · notification",
  "system.api_error": "system · api_error",
  "system.stop_hook_summary": "system · stop_hook_summary",
  "system.local_command": "system · local_command",
  "system.turn_duration": "system · turn_duration",
  "system.away_summary": "system · away_summary",
  "system.compact_boundary": "system · compact_boundary",
  "system.informational": "system · informational",
  // cli stream
  "cli-stream-init": "system · init (engine-mode)",
  "cli-stream-result": "result (engine-mode)",
  // bookkeeping
  "attachment": "attachment",
  "queue-operation": "queue-operation",
  "permission-mode": "permission-mode",
  "last-prompt": "last-prompt",
  "ai-title": "ai-title",
  "file-history-snapshot": "file-history-snapshot",
  // fallback
  "unknown": "unknown",
};

export function debugLabelForKind(kind: MessageKindConfig): string {
  return KIND_DEBUG_LABELS[kind.id] ?? kind.id;
}

// Fixed sample timestamp shown on every preview card, formatted to match
// the live renderer's CardTimestamp output (M/D/YY H:MM:SS AM/PM).
export const SAMPLE_TIMESTAMP = "4/29/26 12:34:56 PM";

// ─── fake turn ──────────────────────────────────────────────────────────────
// A representative sequence used in the compact/verbose turn preview. One
// entry per major kind in the v2 catalog, ordered to mirror a realistic turn:
// user sends → skill is injected → assistant thinks + acts → result lands.
// Hidden-in-compact kinds collapse into a "Hidden Events" group in compact
// mode, so both visual variants are exercised.
//
// IDs must match the keys in DEFAULT_KINDS (see messageRenderingConfig.ts).

export const FAKE_TURN_KIND_IDS: string[] = [
  // ── boundary-locked: always visible ──
  "user.prompt",          // card · right-aligned · compactBoundaryLocked

  // ── harness injections (side-line) ──
  "user.meta.skill",      // side-line · visible in compact
  "user.meta.attachment", // side-line · hidden in compact

  // ── assistant turn (cards + side-lines) ──
  "assistant.thinking",   // card · hidden in compact
  "assistant.tool-use",   // card · hidden in compact
  "user.tool-result",     // side-line · hidden in compact
  "assistant.tool-use",   // card · hidden in compact (second tool call)
  "user.tool-result",     // side-line · hidden in compact
  "assistant.text",       // card · visible in compact

  // ── system ──
  "system.notification",      // card · visible in compact
  "system.api_error",         // card · visible in compact
  "system.stop_hook_summary", // side-line · hidden in compact

  // ── bookkeeping (side-line, hidden) ──
  "attachment",           // side-line · hidden in compact

  // ── cli stream (side-line, hidden) ──
  "cli-stream-result",    // side-line · hidden in compact

  // ── unknown fallback (dashed border) ──
  "unknown",              // side-line · dashed · visible in compact
];

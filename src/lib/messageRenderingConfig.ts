// Message-rendering config — data model, defaults, and live resolver.
//
// This module is the source of truth for message-kind styling. It owns:
//   • KIND_REGISTRY — maps kind id → category + built-in default chrome.
//   • resolveKind — three-layer merge: category base → registry default →
//     per-kind user patch (config.kinds[id]). All rendering decisions go
//     through this single function.
// The settings screen reads and writes this config via
// `api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, ...)`.

import { migrateV5 } from "./renderingConfigMigration";
import { hexChroma, hexHue, NEUTRAL_CHROMA } from "./colorHue";
import { isTypefaceId, type Typeface } from "./typefaceCatalog";

/**
 * v6 has a key of its own. The dev build and the installed app share one
 * database, and an installed app from before v6 resets anything under the
 * v5 key that is not v5 — so v6 written there would have wiped the settings
 * for both. The v5 key is only read, to migrate from, and never written.
 */
export const MESSAGE_RENDERING_CONFIG_KEY = "message_rendering_config_v6";
/** Where v5 lived; read once to migrate, never written. */
export const LEGACY_MESSAGE_RENDERING_CONFIG_KEY = "message_rendering_config";

// ─── legacy palette names ──────────────────────────────────────────────────
//
// Every color is a hex. There used to be a named palette (Appearance ›
// Palette) that kinds, categories and tab indicators referred to by name; it
// was retired 2026-10-08, when nothing referenced it but four categories and
// the built-in defaults. Saved configs and exported files still carry those
// names, so they are converted on load — through the saved palette's own swatch
// when it had one, else through this table, which is the palette as shipped.

const LEGACY_PALETTE_SWATCHES: Readonly<Record<string, string>> = {
  primary: "#8b8b8b",
  blue: "#60a5fa",
  amber: "#f59e0b",
  green: "#22c55e",
  red: "#ef4444",
  gray: "#6b7280",
  muted: "#4b5563",
  info: "#9ca3af",
  sysInit: "#3b82f6",
  purple: "#a855f7",
  orange: "#f97316",
  teal: "#14b8a6",
  pink: "#ec4899",
  indigo: "#6366f1",
  cyan: "#06b6d4",
  yellow: "#eab308",
  lime: "#84cc16",
  brown: "#92400e",
  chocolate: "#78350f",
  tan: "#d4a574",
  black: "#171717",
};

/** Name → hex for a saved config: its own palette swatches over the shipped ones. */
function legacySwatches(savedPalette: unknown): Record<string, string> {
  const out: Record<string, string> = { ...LEGACY_PALETTE_SWATCHES };
  if (!isRecord(savedPalette)) return out;
  for (const name of Object.keys(out)) {
    const entry = savedPalette[name];
    if (isRecord(entry) && isHexColor(entry.swatch)) out[name] = entry.swatch;
  }
  return out;
}

/** A saved color as a hex: kept when it is one, converted when it is a legacy
 *  palette name, undefined otherwise. */
function savedColor(v: unknown, swatches: Record<string, string>): string | undefined {
  if (isHexColor(v)) return v;
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(swatches, v) ? swatches[v] : undefined;
}

// ─── icon allow-list ────────────────────────────────────────────────────────
//
// Strings only — the renderer maps these to actual components. Keeping an
// allow-list prevents a config value from bloating the bundle with unused
// Lucide icons.

export const ALLOWED_ICONS = [
  // Originals
  "User",
  "Bot",
  "Terminal",
  "Settings",
  "Info",
  "CheckCircle2",
  "AlertCircle",
  "CircleStop",
  "Pencil",
  "CheckSquare",
  "ListChecks",
  "ListTree",
  "FolderTree",
  "FileText",
  "FilePlus",
  "Search",
  "Globe",
  "Download",
  "Plug",
  // People / chat
  "MessageCircle",
  "MessageSquare",
  "Send",
  "Mail",
  "AtSign",
  "CircleHelp",
  // Status / feedback
  "ShieldCheck",
  "ShieldX",
  "Eye",
  "EyeOff",
  "Lock",
  "Unlock",
  "Flag",
  "Bookmark",
  "Star",
  "Heart",
  // Code / tech
  "Code",
  "Code2",
  "Braces",
  "Hash",
  "Cpu",
  "Database",
  "Server",
  "GitBranch",
  "GitCommit",
  // Creative / thinking
  "Sparkles",
  "Lightbulb",
  "Brain",
  "Feather",
  "PenTool",
  "Palette",
  // Objects / cards
  "Package",
  "Box",
  "Tag",
  "Clipboard",
  "ClipboardList",
  "BookOpen",
  "Book",
  // Fun / personality
  "Rocket",
  "Coffee",
  "Ghost",
  "Cat",
  "Dog",
  "Moon",
  "Sun",
  "Wand",
  "Crown",
  // Misc symbols
  "Circle",
  "Square",
  "Hexagon",
  "Triangle",
  "Zap",
  "Flame",
  "Smile",
  "Hourglass",
  // v2 catalog additions
  "AlertOctagon",
  "AlertTriangle",
  "Bell",
  "Camera",
  "Check",
  "CheckCheck",
  "ChevronRight",
  "Clock",
  "HelpCircle",
  "Hook",
  "Image",
  "ListOrdered",
  "Paperclip",
  "Power",
  "Scissors",
  "Shield",
  "ShieldOff",
  "ImageUp",
  "MonitorCog",
  "Slash",
  // v3 catalog additions
  "GitPullRequest",
  "ShieldQuestion",
  "MessageCircleQuestion",
  // Modern step icons (Settings › Chats › Modern)
  "GitCommitHorizontal",
  "FilePen",
  "FolderSearch",
  "ListTodo",
  "Wrench",
  "Workflow",
  // Unicode fallbacks
  "ℹ",
  "✗",
  "⚠",
  "none",
] as const;

export type IconName = (typeof ALLOWED_ICONS)[number];

// ─── message kinds ──────────────────────────────────────────────────────────

// ─── category + kind registry model ─────────────────────────────────────────
//
// Three-layer model: CATEGORIES carry default styling for all kinds in them;
// KIND_REGISTRY carries built-in per-kind chrome layered on top; and
// config.kinds carries sparse user patches as the final layer.
// resolveKind(config, id) merges all three and is the single source of
// truth for every kind's effective style.

/**
 * `live` holds the kinds a reload loses: records the CLI sends on stream-json
 * stdout and never writes to the session file, plus OmniFex's own synthetic
 * live-session markers. Which system subtypes those are is decided main-side
 * by stream-forward's JSONL_CARRIED_SYSTEM_SUBTYPES, and liveOnlyKinds.test.ts
 * pins this registry to it. Kind ids keep their `system.` prefix — the
 * section moved, the ids did not, so saved per-kind overrides still apply.
 */
export const CATEGORIES = ["user", "agent", "system", "live"] as const;
export type Category = (typeof CATEGORIES)[number];

/** What a kind looks like and whether Standard shows it. Shared by
 *  categories and kind registry entries; identity fields
 *  (id/label/description) are NOT here. */
export interface KindStyle {
  accentColor: string;
  icon: IconName;
  /** Drawn in Standard. Expanded draws every record whatever this says. */
  standard: boolean;
  /** A turn boundary: on screen in Standard whatever `standard` says. */
  alwaysShown?: boolean;
}

/**
 * How repeats of a kind fold down to the rows worth drawing (see
 * collapseRepeats.ts). Fixed per kind — which field a kind changes on is a
 * fact about the CLI record, not a preference — while whether to apply it is
 * the user's `collapseRepeats` choice.
 *
 *  - `latestInRun`: the record re-sends a whole snapshot; keep the last of
 *    each run, a run ending at the first non-system message.
 *  - `onChange`: the record re-sends one value unchanged; keep a row only
 *    when `field` differs from the kind's previous row.
 */
export type CollapseRule =
  | { mode: "latestInRun" }
  /** `onlyIn`: the views the rule applies in; absent means both. Expanded
   *  is the raw record stream, so a rule that only tidies re-stamped
   *  bookkeeping leaves it alone. */
  | { mode: "onChange"; field: string; onlyIn?: ViewMode[] };

export interface CategoryStyle extends KindStyle {
  label: string;
  description: string;
}

export interface KindDef {
  id: string;
  category: Category;
  label: string;
  description: string;
  /** Built-in chrome for this kind, layered over the category base. */
  default: Partial<KindStyle>;
  collapse?: CollapseRule;
}

export const KIND_REGISTRY: Record<string, KindDef> = {
  // ── agent ──
  "assistant.text": { id: "assistant.text", category: "agent", label: "Assistant text", description: "Claude's reply text.", default: {} },
  "assistant.text.endTurn": { id: "assistant.text.endTurn", category: "agent", label: "Execution complete", description: "Final assistant text that ended the turn.", default: { accentColor: "#22c55e", icon: "CheckCircle2", alwaysShown: true } },
  "assistant.text.live": { id: "assistant.text.live", category: "agent", label: "Live reply", description: "Claude's reply while it is still arriving, a few words at a time. Replaced by the finished message — which may or may not be the one that ends the turn.", default: { accentColor: "#f59e0b" } },
  "assistant.thinking": { id: "assistant.thinking", category: "agent", label: "Thinking", description: "Extended-thinking blocks.", default: { icon: "Brain", standard: true } },
  "assistant.tool-use": { id: "assistant.tool-use", category: "agent", label: "Tool call", description: "Claude invoking a tool.", default: { accentColor: "#9ca3af", icon: "Terminal", standard: true } },
  "assistant.askUserQuestion": { id: "assistant.askUserQuestion", category: "agent", label: "Question (answered)", description: "An answered AskUserQuestion card.", default: { accentColor: "#6366f1", icon: "MessageCircleQuestion", standard: true } },
  // ── user ──
  "user.prompt": { id: "user.prompt", category: "user", label: "User prompt", description: "What you typed.", default: { alwaysShown: true } },
  "user.command": { id: "user.command", category: "user", label: "Slash command", description: "A `/command` you ran.", default: { icon: "ChevronRight" } },
  "user.commandOutput": { id: "user.commandOutput", category: "user", label: "Command output", description: "Local stdout from a slash command.", default: { standard: false } },
  "user.subagentPrompt": { id: "user.subagentPrompt", category: "user", label: "Subagent prompt", description: "A prompt generated for a subagent.", default: { accentColor: "#f59e0b", icon: "Bot" } },
  "user.skillInjection": { id: "user.skillInjection", category: "user", label: "Skill injection", description: "Skill body injected into the conversation.", default: { accentColor: "#a855f7", icon: "Sparkles" } },
  "user.systemContext": { id: "user.systemContext", category: "user", label: "System context", description: "Hook feedback, system-reminders, skill preambles.", default: { accentColor: "#a855f7", icon: "Sparkles", standard: true } },
  "user.taskNotification": { id: "user.taskNotification", category: "user", label: "Task notification", description: "A background task reporting in — not something you typed.", default: { accentColor: "#06b6d4", icon: "Bell", standard: false } },
  "user.coordinatorMessage": { id: "user.coordinatorMessage", category: "user", label: "Coordinator message", description: "An orchestrator messaging a subagent mid-run.", default: { accentColor: "#f59e0b", icon: "MessageSquare", standard: false } },
  "user.sdkSystemBracket": { id: "user.sdkSystemBracket", category: "user", label: "System notice", description: "CLI bracket notices like [Request interrupted].", default: { icon: "Info" } },
  "user.tool-result": { id: "user.tool-result", category: "user", label: "Tool result", description: "Output returned from a tool call.", default: { standard: false } },
  // Its own row rather than folding into `user.tool-result`: that kind defaults
  // to verbose-only visibility, which would bury every screenshot a tool returns. Split
  // out so images can be styled and shown/hidden independently of ordinary tool
  // output. Visible in compact by default — a screenshot is usually the point
  // of the call, not plumbing.
  // `card`, not the `side-line` that plain tool results use: side-line renders
  // no header and no footer chip, which is why these read as "not the same
  // component" next to every other message. A returned screenshot is content
  // worth framing, so it gets the standard card chrome and a title.
  "user.tool-result.image": { id: "user.tool-result.image", category: "user", label: "Tool result image", description: "A screenshot or image returned by a tool.", default: { accentColor: "#6366f1", icon: "Image", standard: true } },
  "user.image": { id: "user.image", category: "user", label: "Image", description: "A pasted or attached image.", default: { icon: "Image" } },
  // The CLI writes the /compact summary as a `user` record, so without its own
  // kind it renders as something you typed — a wall of recap text wearing your
  // color. Left-aligned and collapsible because it is long by construction
  // and is reference material, not conversation. Visible in compact view: it
  // marks where the earlier history stops existing, which is exactly the thing
  // you are looking for when scanning a long session.
  "user.compactSummary": { id: "user.compactSummary", category: "user", label: "Compact summary", description: "The recap written when a session is compacted.", default: { accentColor: "#14b8a6", icon: "Scissors", standard: true } },
  // ── system ──
  "system.notification.info": { id: "system.notification.info", category: "live", label: "Notification (info)", description: "Informational CLI notification.", default: { icon: "Bell", standard: true } },
  "system.notification.warn": { id: "system.notification.warn", category: "live", label: "Notification (warn)", description: "Warning CLI notification.", default: { accentColor: "#f59e0b", icon: "Bell", standard: true } },
  "system.notification.error": { id: "system.notification.error", category: "live", label: "Notification (error)", description: "Error CLI notification.", default: { accentColor: "#ef4444", icon: "Bell", standard: true } },
  "system.notification.stop": { id: "system.notification.stop", category: "live", label: "Notification (stop)", description: "Stop CLI notification.", default: { accentColor: "#ef4444", icon: "Bell", standard: true } },
  "system.hook_started": { id: "system.hook_started", category: "live", label: "Hook started", description: "A hook began running.", default: { icon: "Hook", standard: false } },
  "system.hook_response": { id: "system.hook_response", category: "live", label: "Hook response", description: "A hook returned.", default: { icon: "Hook", standard: false } },
  "system.hook_progress": { id: "system.hook_progress", category: "live", label: "Hook progress", description: "Output a hook printed while it was still running.", default: { icon: "Hook", standard: false } },
  "system.permission_denied": { id: "system.permission_denied", category: "live", label: "Permission denied", description: "A tool permission was denied.", default: { accentColor: "#ef4444", icon: "ShieldX", standard: true } },
  "system.userPromptSubmit": { id: "system.userPromptSubmit", category: "live", label: "Prompt submitted", description: "UserPromptSubmit lifecycle envelope.", default: { icon: "Send" } },
  "system.api_error": { id: "system.api_error", category: "system", label: "API error", description: "An API or tool error.", default: { accentColor: "#ef4444", icon: "AlertTriangle", standard: true } },
  "system.away_summary": { id: "system.away_summary", category: "system", label: "Away summary", description: "A recap of where the session stands — the CLI's own while you were away, or /recap's (the Recap button and auto-recap).", default: { accentColor: "#9ca3af", icon: "ClipboardList", standard: true } },
  "system.thinking_tokens": { id: "system.thinking_tokens", category: "live", label: "Thinking tokens", description: "Total size of each extended-thinking burst. The live running count is the session widget's activity pill, not this row.", default: { accentColor: "#4b5563", icon: "Brain", standard: true }, collapse: { mode: "latestInRun" } },
  "system.rate_limit": { id: "system.rate_limit", category: "live", label: "Rate limit", description: "A rate_limit_event line reporting usage-window status (allowed/warning/rejected, reset time, overage).", default: { accentColor: "#4b5563", icon: "Shield", standard: false } },
  // Top-level `progress` record. Shown by default: none has ever been seen on
  // disk, so if the CLI starts writing them, seeing them is the point. Set it
  // to Never in Appearance if they turn out to be noise.
  "system.progress": { id: "system.progress", category: "live", label: "Progress", description: "A progress record the CLI wrote to the transcript — hook, agent, skill or bash progress, or a tool heartbeat — with its fields.", default: { accentColor: "#4b5563", icon: "Terminal", standard: true } },
  "system.feedback_draft_queued": { id: "system.feedback_draft_queued", category: "live", label: "Feedback draft", description: "The SendFeedback tool queued a local draft feedback report for you to review with /feedback.", default: { accentColor: "#eab308", icon: "Flag", standard: true } },
  "system.local_command": { id: "system.local_command", category: "system", label: "Local command output", description: "What a slash command that runs in the CLI printed — /usage, /cost, /context. Claude Code 2.1.283+ writes it as a system record; older transcripts use Command output.", default: { icon: "Terminal", standard: true } },
  "system.stop_hook_summary": { id: "system.stop_hook_summary", category: "system", label: "Stop hooks", description: "The Stop hooks that ran as a turn ended — each by file and duration, plus any error and whether one blocked the stop.", default: { accentColor: "#4b5563", icon: "Hook", standard: false } },
  "system.compact_boundary": { id: "system.compact_boundary", category: "system", label: "Compaction", description: "Where a compaction cut the conversation — what triggered it, how far context shrank and how long it took. The recap it wrote is Compact summary.", default: { accentColor: "#14b8a6", icon: "Scissors", standard: true } },
  "system.init": { id: "system.init", category: "live", label: "Session start", description: "The CLI starting a session process: its model and folder. Sent live only, so a reloaded transcript has none.", default: { accentColor: "#4b5563", icon: "Power", standard: false } },
  "system.result": { id: "system.result", category: "live", label: "Turn result", description: "The CLI ending a turn: success or the error it stopped on, how long it ran and how many model calls it took. Sent live only, so a reloaded transcript has none.", default: { accentColor: "#4b5563", icon: "Flag", standard: false } },
  // ── stream-only CLI bookkeeping ──
  // Records the CLI sends a stream-json host for its own sake. Nothing to say
  // in the transcript, so they default to Never — but as settings rather than
  // hard-coded drops, so each can be switched on to see what the CLI sent.
  // `showRawPayload` because none carries a narrative field.
  "system.background_tasks_changed": { id: "system.background_tasks_changed", category: "live", label: "Background tasks", description: "Snapshot of every background task running, re-sent on each change. The status bar's agents and shells readouts show the same set.", default: { accentColor: "#4b5563", icon: "ListTree", standard: false }, collapse: { mode: "latestInRun" } },
  "system.dev_intent": { id: "system.dev_intent", category: "live", label: "Dev intent", description: "The CLI's inference of what you are building (e.g. an iOS app), sent once per kind.", default: { accentColor: "#4b5563", icon: "Lightbulb", standard: false } },
  "system.per_turn_effort_changed": { id: "system.per_turn_effort_changed", category: "live", label: "Per-turn effort", description: "Per-turn effort stopped being cache-safe for this model, so an effort change now rewrites the cached prefix.", default: { accentColor: "#4b5563", icon: "Settings", standard: false }, collapse: { mode: "onChange", field: "per_turn_effort_active" } },
  "system.elicitation_complete": { id: "system.elicitation_complete", category: "live", label: "Elicitation complete", description: "An MCP server confirmed a URL-mode elicitation (usually a browser sign-in) finished.", default: { accentColor: "#4b5563", icon: "Plug", standard: false } },
  "system.session_metadata": { id: "system.session_metadata", category: "live", label: "Session metadata", description: "The session's published-artifact list, re-sent on each change.", default: { accentColor: "#4b5563", icon: "Package", standard: false }, collapse: { mode: "latestInRun" } },
  "system.session_title_changed": { id: "system.session_title_changed", category: "live", label: "Session name (live)", description: "The session's custom name, sent at startup when it has one and after each rename. The saved rename is Session renamed.", default: { accentColor: "#4b5563", icon: "Tag", standard: false }, collapse: { mode: "onChange", field: "title" } },
  "system.ui_status": { id: "system.ui_status", category: "live", label: "Mod status line", description: "A mod's pinned status line, each replacing its last. The Session context panel's Mods section shows the current one.", default: { accentColor: "#4b5563", icon: "Package", standard: false } },
  "system.ui_invalidate": { id: "system.ui_invalidate", category: "live", label: "Mod redraw", description: "A mod asked its surface to redraw. OmniFex does not draw mod UI.", default: { accentColor: "#4b5563", icon: "Package", standard: false }, collapse: { mode: "latestInRun" } },
  "system.ui_focus": { id: "system.ui_focus", category: "live", label: "Mod focus", description: "A mod moved focus in UI it draws. OmniFex does not draw mod UI.", default: { accentColor: "#4b5563", icon: "Package", standard: false } },
  "system.ui_panes": { id: "system.ui_panes", category: "live", label: "Mod panes", description: "The panes mods have open, re-sent on each change. OmniFex does not draw mod UI.", default: { accentColor: "#4b5563", icon: "Package", standard: false }, collapse: { mode: "latestInRun" } },
  "system.ui_placed": { id: "system.ui_placed", category: "live", label: "Mod placed rows", description: "The rows mods placed in the conversation ($.ui.place), re-sent on each change. OmniFex does not draw mod UI.", default: { accentColor: "#4b5563", icon: "Package", standard: false }, collapse: { mode: "latestInRun" } },
  "system.ui_notify": { id: "system.ui_notify", category: "live", label: "Mod notification", description: "A notification a mod raised ($.ui.notify). It appears as a macOS notification, not in the transcript.", default: { accentColor: "#4b5563", icon: "Bell", standard: false } },
  "system.ui_notify_cancel": { id: "system.ui_notify_cancel", category: "live", label: "Mod notification withdrawn", description: "A mod took back a notification it raised or booked.", default: { accentColor: "#4b5563", icon: "Bell", standard: false } },
  "system.ui_scroll": { id: "system.ui_scroll", category: "live", label: "Mod scroll", description: "A mod scrolled UI it draws. OmniFex does not draw mod UI.", default: { accentColor: "#4b5563", icon: "Package", standard: false } },
  "system.permission_check_status": { id: "system.permission_check_status", category: "live", label: "Permission check status", description: "A tool call's automatic permission check (auto mode's classifier) has run about four seconds: 'checking', then 'done' when it ends.", default: { accentColor: "#4b5563", icon: "ShieldCheck", standard: false }, collapse: { mode: "latestInRun" } },
  "system.status": { id: "system.status", category: "live", label: "Status", description: "The CLI's live phase ping: requesting at each model call (one per tool step), compacting while it compacts, and the result or the new permission mode when that ends. The live activity label shows the current one. Sent live only, so a reloaded transcript has none.", default: { accentColor: "#4b5563", icon: "Hourglass", standard: false } },
  "system.commands_changed": { id: "system.commands_changed", category: "live", label: "Commands changed", description: "The full slash-command list, re-sent after a mid-session change such as a mod registering a command.", default: { accentColor: "#4b5563", icon: "Slash", standard: false }, collapse: { mode: "latestInRun" } },
  "system.ui_log": { id: "system.ui_log", category: "live", label: "Mod log line", description: "A line a mod wrote to the transcript ($.ui.log), under the mod's name.", default: { accentColor: "#4b5563", icon: "Package", standard: true } },
  "system.ui_toast": { id: "system.ui_toast", category: "live", label: "Mod notice", description: "A notice a mod showed ($.ui.toast), under the mod's name. The terminal shows it for a few seconds; here it stays in the transcript.", default: { accentColor: "#4b5563", icon: "Bell", standard: true } },
  "system.unknown": { id: "system.unknown", category: "system", label: "System (other)", description: "Any unrecognized system subtype.", default: { icon: "Info" } },
  "permission.request": { id: "permission.request", category: "system", label: "Permission request", description: "Live tool-permission prompt.", default: { accentColor: "#f59e0b", icon: "ShieldQuestion", standard: true } },
  "permission.askUserQuestion": { id: "permission.askUserQuestion", category: "system", label: "Question (live)", description: "Live AskUserQuestion prompt.", default: { accentColor: "#6366f1", icon: "MessageCircleQuestion", standard: true } },
  // ── summary / fallback (resolve to system) ──
  "summary.compaction": { id: "summary.compaction", category: "system", label: "Conversation summary", description: "Compaction summary card.", default: { icon: "FileText", standard: true, alwaysShown: true } },
  "unknown": { id: "unknown", category: "system", label: "Unknown", description: "A record OmniFex does not recognize — drawn with its raw payload. Expanded always shows it.", default: { accentColor: "#f97316", icon: "HelpCircle", standard: false } },
  // ── bookkeeping (real JSONL lines, previously dropped by the renderer) ──
  "cli-state": { id: "cli-state", category: "system", label: "CLI state", description: "Session state the CLI keeps in the transcript for itself — mode, owner, latches, the tools used so far (the list in cliSidechannelRecords.ts). Nothing in it is addressed to you; Expanded shows it with its raw payload.", default: { accentColor: "#93c5fd", icon: "Workflow", standard: false } },
  "task-lifecycle": { id: "task-lifecycle", category: "system", label: "Task progress", description: "A background task or subagent starting, reporting progress, or finishing (task_started / task_progress / task_notification). The agents rows show the same work live; Expanded shows each frame with its raw payload.", default: { accentColor: "#93c5fd", icon: "ListChecks", standard: false } },
  "permission-mode": { id: "permission-mode", category: "system", label: "Permission mode", description: "Permission level changed mid-session.", default: { accentColor: "#f59e0b", icon: "ShieldCheck", standard: true }, collapse: { mode: "onChange", field: "permissionMode", onlyIn: ["standard"] } },
  "last-prompt": { id: "last-prompt", category: "system", label: "Last-prompt bookmark", description: "Resume bookmark pointing at your most recent prompt.", default: { accentColor: "#4b5563", icon: "Bookmark", standard: false } },
  "ai-title": { id: "ai-title", category: "system", label: "Session title", description: "Auto-generated session title.", default: { accentColor: "#4b5563", icon: "Tag", standard: false } },
  "custom-title": { id: "custom-title", category: "system", label: "Session renamed", description: "Session renamed — by the pencil in the status bar, /rename, or claude.ai.", default: { accentColor: "#9ca3af", icon: "Tag", standard: false }, collapse: { mode: "onChange", field: "customTitle", onlyIn: ["standard"] } },
  "queue-operation": { id: "queue-operation", category: "system", label: "Input queue", description: "The CLI's input queue: a prompt, task notification or agent message arriving (enqueue), a turn starting on it (dequeue, with the wait when there was one), or it being folded into the running turn (remove).", default: { accentColor: "#9ca3af", icon: "ListOrdered", standard: false } },
  "file-history-snapshot": { id: "file-history-snapshot", category: "system", label: "File snapshot", description: "CLI editor undo/redo snapshot.", default: { accentColor: "#4b5563", icon: "Clock", standard: false } },
  // ── session context sources (attachment channel) ──
  // What the CLI reports loading into the session: instruction files, nested
  // memory, MCP servers, agents, skills, deferred tools. Each is one arrival
  // in the context ledger (see src/lib/contextLedger.ts); the marker is the
  // arrival's place in the feed and the panel is where content is reviewed.
  // Only the six in-scope sub-types get an id — the rest of the attachment
  // channel is per-turn bookkeeping and stays unrendered.
  "attachment.instructions": { id: "attachment.instructions", category: "system", label: "Instructions loaded", description: "Instruction files (CLAUDE.md / AGENTS.md / MEMORY.md) the CLI loaded into this session.", default: { accentColor: "#f59e0b", icon: "FileText", standard: true } },
  "attachment.nested_memory": { id: "attachment.nested_memory", category: "system", label: "Nested memory", description: "A subdirectory CLAUDE.md picked up as Claude navigated the project.", default: { accentColor: "#f59e0b", icon: "FileText", standard: false } },
  "attachment.mcp_instructions_delta": { id: "attachment.mcp_instructions_delta", category: "system", label: "MCP servers changed", description: "MCP server instructions added to or removed from the session context.", default: { accentColor: "#9ca3af", icon: "Server", standard: false } },
  "attachment.agent_listing_delta": { id: "attachment.agent_listing_delta", category: "system", label: "Agents changed", description: "Available subagent types added or removed.", default: { accentColor: "#9ca3af", icon: "Bot", standard: false } },
  "attachment.deferred_tools_delta": { id: "attachment.deferred_tools_delta", category: "system", label: "Deferred tools changed", description: "Tool schemas deferred behind ToolSearch, added or removed.", default: { accentColor: "#4b5563", icon: "Package", standard: false } },
  "attachment.skill_listing": { id: "attachment.skill_listing", category: "system", label: "Skills listing", description: "The set of skills offered to this session.", default: { accentColor: "#4b5563", icon: "Sparkles", standard: false } },
  "attachment.project_doc_reads": { id: "attachment.project_doc_reads", category: "system", label: "Project docs read", description: "claude.ai project documents read into this session on your behalf.", default: { accentColor: "#f59e0b", icon: "FileText", standard: true } },
  // ── synthetic control-change markers (live-session only) ──
  // Unified family: same chrome (Settings icon, info accent); distinct ids so
  // each stays independently re-stylable. Visible in compact (deliberate user
  // actions worth seeing).
  "control.effort": { id: "control.effort", category: "live", label: "Effort changed", description: "You changed the reasoning effort level.", default: { accentColor: "#9ca3af", icon: "Settings", standard: true } },
  "control.model": { id: "control.model", category: "live", label: "Model changed", description: "You changed the model.", default: { accentColor: "#9ca3af", icon: "Settings", standard: true } },
  // Live permission marker. The persisted `permission-mode` JSONL line (above)
  // covers resume; jsonl-tail never forwards it live, so this synthetic marker
  // gives immediate feedback. Keeps its own ShieldCheck/amber identity to match
  // the persisted permission-mode kind.
  "control.permission": { id: "control.permission", category: "live", label: "Permission changed (live)", description: "You changed the permission mode.", default: { accentColor: "#f59e0b", icon: "ShieldCheck", standard: true } },
};

export function categoryOf(id: string): Category {
  return KIND_REGISTRY[id]?.category ?? "system";
}

export const DEFAULT_CATEGORIES: Record<Category, CategoryStyle> = {
  user:   { label: "User",   description: "Your prompts, commands, tool results, injected context.", accentColor: "#60a5fa", icon: "User", standard: true },
  agent:  { label: "Agent",  description: "Claude's text, thinking, tool calls, completions.",        accentColor: "#8b8b8b", icon: "Bot",  standard: true },
  system: { label: "System", description: "Errors, lifecycle, prompts, session records.",              accentColor: "#4b5563", icon: "Info", standard: false },
  live:   { label: "Live-only", description: "Sent on the live stream and never saved — gone after a reload.", accentColor: "#4b5563", icon: "Zap", standard: false },
};

// ─── style fields ────────────────────────────────────────────────────────────

// The styling fields shared by categories and kind registry entries — everything
// that drives a card's look. Identity fields (id/label/description) are excluded.
export const STYLE_FIELDS: (keyof KindStyle)[] = ["accentColor", "icon", "standard", "alwaysShown"];

/**
 * Three-layer merge: category base → KIND_REGISTRY built-in default → user patch.
 * This is the single source of truth for every kind's effective style.
 */
export function resolveKind(config: MessageRenderingConfig, kindId: string): KindStyle {
  return {
    ...config.categories[categoryOf(kindId)],
    ...KIND_REGISTRY[kindId]?.default,
    ...config.kinds[kindId],
  };
}

/** Left out of Standard. A turn boundary never is. */
export function isHiddenInStandard(style: KindStyle): boolean {
  return !style.alwaysShown && !style.standard;
}

// ─── typography ─────────────────────────────────────────────────────────────
//
// Global typography applied to every message kind. Two style slots — the
// header row that sits above a card's body, and the content body text.

export type FontSize = "xxs" | "xs" | "sm" | "base" | "lg";
export type FontWeight =
  | "thin"
  | "extralight"
  | "light"
  | "normal"
  | "medium"
  | "semibold"
  | "bold"
  | "extrabold"
  | "black";

export interface TypographyStyle {
  /** Catalog typeface ID. See src/lib/typefaceCatalog.ts. */
  typeface: Typeface;
  size: FontSize;
  weight: FontWeight;
}

/** The chat's body text. Modern's answers use it when Settings › Chats sets
 *  their font to "content". */
export interface Typography {
  content: TypographyStyle;
}

export const DEFAULT_TYPOGRAPHY: Typography = {
  content: { typeface: "inter", size: "sm", weight: "normal" },
};

// ─── tab status indicators ───────────────────────────────────────────────────
// The per-tab glyph in the tab strip (TabManager) for each non-working state.
// Icon + color are per-state; size + chip chrome are shared across all four.

export type TabIndicatorKey =
  | "error"
  | "permission"
  | "question"
  | "complete"
  | "cacheExpiring";
export type TabIndicatorSize = "sm" | "md" | "lg";

export interface TabIndicatorStyle {
  /** Icon name from ALLOWED_ICONS (rendered via IconRenderer). */
  icon: IconName;
  /** Hex color. */
  color: string;
}

export interface TabIndicators {
  error: TabIndicatorStyle;
  permission: TabIndicatorStyle;
  question: TabIndicatorStyle;
  complete: TabIndicatorStyle;
  /**
   * Prompt-cache countdown running low on a background session. Unlike the
   * four above this one is ambient rather than actionable, so it ranks last in
   * TabManager's precedence chain and renders without the pulse.
   * Reddens automatically at the critical step; the configured color is the
   * warn color. See src/lib/cacheExpiry.ts.
   */
  cacheExpiring: TabIndicatorStyle;
  /** Shared glyph size: sm/md/lg → 14/16/18px. */
  size: TabIndicatorSize;
  /** Shared: render each glyph inside a bordered chip. */
  bordered: boolean;
  /** Shared chip background opacity (0–100); only applies when bordered. */
  bgOpacity: number;
}

export const DEFAULT_TAB_INDICATORS: TabIndicators = {
  // Defaults reproduce the hard-coded glyphs the tab strip shipped with.
  error: { icon: "AlertCircle", color: "#ef4444" },
  permission: { icon: "Shield", color: "#eab308" },
  question: { icon: "MessageCircleQuestion", color: "#eab308" },
  complete: { icon: "CheckCircle2", color: "#22c55e" },
  cacheExpiring: { icon: "Hourglass", color: "#eab308" },
  size: "md",
  bordered: false,
  bgOpacity: 100,
};

// ─── hard filters ───────────────────────────────────────────────────────────

// ─── terminal ───────────────────────────────────────────────────────────────
//
// Settings for the embedded xterm surface (Codex sign-in and other one-shot terminals).

export type TerminalCursorStyle = "block" | "underline" | "bar";

/** Allowed font-size range (px). Bounds line up with xterm.js's practical
 *  legibility floor and the largest size the picker exposes. Out-of-range
 *  values from saved configs are clamped during merge. */
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

const TERMINAL_CURSOR_STYLES: readonly TerminalCursorStyle[] = ["block", "underline", "bar"];

function isTerminalCursorStyle(v: unknown): v is TerminalCursorStyle {
  return typeof v === "string" && (TERMINAL_CURSOR_STYLES as readonly string[]).includes(v);
}

function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL.fontSize;
  return Math.max(TERMINAL_FONT_SIZE_MIN, Math.min(TERMINAL_FONT_SIZE_MAX, Math.round(n)));
}

export interface Terminal {
  /** Catalog typeface ID. Mono fonts only — the picker filters to family='mono'. */
  typeface: Typeface;
  /** Font size in CSS pixels. Clamped to [TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX] on load. */
  fontSize: number;
  /** xterm cursor style — block, underline, or vertical bar. */
  cursorStyle: TerminalCursorStyle;
}

export const DEFAULT_TERMINAL: Terminal = {
  typeface: "jetbrains-mono",
  fontSize: 13,
  cursorStyle: "block",
};

// ─── tab strip ──────────────────────────────────────────────────────────────

/**
 * How much of each tab the strip spends on text.
 *
 * `expanded` is the two-line tab: the project name over the session's own
 * name. `compact` drops the session line, leaving a single row — the tab still
 * carries its glyph, status and close button, it just stops reserving vertical
 * space for a name that is often absent anyway.
 *
 * Purely presentational. The session name is still resolved either way (the
 * hover title uses it), so switching density never changes what a tab knows.
 */
export type TabDensity = "expanded" | "compact";

export interface TabStrip {
  density: TabDensity;
  /**
   * Widest a tab may grow, in CSS px. Tabs still size to content below it;
   * past it the project and session names truncate to an ellipsis. Without a
   * cap, a CLI-generated session title set the width of the whole tab.
   */
  maxWidth: number;
}

export const TAB_MAX_WIDTH_RANGE = { min: 160, max: 480, step: 10 } as const;

export const DEFAULT_TAB_STRIP: TabStrip = {
  density: "expanded",
  maxWidth: 250,
};

// ─── hidden events bar ──────────────────────────────────────────────────────
//
// The compact-mode "N Hidden Events" expander. It is not a message kind — it
// wraps a run of them — so it has no KindStyle and no accent. It takes a
// background and a border independently instead, because the one-color
// accent tints both at fixed low alphas and the bar blended in. Each is a hex
// (alpha allowed) or null for the theme's own look — except the two text
// colors, where null means "automatic": readable against the background.


/** Card border opacity out of the box, in percent. */
export const DEFAULT_CARD_BORDER_OPACITY = 20;

/** Card corner radius out of the box, in px — the theme's `rounded-lg`. */
export const DEFAULT_CARD_BORDER_RADIUS = 12;
export const CARD_BORDER_RADIUS_MAX = 24;

// ─── Modern chat format ─────────────────────────────────────────────────────
//
// Settings › Chats › Modern. Modern draws its own way — bubbles, prose and the
// work timeline — rather than through message kinds, so it has a block of its
// own. Added after ship: the defaults-as-baseline merge covers older configs.

/** A step in Modern's work timeline: a thought, or what a tool call did
 *  (`stepKind` in modernSteps.ts names every tool's). */
export const MODERN_STEP_KINDS = [
  "thought", "command", "commit", "branch", "read", "edit", "create", "search",
  "explore", "web", "agent", "tasks", "question", "skill", "design", "mcp", "tool",
] as const;
export type ModernStepKind = (typeof MODERN_STEP_KINDS)[number];

/** When a finished or running timeline is open. */
export type TimelineOpen = "while-running" | "always" | "never";
const TIMELINE_OPEN: readonly TimelineOpen[] = ["while-running", "always", "never"];

/** Geist, Modern's own face, or Chats › Typography's content typeface. */
export type ModernFont = "geist" | "content";

/** Answer text sizes in px; the line height follows at ~1.43×. */
export const MODERN_ANSWER_SIZES = [12, 13, 14, 15, 16, 18] as const;

export interface ModernStyle {
  stepIcons: Record<ModernStepKind, IconName>;
  /** Hex per step kind for its icon chip and the rule beside its opened
   *  body, or null for the built-in gray. A failed step stays red. */
  stepColors: Record<ModernStepKind, string | null>;
  timelineOpen: TimelineOpen;
  showThoughts: boolean;
  font: ModernFont;
  answerSize: number;
  /** Hex, or null for the built-in blue. */
  promptTint: string | null;
  /** Hex, or null for the theme's destructive red. */
  failedColor: string | null;
  /** Hex, or null for the built-in emerald. The answer card takes only its
   *  hue; lightness and chroma stay the stylesheet's, so it stays muted. */
  answerCardColor: string | null;
  /** Each card's saturation as a percent of its built-in strength, 0–200. */
  promptSaturation: number;
  answerCardSaturation: number;
  /** Each card's brightness: a percent of its built-in lift off the theme's
   *  muted color, 0–200 (darker on the light theme, where the lift is down). */
  promptBrightness: number;
  answerCardBrightness: number;
  /** A soft drop shadow tinted the card's own color. */
  promptShadow: boolean;
  answerCardShadow: boolean;
  /** Off: the card has no fill or border, and the page shows through. */
  promptColorEnabled: boolean;
  answerCardColorEnabled: boolean;
  /** The answer that ends a turn: in the card, or with only a bar down its
   *  left edge in the answer color (Compact's "Execution complete" look). */
  answerStyle: ModernAnswerStyle;
  /** The user prompt: in its card, or with only a bar down its left edge in
   *  the prompt color — the answer's Line, for the prompt. */
  promptStyle: ModernAnswerStyle;
}

export type ModernAnswerStyle = "card" | "line";

/** Saturation and brightness top out at twice the built-in. */
export const MODERN_PERCENT_MAX = 200;

export const DEFAULT_MODERN: ModernStyle = {
  stepIcons: {
    thought: "Brain",
    command: "Terminal",
    commit: "GitCommitHorizontal",
    branch: "GitBranch",
    read: "FileText",
    edit: "FilePen",
    create: "FilePlus",
    search: "Search",
    explore: "FolderSearch",
    web: "Globe",
    agent: "Bot",
    tasks: "ListTodo",
    question: "MessageCircleQuestion",
    skill: "Sparkles",
    design: "Palette",
    mcp: "Plug",
    tool: "Wrench",
  },
  stepColors: Object.fromEntries(MODERN_STEP_KINDS.map((k) => [k, null])) as Record<ModernStepKind, string | null>,
  timelineOpen: "while-running",
  showThoughts: true,
  font: "geist",
  answerSize: 14,
  promptTint: null,
  failedColor: null,
  answerCardColor: null,
  promptSaturation: 100,
  answerCardSaturation: 100,
  promptBrightness: 100,
  answerCardBrightness: 100,
  promptShadow: true,
  answerCardShadow: true,
  promptColorEnabled: true,
  answerCardColorEnabled: true,
  answerStyle: "card",
  promptStyle: "card",
};

const GEIST_STACK = "'Geist', var(--app-font-stack, ui-sans-serif, system-ui, sans-serif)";

/**
 * The CSS variables styles.css reads for Modern. Null means "leave it to the
 * stylesheet's fallback". Set on :root by MessageRenderingProvider, and inline
 * on the settings sample so it follows the draft.
 */
export function modernCssVars(m: ModernStyle): Record<string, string | null> {
  return {
    "--modern-font": m.font === "content" ? "var(--chat-content-font)" : GEIST_STACK,
    "--modern-answer-size": `${String(m.answerSize)}px`,
    "--modern-answer-leading": `${String(Math.round(m.answerSize * 1.43))}px`,
    // Each card: the color tints its shadow, its hue sets fill and border.
    "--modern-prompt-tint": m.promptTint,
    "--modern-prompt-hue": m.promptTint ? hueVar(m.promptTint) : null,
    "--modern-prompt-saturation": cardSaturationVar(m.promptTint, m.promptSaturation),
    "--modern-prompt-brightness": percentVar(m.promptBrightness),
    "--modern-final-tint": m.answerCardColor,
    "--modern-final-hue": m.answerCardColor ? hueVar(m.answerCardColor) : null,
    "--modern-final-saturation": cardSaturationVar(m.answerCardColor, m.answerCardSaturation),
    "--modern-final-brightness": percentVar(m.answerCardBrightness),
  };
}

function hueVar(hex: string): string | null {
  const h = hexHue(hex);
  return h === null ? null : h.toFixed(3);
}

/** 100% is the stylesheet's own strength, so it sets nothing. A white, grey
 *  or black pick has no hue to show, so it draws untinted whatever the
 *  slider says — taking its hue drew a brown card. */
function cardSaturationVar(color: string | null, pct: number): string | null {
  if (color && (hexChroma(color) ?? 1) < NEUTRAL_CHROMA) return "0";
  return percentVar(pct);
}

/** 100% is the stylesheet's own lift, so it sets nothing. */
function percentVar(pct: number): string | null {
  return pct === 100 ? null : String(pct / 100);
}

function percentOf(v: unknown, base: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MODERN_PERCENT_MAX ? v : base;
}

function mergeModern(saved: Record<string, unknown>, base: ModernStyle): ModernStyle {
  const stepIcons = { ...base.stepIcons };
  if (isRecord(saved.stepIcons)) {
    for (const k of MODERN_STEP_KINDS) {
      const v = saved.stepIcons[k];
      if (typeof v === "string" && (ALLOWED_ICONS as readonly string[]).includes(v)) stepIcons[k] = v as IconName;
    }
  }
  const stepColors = { ...base.stepColors };
  if (isRecord(saved.stepColors)) {
    for (const k of MODERN_STEP_KINDS) {
      const v = saved.stepColors[k];
      if (isHexColor(v)) stepColors[k] = v;
    }
  }
  return {
    stepIcons,
    stepColors,
    timelineOpen: TIMELINE_OPEN.includes(saved.timelineOpen as TimelineOpen)
      ? (saved.timelineOpen as TimelineOpen)
      : base.timelineOpen,
    showThoughts: typeof saved.showThoughts === "boolean" ? saved.showThoughts : base.showThoughts,
    font: saved.font === "geist" || saved.font === "content" ? saved.font : base.font,
    answerSize: (MODERN_ANSWER_SIZES as readonly unknown[]).includes(saved.answerSize)
      ? (saved.answerSize as number)
      : base.answerSize,
    promptTint: isHexColor(saved.promptTint) ? saved.promptTint : base.promptTint,
    failedColor: isHexColor(saved.failedColor) ? saved.failedColor : base.failedColor,
    answerCardColor: isHexColor(saved.answerCardColor) ? saved.answerCardColor : base.answerCardColor,
    promptSaturation: percentOf(saved.promptSaturation, base.promptSaturation),
    answerCardSaturation: percentOf(saved.answerCardSaturation, base.answerCardSaturation),
    promptBrightness: percentOf(saved.promptBrightness, base.promptBrightness),
    answerCardBrightness: percentOf(saved.answerCardBrightness, base.answerCardBrightness),
    promptShadow: typeof saved.promptShadow === "boolean" ? saved.promptShadow : base.promptShadow,
    answerCardShadow: typeof saved.answerCardShadow === "boolean" ? saved.answerCardShadow : base.answerCardShadow,
    promptColorEnabled: typeof saved.promptColorEnabled === "boolean" ? saved.promptColorEnabled : base.promptColorEnabled,
    answerCardColorEnabled: typeof saved.answerCardColorEnabled === "boolean" ? saved.answerCardColorEnabled : base.answerCardColorEnabled,
    answerStyle: saved.answerStyle === "card" || saved.answerStyle === "line" ? saved.answerStyle : base.answerStyle,
    promptStyle: saved.promptStyle === "card" || saved.promptStyle === "line" ? saved.promptStyle : base.promptStyle,
  };
}

// ─── top-level config (v5) ──────────────────────────────────────────────────

/**
 * The two views a transcript can be drawn in (SessionViewToggle), both by the
 * Modern renderer. Standard leaves out what Settings › Chats hides; Expanded
 * draws every record (2026-11-18, replacing Compact / Verbose / All / Modern).
 */
export type ViewMode = "standard" | "expanded";

/** A saved default from before the two views: Compact and Modern drew what
 *  Standard draws; Verbose and All showed more, as Expanded does. */
const LEGACY_VIEW_MODES: Record<string, ViewMode> = {
  standard: "standard", expanded: "expanded",
  compact: "standard", modern: "standard", verbose: "expanded", all: "expanded",
};

export interface MessageRenderingConfig {
  version: 6;
  /** The chat format a new session opens in. */
  defaultViewMode: ViewMode;
  categories: Record<Category, CategoryStyle>;
  /** Per-kind user style patches — the third layer of resolveKind. */
  kinds: Record<string, Partial<KindStyle>>;
  /** Opacity, 0–100, of every accent-colored card border. */
  cardBorderOpacity: number;
  /** Corner radius of every card, in px (0–24). */
  cardBorderRadius: number;
  typography: Typography;
  tabIndicators: TabIndicators;
  tabs: TabStrip;
  terminal: Terminal;
  modern: ModernStyle;
}

export function createDefaultConfig(): MessageRenderingConfig {
  return {
    version: 6,
    // What sessions opened in before the setting was read.
    defaultViewMode: "standard",
    categories: structuredClone(DEFAULT_CATEGORIES),
    kinds: {},
    cardBorderOpacity: DEFAULT_CARD_BORDER_OPACITY,
    cardBorderRadius: DEFAULT_CARD_BORDER_RADIUS,
    typography: structuredClone(DEFAULT_TYPOGRAPHY),
    tabIndicators: structuredClone(DEFAULT_TAB_INDICATORS),
    tabs: { ...DEFAULT_TAB_STRIP },
    terminal: { ...DEFAULT_TERMINAL },
    modern: { ...DEFAULT_MODERN, stepIcons: { ...DEFAULT_MODERN.stepIcons }, stepColors: { ...DEFAULT_MODERN.stepColors } },
  };
}

// ─── merge / load / validate ────────────────────────────────────────────────
//
// Merge strategy: the default config is always the baseline; user patches are
// applied on top. On a version mismatch the saved config is discarded and
// defaults are returned (full reset). Unknown kind IDs in saved data are
// silently dropped. Legacy palette color names are converted to hex.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True when v looks like a CSS hex color: #rgb, #rrggbb, or the
 * 8-digit RGBA variant #rrggbbaa. Permissive enough to accept what an
 * <input type="color"> emits (always 7-char #rrggbb) plus typed-in
 * shorthands and alpha variants. The accent helpers in accentStyle.ts
 * pad/derive border + bg alphas on top of whichever form is stored.
 */
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
}

/**
 * Validate and coerce a single style field off a raw record. Returns the
 * accepted value, or undefined when the raw value is missing/invalid so the
 * caller can fall back to the inherited default.
 */
function validateStyleField(
  field: keyof KindStyle,
  raw: Record<string, unknown>,
  swatches: Record<string, string>,
): unknown {
  if (!(field in raw)) return undefined;
  const v = raw[field];
  switch (field) {
    case "icon":
      return typeof v === "string" && (ALLOWED_ICONS as readonly string[]).includes(v) ? v : undefined;
    case "accentColor":
      return savedColor(v, swatches);
    case "standard":
    case "alwaysShown":
      return typeof v === "boolean" ? v : undefined;
    default:
      return undefined;
  }
}

/** Validate and clean a saved kinds map, dropping junk entries and unknown fields. */
function validateKindsMap(raw: unknown, swatches: Record<string, string>): Record<string, Partial<KindStyle>> {
  const out: Record<string, Partial<KindStyle>> = {};
  if (!isRecord(raw)) return out;
  for (const [id, patch] of Object.entries(raw)) {
    if (!isRecord(patch)) continue;
    const clean: Record<string, unknown> = {};
    for (const f of STYLE_FIELDS) {
      const v = validateStyleField(f, patch, swatches);
      if (v !== undefined) clean[f] = v;
    }
    if (Object.keys(clean).length > 0) out[id] = clean;
  }
  return out;
}

/** Shallow-merge saved category styles over the defaults already on base. */
function mergeCategories(
  base: MessageRenderingConfig,
  saved: Record<string, unknown>,
  swatches: Record<string, string>,
): void {
  if (!isRecord(saved.categories)) return;
  for (const c of CATEGORIES) {
    const sc = (saved.categories)[c];
    if (!isRecord(sc)) continue;
    const patch: Record<string, unknown> = {};
    for (const f of STYLE_FIELDS) {
      const val = validateStyleField(f, sc, swatches);
      if (val !== undefined) patch[f] = val;
    }
    if (typeof sc.label === "string") patch.label = sc.label;
    if (typeof sc.description === "string") patch.description = sc.description;
    base.categories[c] = { ...base.categories[c], ...patch };
  }
}

export function mergeConfig(input: unknown): MessageRenderingConfig {
  const base = createDefaultConfig();
  // v5 carried the classic formats' settings; it is rewritten as v6 so that
  // Standard shows what Modern showed (renderingConfigMigration.ts).
  const saved = isRecord(input) && input.version === 5 ? migrateV5(input) : input;
  // Full reset for anything else that is not a v6 record.
  if (!isRecord(saved) || saved.version !== 6) return base;
  const swatches = legacySwatches(saved.palette);
  mergeCategories(base, saved, swatches);
  base.kinds = validateKindsMap(saved.kinds, swatches);
  return mergeShared(base, saved, swatches);
}

/**
 * Merge the shared (non-kind) config blocks — view mode, card border opacity,
 * typography, tabs, hidden-events bar, terminal — from a saved record
 * onto base. A saved `palette` / `hardFilters` / `debug` block (all retired) is
 * ignored.
 */
function mergeShared(
  base: MessageRenderingConfig,
  saved: Record<string, unknown>,
  swatches: Record<string, string>,
): MessageRenderingConfig {
  const saved_ = saved.defaultViewMode;
  const view = typeof saved_ === "string" && Object.prototype.hasOwnProperty.call(LEGACY_VIEW_MODES, saved_) ? LEGACY_VIEW_MODES[saved_] : undefined;
  if (view) base.defaultViewMode = view;

  if (typeof saved.cardBorderOpacity === "number" && Number.isFinite(saved.cardBorderOpacity)) {
    base.cardBorderOpacity = Math.max(0, Math.min(100, Math.round(saved.cardBorderOpacity)));
  }
  if (typeof saved.cardBorderRadius === "number" && Number.isFinite(saved.cardBorderRadius)) {
    base.cardBorderRadius = Math.max(0, Math.min(CARD_BORDER_RADIUS_MAX, Math.round(saved.cardBorderRadius)));
  }

  if (isRecord(saved.typography)) {
    const t = saved.typography;
    base.typography = { content: mergeTypographyStyle(t.content, base.typography.content) };
  }

  if (isRecord(saved.tabIndicators)) {
    base.tabIndicators = mergeTabIndicators(saved.tabIndicators, base.tabIndicators, swatches);
  }

  if (isRecord(saved.tabs)) {
    const t = saved.tabs;
    base.tabs = {
      density:
        t.density === "compact" || t.density === "expanded"
          ? t.density
          : base.tabs.density,
      maxWidth:
        typeof t.maxWidth === "number" && Number.isFinite(t.maxWidth)
          ? Math.min(TAB_MAX_WIDTH_RANGE.max, Math.max(TAB_MAX_WIDTH_RANGE.min, Math.round(t.maxWidth)))
          : base.tabs.maxWidth,
    };
  }

  if (isRecord(saved.terminal)) {
    const t = saved.terminal;
    if (isTypefaceId(t.typeface)) base.terminal.typeface = t.typeface;
    if (typeof t.fontSize === "number") base.terminal.fontSize = clampFontSize(t.fontSize);
    if (isTerminalCursorStyle(t.cursorStyle)) base.terminal.cursorStyle = t.cursorStyle;
    // Unknown / wrong-typed fields fall through to the defaults already on
    // base.terminal from createDefaultConfig() above.
  }

  if (isRecord(saved.modern)) base.modern = mergeModern(saved.modern, base.modern);

  return base;
}

const SIZE_VALUES: readonly FontSize[] = ["xxs", "xs", "sm", "base", "lg"];
const WEIGHT_VALUES: readonly FontWeight[] = [
  "thin",
  "extralight",
  "light",
  "normal",
  "medium",
  "semibold",
  "bold",
  "extrabold",
  "black",
];
function mergeTypographyStyle(
  saved: unknown,
  base: TypographyStyle,
): TypographyStyle {
  if (!isRecord(saved)) return base;
  const raw = saved;

  // Migration path: legacy records have a family field. Map it to a
  // sensible default typeface so the user's intent (sans vs serif vs mono)
  // is preserved across the schema change.
  let typeface: Typeface = base.typeface;
  if (typeof raw.typeface === "string" && isTypefaceId(raw.typeface)) {
    typeface = raw.typeface;
  } else if (typeof raw.family === "string") {
    typeface =
      raw.family === "serif"
        ? "source-serif"
        : raw.family === "mono"
        ? "jetbrains-mono"
        : "inter";
  }

  return {
    typeface,
    size: SIZE_VALUES.includes(raw.size as FontSize) ? (raw.size as FontSize) : base.size,
    weight: WEIGHT_VALUES.includes(raw.weight as FontWeight)
      ? (raw.weight as FontWeight)
      : base.weight,
  };
}


const TAB_INDICATOR_SIZES: readonly TabIndicatorSize[] = ["sm", "md", "lg"];

function mergeTabIndicatorStyle(
  saved: unknown,
  base: TabIndicatorStyle,
  swatches: Record<string, string>,
): TabIndicatorStyle {
  if (!isRecord(saved)) return base;
  const icon =
    typeof saved.icon === "string" &&
    (ALLOWED_ICONS as readonly string[]).includes(saved.icon)
      ? (saved.icon as IconName)
      : base.icon;
  const color = savedColor(saved.color, swatches) ?? base.color;
  return { icon, color };
}

function mergeTabIndicators(
  saved: unknown,
  base: TabIndicators,
  swatches: Record<string, string>,
): TabIndicators {
  if (!isRecord(saved)) return base;
  const s = saved;
  const bgOpacity =
    typeof s.bgOpacity === "number" && Number.isFinite(s.bgOpacity)
      ? Math.max(0, Math.min(100, Math.round(s.bgOpacity)))
      : base.bgOpacity;
  return {
    error: mergeTabIndicatorStyle(s.error, base.error, swatches),
    permission: mergeTabIndicatorStyle(s.permission, base.permission, swatches),
    question: mergeTabIndicatorStyle(s.question, base.question, swatches),
    complete: mergeTabIndicatorStyle(s.complete, base.complete, swatches),
    // Added after ship; the defaults-as-baseline merge supplies it for saved
    // configs, so no version bump (which would reset the whole config).
    cacheExpiring: mergeTabIndicatorStyle(s.cacheExpiring, base.cacheExpiring, swatches),
    size: TAB_INDICATOR_SIZES.includes(s.size as TabIndicatorSize)
      ? (s.size as TabIndicatorSize)
      : base.size,
    bordered: typeof s.bordered === "boolean" ? s.bordered : base.bordered,
    bgOpacity,
  };
}

export function serializeConfig(cfg: MessageRenderingConfig): string {
  return JSON.stringify(cfg);
}

export function parseConfig(raw: string | null | undefined): MessageRenderingConfig {
  if (!raw) return createDefaultConfig();
  try {
    return mergeConfig(JSON.parse(raw));
  } catch {
    return createDefaultConfig();
  }
}

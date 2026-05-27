// Message-rendering config — data model and defaults.
//
// This module is the source of truth for the Appearance settings UI. It does
// NOT yet drive the actual StreamMessage renderer; wiring that up is a
// follow-on change. The settings screen reads and writes this config via
// `api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, ...)`.
//
// Derived from docs/message-rendering-config.yaml.

import { isTypefaceId, type Typeface } from "./typefaceCatalog";

export const MESSAGE_RENDERING_CONFIG_KEY = "message_rendering_config";

// ─── palette ────────────────────────────────────────────────────────────────

export type PaletteName =
  | "primary"
  | "blue"
  | "amber"
  | "green"
  | "red"
  | "gray"
  | "muted"
  | "info"
  | "sysInit"
  | "purple"
  | "orange"
  | "teal"
  | "pink"
  | "indigo"
  | "cyan"
  | "yellow"
  | "lime"
  | "brown"
  | "chocolate"
  | "tan"
  | "black";

export interface PaletteEntry {
  border: string; // tailwind class fragment, e.g. "primary/20"
  bg: string | null; // tailwind class fragment, hex, or null for none
  swatch: string; // hex used for the palette swatch in the editor
}

export type Palette = Record<PaletteName, PaletteEntry>;

export const DEFAULT_PALETTE: Palette = {
  primary: { border: "primary/20", bg: "primary/5", swatch: "#8b8b8b" },
  blue: { border: "blue-400/30", bg: "rgba(96,165,250,0.10)", swatch: "#60a5fa" },
  amber: { border: "amber-500/30", bg: "rgba(245,158,11,0.12)", swatch: "#f59e0b" },
  green: { border: "green-500/20", bg: "green-500/5", swatch: "#22c55e" },
  red: { border: "destructive/20", bg: "destructive/5", swatch: "#ef4444" },
  gray: { border: "gray-500/20", bg: "gray-500/5", swatch: "#6b7280" },
  muted: { border: "border/30", bg: "muted/30", swatch: "#4b5563" },
  info: { border: "muted-foreground/30", bg: null, swatch: "#9ca3af" },
  sysInit: { border: "blue-500/20", bg: "blue-500/5", swatch: "#3b82f6" },
  purple: { border: "purple-500/30", bg: "purple-500/5", swatch: "#a855f7" },
  orange: { border: "orange-500/30", bg: "orange-500/5", swatch: "#f97316" },
  teal: { border: "teal-500/30", bg: "teal-500/5", swatch: "#14b8a6" },
  pink: { border: "pink-500/30", bg: "pink-500/5", swatch: "#ec4899" },
  indigo: { border: "indigo-500/30", bg: "indigo-500/5", swatch: "#6366f1" },
  cyan: { border: "cyan-500/30", bg: "cyan-500/5", swatch: "#06b6d4" },
  yellow: { border: "yellow-500/30", bg: "yellow-500/5", swatch: "#eab308" },
  lime: { border: "lime-500/30", bg: "lime-500/5", swatch: "#84cc16" },
  brown: { border: "amber-900/30", bg: "amber-900/5", swatch: "#92400e" },
  chocolate: { border: "amber-950/30", bg: "amber-950/5", swatch: "#78350f" },
  tan: { border: "amber-300/30", bg: "amber-300/5", swatch: "#d4a574" },
  black: { border: "neutral-900/30", bg: "neutral-900/5", swatch: "#171717" },
};

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
  // Unicode fallbacks
  "ℹ",
  "✗",
  "⚠",
  "none",
] as const;

export type IconName = (typeof ALLOWED_ICONS)[number];

// ─── message kinds ──────────────────────────────────────────────────────────

export type Origin = "user" | "assistant" | "system" | "result" | "bookkeeping" | "fallback";
export type Alignment = "left" | "right" | "full";
export type Presentation = 'card' | 'side-line';
export type BorderStyle = 'solid' | 'dashed';

export interface MessageKindConfig {
  id: string;
  label: string; // display name in the settings UI
  description: string; // one-line help text
  origin: Origin;
  icon: IconName;
  headerLabel: string | null; // null => no header text
  /**
   * Either a palette name (legacy / cross-kind retinting) or a hex colour
   * (`#rrggbb` / `#rgb`). The accent helpers in `accentStyle.ts` resolve
   * palette names through `config.palette` and treat hex strings as a
   * one-off swatch with derived border/bg alphas. Picker-driven configs
   * write hex; the palette is kept for backwards compatibility and the
   * (rarely used) "retint every kind that shares a name" workflow.
   */
  accentColor: string;
  alignment: Alignment;
  hiddenInCompact: boolean;
  // True if this kind is forced visible in compact mode by grouping logic
  // (e.g. user prompts, results). UI disables the hidden toggle for these.
  compactBoundaryLocked: boolean;
  // Optional widget name (e.g. ThinkingWidget, SystemWidget). Informational
  // only for v1; not editable.
  widget?: string;
  // Per-kind icon overrides — when set, override the corresponding global
  // `typography.icon.*` value for this kind only. When undefined, the kind
  // inherits the global default.
  iconSize?: IconSize;
  iconBordered?: boolean;
  iconBgOpacity?: number; // 0–100

  // New in v2:
  presentation: Presentation;
  borderStyle: BorderStyle;
  /** Only meaningful on the `unknown` row. */
  showRawPayload?: boolean;
}

export type MessageKindsById = Record<string, MessageKindConfig>;

export const DEFAULT_KINDS: MessageKindConfig[] = [
  // ───── ASSISTANT (block-level) ─────
  { id: "assistant.text", label: "Assistant text", description: "Assistant's prose response.", origin: "assistant", icon: "Bot", headerLabel: "Claude", accentColor: "primary", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "assistant.thinking", label: "Assistant thinking", description: "Extended thinking block before a tool call.", origin: "assistant", icon: "Brain", headerLabel: "Thinking", accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid", widget: "ThinkingWidget" },
  { id: "assistant.tool-use", label: "Tool call", description: "Assistant invoking a tool.", origin: "assistant", icon: "Terminal", headerLabel: null, accentColor: "info", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },

  // ───── USER ─────
  { id: "user.prompt", label: "User prompt", description: "Your typed message.", origin: "user", icon: "User", headerLabel: "You", accentColor: "blue", alignment: "right", hiddenInCompact: false, compactBoundaryLocked: true, presentation: "card", borderStyle: "solid" },
  { id: "user.tool-result", label: "Tool result", description: "Result returned by a tool.", origin: "user", icon: "CheckCheck", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.meta.skill", label: "Skill body", description: "Skill content injected by the harness.", origin: "user", icon: "Sparkles", headerLabel: "Skill", accentColor: "purple", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.meta.attachment", label: "Image attachment marker", description: "Inline marker that travels with a user prompt containing an image.", origin: "user", icon: "Image", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.meta.other", label: "Harness injection (other)", description: "Other isMeta=true user records we don't have a more specific kind for.", origin: "user", icon: "Info", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.subagentPrompt", label: "Subagent prompt", description: "Prompt forwarded to a subagent.", origin: "user", icon: "User", headerLabel: "Subagent", accentColor: "purple", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "user.command", label: "Slash command", description: "A /slash command the user invoked.", origin: "user", icon: "ChevronRight", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.commandOutput", label: "Command output", description: "Output of a slash command.", origin: "user", icon: "Terminal", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.skillInjection", label: "Skill injection (legacy)", description: "Live-stream variant of skill-body injection.", origin: "user", icon: "Sparkles", headerLabel: "Skill", accentColor: "purple", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.sdkSystemBracket", label: "SDK system bracket", description: "Bracketed system messages from the SDK (e.g. [Request interrupted by user]).", origin: "user", icon: "Info", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },

  // ───── SYSTEM ─────
  { id: "system.init", label: "Session init", description: "CLI session initialization.", origin: "system", icon: "Power", headerLabel: null, accentColor: "sysInit", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.notification", label: "Notification", description: "User-facing notifications.", origin: "system", icon: "Bell", headerLabel: null, accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "system.api_error", label: "API error", description: "Error returned by the Anthropic API.", origin: "system", icon: "AlertTriangle", headerLabel: null, accentColor: "red", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "system.stop_hook_summary", label: "Stop hook summary", description: "Summary of stop hooks that ran when the turn ended.", origin: "system", icon: "Hook", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.hook_started", label: "Hook started", description: "A configured hook began running.", origin: "system", icon: "Hook", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.hook_response", label: "Hook response", description: "A configured hook returned a response.", origin: "system", icon: "Hook", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.local_command", label: "Local command", description: "Echo of a /slash command the user ran.", origin: "system", icon: "ChevronRight", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.turn_duration", label: "Turn duration", description: "Diagnostic timing record.", origin: "system", icon: "Clock", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.away_summary", label: "Away summary", description: "Summary of what happened while user was away.", origin: "system", icon: "FileText", headerLabel: "Away summary", accentColor: "info", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "system.compact_boundary", label: "Compact boundary", description: "Marks where the conversation was compacted.", origin: "system", icon: "Scissors", headerLabel: "Compacted", accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid", widget: "CompactBoundaryWidget" },
  { id: "system.informational", label: "Informational", description: "Generic informational system message.", origin: "system", icon: "Info", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.permission_denied", label: "Permission denied", description: "Tool call denied by permission check.", origin: "system", icon: "ShieldOff", headerLabel: null, accentColor: "red", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },

  // ───── RESULT ─────
  { id: "result.success", label: "Result · success", description: "Successful turn end.", origin: "result", icon: "Check", headerLabel: null, accentColor: "green", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "result.error_during_execution", label: "Result · error during execution", description: "Turn ended with an error.", origin: "result", icon: "AlertOctagon", headerLabel: "Execution Failed", accentColor: "red", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: true, presentation: "card", borderStyle: "solid" },
  { id: "result.user_interrupt", label: "Result · user interrupt", description: "User interrupted the assistant.", origin: "result", icon: "CircleStop", headerLabel: null, accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "result.max_tokens", label: "Result · max tokens", description: "Turn ended because max_tokens was reached.", origin: "result", icon: "AlertTriangle", headerLabel: "Max tokens", accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "result.refusal", label: "Result · refusal", description: "Assistant declined to respond.", origin: "result", icon: "ShieldOff", headerLabel: "Refused", accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "result.context_window_exceeded", label: "Result · context window exceeded", description: "Conversation exceeded the model's context window.", origin: "result", icon: "AlertTriangle", headerLabel: "Context window exceeded", accentColor: "red", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "result.awaiting_background", label: "Awaiting background tasks", description: "Turn paused waiting for background tools.", origin: "result", icon: "Clock", headerLabel: null, accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },

  // ───── PERMISSION ─────
  { id: "permission.request", label: "Permission request", description: "Permission prompt for a tool call.", origin: "system", icon: "Shield", headerLabel: "Permission", accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "permission.askUserQuestion", label: "User question", description: "AskUserQuestion tool prompt.", origin: "system", icon: "HelpCircle", headerLabel: "Question", accentColor: "blue", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },

  // ───── BOOKKEEPING (surfaced per Greg's "full control" preference) ─────
  { id: "attachment", label: "Attachment", description: "Attachment metadata record.", origin: "bookkeeping", icon: "Paperclip", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "queue-operation", label: "Queue operation", description: "Background queue operation record.", origin: "bookkeeping", icon: "ListOrdered", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "permission-mode", label: "Permission mode change", description: "Permission mode was changed mid-session.", origin: "bookkeeping", icon: "Shield", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "last-prompt", label: "Last prompt marker", description: "Bookmark of the last user prompt for resume.", origin: "bookkeeping", icon: "Bookmark", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "ai-title", label: "AI session title", description: "Generated session title.", origin: "bookkeeping", icon: "Tag", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "file-history-snapshot", label: "File history snapshot", description: "Snapshot of file state.", origin: "bookkeeping", icon: "Camera", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },

  // ───── FALLBACK ─────
  { id: "unknown", label: "Unknown", description: "Diagnostic catch-all for unrecognized types or subtypes.", origin: "fallback", icon: "HelpCircle", headerLabel: "Unknown", accentColor: "orange", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: true, presentation: "side-line", borderStyle: "dashed", showRawPayload: true },
];

// ─── typography ─────────────────────────────────────────────────────────────
//
// Global typography applied to every message kind. Two style slots — the
// `header` row that sits above a card's body, and the `content` body text.
// Per-kind overrides are intentionally out of scope for v1; one pair of
// sliders keeps the UI simple and the config small.

export type FontSize = "xs" | "sm" | "base" | "lg";
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

/** Card-level icon size (the colored icon on the left of a message card).
 *  Independent from `FontSize` so the user can scale icons without changing
 *  text, and vice versa. */
export type IconSize = "xs" | "sm" | "base" | "lg" | "xl";

export interface TypographyStyle {
  /** Catalog typeface ID. See src/lib/typefaceCatalog.ts. */
  typeface: Typeface;
  size: FontSize;
  weight: FontWeight;
  italic: boolean;
}

export interface IconStyle {
  size: IconSize;
  /** When true, the card icon renders inside a bordered chip with the
   *  chat background — the icon "punches out" of the card's tinted accent.
   *  When false, the icon sits flat against the card background. */
  bordered: boolean;
  /** Opacity (0-100) of the chip's background when `bordered` is true.
   *  100 = fully opaque chat-background fill, 0 = transparent (chip border
   *  only). Ignored when `bordered` is false. */
  bgOpacity: number;
}

export interface Typography {
  header: TypographyStyle;
  content: TypographyStyle;
  icon: IconStyle;
}

export const DEFAULT_TYPOGRAPHY: Typography = {
  header: { typeface: "inter", size: "sm", weight: "semibold", italic: false },
  content: { typeface: "inter", size: "sm", weight: "normal", italic: false },
  icon: { size: "base", bordered: true, bgOpacity: 100 },
};

// ─── hard filters ───────────────────────────────────────────────────────────

export interface HardFilters {
  // Live overlay filters — apply to CLI overlay channels (Chat mode only)
  hidePartialStreaming: boolean;     // stream_event (typewriter effect)
  hideSubagentLifecycle: boolean;    // task_started/updated/progress (SubagentBar)
  hideHookLifecycle: boolean;        // hook_started/progress/response
  hideRateLimitNotices: boolean;     // rate_limit_event
}

export const DEFAULT_HARD_FILTERS: HardFilters = {
  hidePartialStreaming: false,
  hideSubagentLifecycle: false,
  hideHookLifecycle: false,
  hideRateLimitNotices: false,
};

// ─── debug ──────────────────────────────────────────────────────────────────

export interface DebugOptions {
  /** When true, every message card renders its raw message type (and subtype if
   *  present) on the bottom-left, so mis-classified cards are obvious. */
  showCardKindLabel: boolean;
}

export const DEFAULT_DEBUG: DebugOptions = {
  showCardKindLabel: false,
};

// ─── terminal ───────────────────────────────────────────────────────────────
//
// Settings specific to the xterm surface in TUI mode. Lives next to typography
// because both are user-facing presentation knobs and they share the same
// import/export config blob — but the terminal lives in its own section to
// avoid coupling to message-card structure that doesn't apply.

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

// ─── top-level config ───────────────────────────────────────────────────────

export interface MessageRenderingConfig {
  version: 2;
  defaultViewMode: "compact" | "verbose";
  palette: Palette;
  kinds: MessageKindsById;
  hardFilters: HardFilters;
  typography: Typography;
  terminal: Terminal;
  debug: DebugOptions;
}

export function createDefaultConfig(): MessageRenderingConfig {
  const kinds: MessageKindsById = {};
  for (const k of DEFAULT_KINDS) kinds[k.id] = { ...k };
  return {
    version: 2,
    defaultViewMode: "verbose",
    palette: structuredClone(DEFAULT_PALETTE),
    kinds,
    hardFilters: { ...DEFAULT_HARD_FILTERS },
    typography: structuredClone(DEFAULT_TYPOGRAPHY),
    terminal: { ...DEFAULT_TERMINAL },
    debug: { ...DEFAULT_DEBUG },
  };
}

// ─── merge / load / validate ────────────────────────────────────────────────
//
// Merge strategy is ADDITIVE: the default config is always the baseline.
// User overrides are applied on top. Unknown kind IDs in saved data are
// silently dropped (schema drift across app versions). Unknown palette keys
// are ignored.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True when `v` looks like a CSS hex colour: `#rgb`, `#rrggbb`, or the
 * 8-digit RGBA variant `#rrggbbaa`. Permissive enough to accept what an
 * `<input type="color">` emits (always 7-char `#rrggbb`) plus typed-in
 * shorthands and alpha variants. The accent helpers in `accentStyle.ts`
 * pad/derive border + bg alphas on top of whichever form is stored.
 */
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
}

export function mergeConfig(saved: unknown): MessageRenderingConfig {
  const base = createDefaultConfig();
  if (!isRecord(saved)) return base;

  if (saved.defaultViewMode === "compact" || saved.defaultViewMode === "verbose") {
    base.defaultViewMode = saved.defaultViewMode;
  }

  if (isRecord(saved.palette)) {
    for (const key of Object.keys(base.palette) as PaletteName[]) {
      const entry = (saved.palette)[key];
      if (isRecord(entry)) {
        const current = base.palette[key];
        base.palette[key] = {
          border: typeof entry.border === "string" ? entry.border : current.border,
          bg: typeof entry.bg === "string" || entry.bg === null ? (entry.bg) : current.bg,
          swatch: typeof entry.swatch === "string" ? entry.swatch : current.swatch,
        };
      }
    }
  }

  if (isRecord(saved.kinds)) {
    for (const id of Object.keys(base.kinds)) {
      const override = (saved.kinds)[id];
      if (isRecord(override)) {
        const current = base.kinds[id];
        base.kinds[id] = {
          ...current,
          icon: typeof override.icon === "string" && (ALLOWED_ICONS as readonly string[]).includes(override.icon)
            ? (override.icon as IconName)
            : current.icon,
          headerLabel:
            override.headerLabel === null || typeof override.headerLabel === "string"
              ? (override.headerLabel)
              : current.headerLabel,
          accentColor:
            typeof override.accentColor === "string" &&
            (override.accentColor in base.palette || isHexColor(override.accentColor))
              ? override.accentColor
              : current.accentColor,
          alignment:
            override.alignment === "left" || override.alignment === "right" || override.alignment === "full"
              ? override.alignment
              : current.alignment,
          hiddenInCompact: current.compactBoundaryLocked
            ? false
            : typeof override.hiddenInCompact === "boolean"
              ? override.hiddenInCompact
              : current.hiddenInCompact,
          // Per-kind icon overrides. Each is optional — undefined means
          // "inherit the global default from typography.icon". When the
          // saved value is missing or invalid, we drop back to undefined
          // (inherit) rather than falling through to a stale override.
          iconSize:
            typeof override.iconSize === "string" &&
            (ICON_SIZE_VALUES as readonly string[]).includes(override.iconSize)
              ? (override.iconSize as IconSize)
              : undefined,
          iconBordered:
            typeof override.iconBordered === "boolean"
              ? override.iconBordered
              : undefined,
          iconBgOpacity:
            typeof override.iconBgOpacity === "number" &&
            Number.isFinite(override.iconBgOpacity)
              ? Math.max(0, Math.min(100, Math.round(override.iconBgOpacity)))
              : undefined,
          presentation:
            override.presentation === "card" || override.presentation === "side-line"
              ? override.presentation
              : current.presentation,
          borderStyle:
            override.borderStyle === "solid" || override.borderStyle === "dashed"
              ? override.borderStyle
              : current.borderStyle,
          showRawPayload:
            typeof override.showRawPayload === "boolean"
              ? override.showRawPayload
              : current.showRawPayload,
        };
      }
    }
  }

  // Hard filters — migrate legacy keys (dropTaskLifecycle → hideSubagentLifecycle,
  // dropHookLifecycle → hideHookLifecycle). The five removed JSONL node-filter
  // keys (dropBookkeeping, dropHookSummaries, dropEmptyUser, dropClosureCarriers,
  // dropSystemInformational) are silently ignored on load from old saved configs.
  if (isRecord(saved.hardFilters)) {
    const hf = saved.hardFilters;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(hf, k);
    const bool = (k: string, fallback: boolean): boolean =>
      typeof hf[k] === "boolean" ? (hf[k] as boolean) : fallback;
    base.hardFilters = {
      hidePartialStreaming: bool("hidePartialStreaming", base.hardFilters.hidePartialStreaming),
      hideSubagentLifecycle: has("hideSubagentLifecycle")
        ? bool("hideSubagentLifecycle", base.hardFilters.hideSubagentLifecycle)
        : bool("dropTaskLifecycle", base.hardFilters.hideSubagentLifecycle),
      hideHookLifecycle: has("hideHookLifecycle")
        ? bool("hideHookLifecycle", base.hardFilters.hideHookLifecycle)
        : bool("dropHookLifecycle", base.hardFilters.hideHookLifecycle),
      hideRateLimitNotices: bool("hideRateLimitNotices", base.hardFilters.hideRateLimitNotices),
    };
  }

  if (isRecord(saved.typography)) {
    const t = saved.typography;
    base.typography = {
      header: mergeTypographyStyle(t.header, base.typography.header),
      content: mergeTypographyStyle(t.content, base.typography.content),
      icon: mergeIconStyle(t.icon, base.typography.icon),
    };
  }

  if (isRecord(saved.debug)) {
    const d = saved.debug;
    base.debug = {
      showCardKindLabel:
        typeof d.showCardKindLabel === "boolean"
          ? d.showCardKindLabel
          : base.debug.showCardKindLabel,
    };
  }

  if (isRecord(saved.terminal)) {
    const t = saved.terminal;
    if (isTypefaceId(t.typeface)) base.terminal.typeface = t.typeface;
    if (typeof t.fontSize === "number") base.terminal.fontSize = clampFontSize(t.fontSize);
    if (isTerminalCursorStyle(t.cursorStyle)) base.terminal.cursorStyle = t.cursorStyle;
    // Unknown / wrong-typed fields fall through to the defaults already on
    // `base.terminal` from createDefaultConfig() above.
  }

  return base;
}

const SIZE_VALUES: readonly FontSize[] = ["xs", "sm", "base", "lg"];
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
const ICON_SIZE_VALUES: readonly IconSize[] = ["xs", "sm", "base", "lg", "xl"];

function mergeTypographyStyle(
  saved: unknown,
  base: TypographyStyle,
): TypographyStyle {
  if (!isRecord(saved)) return base;
  const raw = saved;

  // Migration path: legacy records have a `family` field. Map it to a
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
    italic: typeof raw.italic === "boolean" ? raw.italic : base.italic,
  };
}

function mergeIconStyle(saved: unknown, base: IconStyle): IconStyle {
  if (!isRecord(saved)) return base;
  const s = saved;
  const opacity =
    typeof s.bgOpacity === "number" && Number.isFinite(s.bgOpacity)
      ? Math.max(0, Math.min(100, Math.round(s.bgOpacity)))
      : base.bgOpacity;
  return {
    size: ICON_SIZE_VALUES.includes(s.size as IconSize) ? (s.size as IconSize) : base.size,
    bordered: typeof s.bordered === "boolean" ? s.bordered : base.bordered,
    bgOpacity: opacity,
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

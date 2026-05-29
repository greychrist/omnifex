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
  // v3 catalog additions
  "GitPullRequest",
  "ShieldQuestion",
  "MessageCircleQuestion",
  // Unicode fallbacks
  "ℹ",
  "✗",
  "⚠",
  "none",
] as const;

export type IconName = (typeof ALLOWED_ICONS)[number];

// ─── message kinds ──────────────────────────────────────────────────────────

export type Origin = "user" | "assistant" | "system" | "cli" | "bookkeeping" | "fallback";
export type Alignment = "left" | "right" | "full";
export type Presentation = 'card' | 'side-line' | 'collapsible';
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
  iconBordered?: boolean;
  iconBgOpacity?: number; // 0–100

  // New in v2:
  presentation: Presentation;
  borderStyle: BorderStyle;
  /** Only meaningful on the `unknown` row. */
  showRawPayload?: boolean;
}

export type MessageKindsById = Record<string, MessageKindConfig>;

// ─── v3 category + override model ───────────────────────────────────────────
//
// Two-tier model: top-level CATEGORIES carry default styling for all kinds
// that belong to them; sparse OVERRIDES carry per-kind style patches on top.
// `resolveKind(config, id)` merges category ⊕ override and is the single
// source of truth for every kind's style; there is no flat catalog anymore.

export const CATEGORIES = ["user", "agent", "system", "attachment", "bookkeeping"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Styling fields shared by categories and overrides. Identity fields
 *  (id/label/description/origin) are NOT here. */
export interface KindStyle {
  presentation: Presentation;
  accentColor: string;
  icon: IconName;
  headerLabel: string | null;
  borderStyle: BorderStyle;
  alignment: Alignment;
  hiddenInCompact: boolean;
  compactBoundaryLocked?: boolean;
  widget?: string;
  showRawPayload?: boolean;
  iconBordered?: boolean;
  iconBgOpacity?: number;
}

export interface CategoryStyle extends KindStyle {
  label: string;
  description: string;
}

export const DEFAULT_CATEGORIES: Record<Category, CategoryStyle> = {
  user:        { label: "User",        description: "Your prompts, tool results, commands, injected context.",       presentation: "card",        accentColor: "blue",    icon: "User",     headerLabel: "You",    borderStyle: "solid",  alignment: "right", hiddenInCompact: false },
  agent:       { label: "Agent",       description: "Claude's text, thinking, tool calls, completions.",            presentation: "card",        accentColor: "primary", icon: "Bot",      headerLabel: "Claude", borderStyle: "solid",  alignment: "left",  hiddenInCompact: false },
  system:      { label: "System",      description: "Notifications, hooks, errors, lifecycle envelopes.",           presentation: "card",        accentColor: "muted",   icon: "Info",     headerLabel: null,     borderStyle: "solid",  alignment: "left",  hiddenInCompact: true },
  attachment:  { label: "Attachment",  description: "Harness-injected context (reminders, diagnostics, skills).",   presentation: "collapsible", accentColor: "muted",   icon: "Paperclip",headerLabel: null,     borderStyle: "solid",  alignment: "left",  hiddenInCompact: true, showRawPayload: true },
  bookkeeping: { label: "Bookkeeping", description: "Internal transcript records (hidden by default).",             presentation: "side-line",   accentColor: "muted",   icon: "FileText", headerLabel: null,     borderStyle: "dashed", alignment: "left",  hiddenInCompact: true },
};

const BOOKKEEPING_IDS = new Set([
  "pr-link", "mode", "last-prompt", "queue-operation",
  "ai-title", "file-history-snapshot", "permission-mode",
]);

export function originOf(kindId: string): Category {
  if (BOOKKEEPING_IDS.has(kindId)) return "bookkeeping";
  const head = kindId.split(".")[0];
  switch (head) {
    case "user": return "user";
    case "assistant": return "agent";
    case "attachment": return "attachment";
    // system, cli-stream-*, summary, permission, unknown → system bucket
    default: return "system";
  }
}

export const DEFAULT_OVERRIDES: Record<string, Partial<KindStyle> & { label?: string }> = {
  "user.prompt":                 { label: "User prompt",             compactBoundaryLocked: true },
  "assistant.text.endTurn":      { label: "Execution complete",      accentColor: "green",   icon: "CheckCircle2",        compactBoundaryLocked: true },
  "assistant.thinking":          { label: "Thinking",                presentation: "collapsible", headerLabel: "Thinking", icon: "Brain",               widget: "ThinkingWidget", hiddenInCompact: true },
  "assistant.tool-use":          { label: "Tool call",               accentColor: "info",    icon: "Terminal",            headerLabel: null,           hiddenInCompact: true },
  "user.systemContext":          { label: "System context",          presentation: "collapsible", icon: "Sparkles",        accentColor: "purple",       showRawPayload: true, alignment: "left", hiddenInCompact: false },
  "user.tool-result":            { label: "Tool result",             presentation: "side-line",   headerLabel: null,       alignment: "left",           hiddenInCompact: true },
  "user.command":                { label: "Slash command",           presentation: "side-line",   icon: "ChevronRight",    alignment: "left" },
  "system.notification.error":   { label: "Notification (error)",   accentColor: "red",     icon: "Bell",                presentation: "card",        hiddenInCompact: false },
  "system.notification.warn":    { label: "Notification (warn)",    accentColor: "amber",   icon: "Bell",                presentation: "card",        hiddenInCompact: false },
  "system.notification.stop":    { label: "Notification (stop)",    accentColor: "red",     icon: "Bell",                presentation: "card",        hiddenInCompact: false },
  "system.api_error":            { label: "API error",              accentColor: "red",     icon: "AlertTriangle",       presentation: "card",        hiddenInCompact: false },
  "system.compact_boundary":     { label: "Compacted",              icon: "Scissors",        presentation: "card",       widget: "CompactBoundaryWidget", hiddenInCompact: false },
  "summary.compaction":          { label: "Conversation summary",   icon: "FileText",        presentation: "card",       widget: "SummaryWidget",     hiddenInCompact: false, compactBoundaryLocked: true },
  "pr-link":                     { label: "Pull request",           presentation: "side-line",   icon: "GitPullRequest",  accentColor: "info",         hiddenInCompact: false },
  "permission.request":          { label: "Permission request",     presentation: "card",    icon: "ShieldQuestion",     accentColor: "amber",        hiddenInCompact: false },
  "permission.askUserQuestion":  { label: "Question",               presentation: "card",    icon: "MessageCircleQuestion", accentColor: "primary",   hiddenInCompact: false },
  // Answered-AskUserQuestion sentinels. `originOf` routes these through the
  // "system" category (head "tool" → default), which is hiddenInCompact:true.
  // Override both to visible + locked so compact grouping never folds them.
  "tool.askUserQuestion.answered":        { label: "Question (answered)",        hiddenInCompact: false, compactBoundaryLocked: true },
  "tool.askUserQuestion.answered.result": { label: "Question (answered result)", hiddenInCompact: false, compactBoundaryLocked: true },
  "unknown":                     { label: "Unknown",                presentation: "side-line", icon: "HelpCircle",        accentColor: "orange",       borderStyle: "dashed", headerLabel: "Unknown", hiddenInCompact: false, compactBoundaryLocked: true, showRawPayload: true },
};

// All kind ids the classifier can emit plus the curated overrides. Used by the
// settings UI to enumerate known kinds and by the coverage test. New CLI kinds
// not listed here still resolve via `originOf` + category defaults.
export const KNOWN_KIND_IDS: readonly string[] = [
  "assistant.text", "assistant.text.endTurn", "assistant.thinking", "assistant.tool-use",
  "user.prompt", "user.tool-result", "user.meta.skill", "user.meta.attachment",
  "user.meta.other", "user.subagentPrompt", "user.command", "user.commandOutput",
  "user.skillInjection", "user.systemContext", "user.sdkSystemBracket",
  "system.notification.info", "system.notification.warn", "system.notification.error",
  "system.notification.stop", "system.api_error", "system.stop_hook_summary",
  "system.hook_started", "system.hook_progress", "system.hook_response",
  "system.local_command", "system.turn_duration", "system.away_summary",
  "system.compact_boundary", "system.informational", "system.permission_denied",
  "system.userPromptSubmit", "system.unknown", "summary.compaction",
  "cli-stream-init", "cli-stream-result",
  "permission.request", "permission.askUserQuestion",
  "attachment.unknown", "attachment.todo_reminder", "attachment.task_reminder",
  "attachment.diagnostics", "attachment.command_permissions", "attachment.skill_listing",
  "attachment.deferred_tools_delta", "attachment.mcp_instructions_delta",
  "attachment.hook_success", "attachment.hook_additional_context",
  "attachment.edited_text_file", "attachment.nested_memory", "attachment.queued_command",
  "attachment.auto_mode", "attachment.hook_blocking_error", "attachment.date_change",
  "attachment.ultrathink_effort", "attachment.plan_mode_exit", "attachment.file",
  "attachment.compact_file_reference", "attachment.invoked_skills",
  "queue-operation", "permission-mode", "last-prompt", "ai-title",
  "file-history-snapshot", "unknown",
] as const;

// The styling fields shared by categories and overrides — everything that
// drives a card's look. Identity fields (id/label/description) are excluded.
export const STYLE_FIELDS: (keyof KindStyle)[] = [
  "presentation", "accentColor", "icon", "headerLabel", "borderStyle", "alignment",
  "hiddenInCompact", "compactBoundaryLocked", "widget", "showRawPayload",
  "iconBordered", "iconBgOpacity",
];

/**
 * Resolve a kind id to its full style: the category default for its origin,
 * shallow-merged with any per-kind override (override wins per field). Always
 * returns a complete style — there is no "missing kind" branch.
 */
export function resolveKind(config: MessageRenderingConfig, kindId: string): KindStyle {
  const base = config.categories[originOf(kindId)];
  const patch = config.overrides[kindId];
  return patch ? { ...base, ...patch } : { ...base };
}

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

export interface TypographyStyle {
  /** Catalog typeface ID. See src/lib/typefaceCatalog.ts. */
  typeface: Typeface;
  size: FontSize;
  weight: FontWeight;
  italic: boolean;
}

export interface IconStyle {
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
  icon: { bordered: true, bgOpacity: 100 },
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
  version: 3;
  defaultViewMode: "compact" | "verbose";
  categories: Record<Category, CategoryStyle>;
  overrides: Record<string, Partial<KindStyle> & { label?: string }>;
  palette: Palette;
  hardFilters: HardFilters;
  typography: Typography;
  terminal: Terminal;
  debug: DebugOptions;
}

export function createDefaultConfig(): MessageRenderingConfig {
  return {
    version: 3,
    defaultViewMode: "verbose",
    categories: structuredClone(DEFAULT_CATEGORIES),
    overrides: structuredClone(DEFAULT_OVERRIDES),
    palette: structuredClone(DEFAULT_PALETTE),
    hardFilters: { ...DEFAULT_HARD_FILTERS },
    typography: structuredClone(DEFAULT_TYPOGRAPHY),
    terminal: { ...DEFAULT_TERMINAL },
    debug: { ...DEFAULT_DEBUG },
  };
}

/**
 * Build a flat `MessageKindsById` view by resolving every known kind id
 * through `resolveKind`. This is a compatibility shim for the Appearance
 * settings UI, which still reads a flat catalog. Phase B replaces the UI with
 * category + override editors and this helper goes away.
 */
export function deriveKinds(config: MessageRenderingConfig): MessageKindsById {
  const out: MessageKindsById = {};
  const originToCatalogOrigin: Record<Category, Origin> = {
    user: "user",
    agent: "assistant",
    system: "system",
    attachment: "bookkeeping",
    bookkeeping: "bookkeeping",
  };
  for (const id of KNOWN_KIND_IDS) {
    const cat = originOf(id);
    const style = resolveKind(config, id);
    const override = config.overrides[id];
    const catStyle = config.categories[cat];
    out[id] = {
      id,
      label: override?.label ?? catStyle.label,
      description: catStyle.description,
      origin: id === "unknown" ? "fallback" : (id.startsWith("cli-") ? "cli" : originToCatalogOrigin[cat]),
      icon: style.icon,
      headerLabel: style.headerLabel,
      accentColor: style.accentColor,
      alignment: style.alignment,
      hiddenInCompact: style.hiddenInCompact,
      compactBoundaryLocked: style.compactBoundaryLocked ?? false,
      widget: style.widget,
      iconBordered: style.iconBordered,
      iconBgOpacity: style.iconBgOpacity,
      presentation: style.presentation,
      borderStyle: style.borderStyle,
      showRawPayload: style.showRawPayload,
    };
  }
  return out;
}

/**
 * Drop override fields that equal their category default; remove an override
 * entirely when nothing diverges. Keeps the persisted override map sparse.
 */
export function pruneRedundantOverrides(config: MessageRenderingConfig): MessageRenderingConfig {
  const overrides: MessageRenderingConfig["overrides"] = {};
  for (const [id, patch] of Object.entries(config.overrides)) {
    const base = config.categories[originOf(id)] as unknown as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (field === "label") continue; // label is identity, not style — always keep if present
      if (value !== (base as Record<string, unknown>)[field]) kept[field] = value;
    }
    if (patch.label !== undefined) kept.label = patch.label;
    // An override that only carries a label (no diverging style) is redundant.
    const styleFieldCount = Object.keys(kept).filter((k) => k !== "label").length;
    if (styleFieldCount > 0) {
      overrides[id] = kept as Partial<KindStyle> & { label?: string };
    }
  }
  return { ...config, overrides };
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

/**
 * Validate and coerce a single style field off a raw record. Returns the
 * accepted value, or `undefined` when the raw value is missing/invalid so the
 * caller can fall back to the inherited default.
 */
function validateStyleField(
  field: keyof KindStyle,
  raw: Record<string, unknown>,
  palette: Palette,
): unknown {
  if (!(field in raw)) return undefined;
  const v = raw[field];
  switch (field) {
    case "icon":
      return typeof v === "string" && (ALLOWED_ICONS as readonly string[]).includes(v) ? v : undefined;
    case "headerLabel":
      return v === null || typeof v === "string" ? v : undefined;
    case "accentColor":
      return typeof v === "string" && (v in palette || isHexColor(v)) ? v : undefined;
    case "alignment":
      return v === "left" || v === "right" || v === "full" ? v : undefined;
    case "presentation":
      return v === "card" || v === "side-line" || v === "collapsible" ? v : undefined;
    case "borderStyle":
      return v === "solid" || v === "dashed" ? v : undefined;
    case "hiddenInCompact":
    case "compactBoundaryLocked":
    case "showRawPayload":
    case "iconBordered":
      return typeof v === "boolean" ? v : undefined;
    case "iconBgOpacity":
      return typeof v === "number" && Number.isFinite(v)
        ? Math.max(0, Math.min(100, Math.round(v)))
        : undefined;
    case "widget":
      return typeof v === "string" ? v : undefined;
    default:
      return undefined;
  }
}

export function mergeConfig(saved: unknown): MessageRenderingConfig {
  const base = createDefaultConfig();
  if (!isRecord(saved)) return base;

  // v3: shallow-merge categories + overrides over the defaults.
  if (saved.version === 3) {
    if (isRecord(saved.categories)) {
      for (const c of CATEGORIES) {
        const sc = (saved.categories as Record<string, unknown>)[c];
        if (isRecord(sc)) {
          const patch: Record<string, unknown> = {};
          for (const f of STYLE_FIELDS) {
            const val = validateStyleField(f, sc, base.palette);
            if (val !== undefined) patch[f] = val;
          }
          if (typeof sc.label === "string") patch.label = sc.label;
          if (typeof sc.description === "string") patch.description = sc.description;
          base.categories[c] = { ...base.categories[c], ...patch } as CategoryStyle;
        }
      }
    }
    if (isRecord(saved.overrides)) {
      for (const [id, entry] of Object.entries(saved.overrides as Record<string, unknown>)) {
        if (!isRecord(entry)) continue;
        const patch: Partial<KindStyle> & { label?: string } = {};
        for (const f of STYLE_FIELDS) {
          const val = validateStyleField(f, entry, base.palette);
          if (val !== undefined) (patch as Record<string, unknown>)[f] = val;
        }
        if (typeof entry.label === "string") patch.label = entry.label;
        base.overrides[id] = { ...base.overrides[id], ...patch };
      }
    }
    return mergeShared(base, saved);
  }

  // v2 (or pre-v2): convert each customized flat kind into a sparse override
  // by diffing its style fields against the resolved category default. Fields
  // that already match the default produce no override entry.
  if (isRecord(saved.kinds)) {
    for (const [id, entry] of Object.entries(saved.kinds as Record<string, unknown>)) {
      if (!isRecord(entry)) continue;
      const resolved = resolveKind(base, id) as unknown as Record<string, unknown>;
      const diff: Record<string, unknown> = {};
      for (const f of STYLE_FIELDS) {
        const val = validateStyleField(f, entry, base.palette);
        if (val !== undefined && val !== resolved[f]) diff[f] = val;
      }
      if (Object.keys(diff).length > 0) {
        base.overrides[id] = { ...base.overrides[id], ...diff } as Partial<KindStyle> & { label?: string };
      }
    }
  }

  return mergeShared(base, saved);
}

/**
 * Merge the shared (non-kind) config blocks — view mode, palette, hard
 * filters, typography, debug, terminal — from a saved record onto `base`.
 * Used by both the v3 pass-through and the v2→v3 migration branches.
 */
function mergeShared(
  base: MessageRenderingConfig,
  saved: Record<string, unknown>,
): MessageRenderingConfig {
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

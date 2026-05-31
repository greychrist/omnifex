// Message-rendering config — data model, defaults, and live resolver.
//
// This module is the source of truth for message-kind styling. It owns:
//   • KIND_REGISTRY — maps kind id → category + built-in default chrome.
//   • resolveKind — three-layer merge: category base → registry default →
//     per-kind user patch (config.kinds[id]). All rendering decisions go
//     through this single function.
// The settings screen reads and writes this config via
// `api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, ...)`.

import { isTypefaceId, type Typeface } from "./typefaceCatalog";
import type { JsonlNode } from "@/types/jsonl";

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
  // Extended catalog additions
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
  // Permission / question icons
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

export type Alignment = "left" | "right" | "full";
export type Presentation = 'card' | 'side-line' | 'collapsible';
export type BorderStyle = 'solid' | 'dashed';

// ─── category + kind registry model ─────────────────────────────────────────
//
// Three-layer model: CATEGORIES carry default styling for all kinds in them;
// KIND_REGISTRY carries built-in per-kind chrome layered on top; and
// config.kinds carries sparse user patches as the final layer.
// `resolveKind(config, id)` merges all three and is the single source of
// truth for every kind's effective style. There is no match engine or
// overrides array in this path.

export const CATEGORIES = ["user", "agent", "system"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Styling fields shared by categories and kind registry entries. Identity
 *  fields (id/label/description) are NOT here. */
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

export interface KindDef {
  id: string;
  category: Category;
  label: string;
  description: string;
  /** Built-in chrome for this kind, layered over the category base. */
  default: Partial<KindStyle>;
}

export const KIND_REGISTRY: Record<string, KindDef> = {
  // ── agent ──
  "assistant.text": { id: "assistant.text", category: "agent", label: "Assistant text", description: "Claude's reply text.", default: {} },
  "assistant.text.endTurn": { id: "assistant.text.endTurn", category: "agent", label: "Execution complete", description: "Final assistant text that ended the turn.", default: { accentColor: "green", icon: "CheckCircle2", compactBoundaryLocked: true } },
  "assistant.thinking": { id: "assistant.thinking", category: "agent", label: "Thinking", description: "Extended-thinking blocks.", default: { presentation: "collapsible", headerLabel: "Thinking", icon: "Brain", widget: "ThinkingWidget", hiddenInCompact: true } },
  "assistant.tool-use": { id: "assistant.tool-use", category: "agent", label: "Tool call", description: "Claude invoking a tool.", default: { accentColor: "info", icon: "Terminal", headerLabel: null, hiddenInCompact: true } },
  "assistant.askUserQuestion": { id: "assistant.askUserQuestion", category: "agent", label: "Question (answered)", description: "An answered AskUserQuestion card.", default: { presentation: "card", icon: "MessageCircleQuestion", accentColor: "indigo", hiddenInCompact: false } },
  // ── user ──
  "user.prompt": { id: "user.prompt", category: "user", label: "User prompt", description: "What you typed.", default: { compactBoundaryLocked: true } },
  "user.command": { id: "user.command", category: "user", label: "Slash command", description: "A `/command` you ran.", default: { presentation: "side-line", icon: "ChevronRight", alignment: "left" } },
  "user.commandOutput": { id: "user.commandOutput", category: "user", label: "Command output", description: "Local stdout from a slash command.", default: { presentation: "side-line", alignment: "left", hiddenInCompact: true } },
  "user.subagentPrompt": { id: "user.subagentPrompt", category: "user", label: "Subagent prompt", description: "A prompt generated for a subagent.", default: { icon: "Bot", accentColor: "amber", alignment: "left" } },
  "user.skillInjection": { id: "user.skillInjection", category: "user", label: "Skill injection", description: "Skill body injected into the conversation.", default: { presentation: "collapsible", icon: "Sparkles", accentColor: "purple", alignment: "left" } },
  "user.systemContext": { id: "user.systemContext", category: "user", label: "System context", description: "Hook feedback, system-reminders, skill preambles.", default: { presentation: "collapsible", icon: "Sparkles", accentColor: "purple", showRawPayload: true, alignment: "left", hiddenInCompact: false } },
  "user.sdkSystemBracket": { id: "user.sdkSystemBracket", category: "user", label: "System notice", description: "CLI bracket notices like [Request interrupted].", default: { presentation: "side-line", icon: "Info", alignment: "left" } },
  "user.tool-result": { id: "user.tool-result", category: "user", label: "Tool result", description: "Output returned from a tool call.", default: { presentation: "side-line", headerLabel: null, alignment: "left", hiddenInCompact: true } },
  "user.image": { id: "user.image", category: "user", label: "Image", description: "A pasted or attached image.", default: { icon: "Image", alignment: "left" } },
  // ── system ──
  "system.notification.info": { id: "system.notification.info", category: "system", label: "Notification (info)", description: "Informational CLI notification.", default: { icon: "Bell", presentation: "card", hiddenInCompact: false } },
  "system.notification.warn": { id: "system.notification.warn", category: "system", label: "Notification (warn)", description: "Warning CLI notification.", default: { accentColor: "amber", icon: "Bell", presentation: "card", hiddenInCompact: false } },
  "system.notification.error": { id: "system.notification.error", category: "system", label: "Notification (error)", description: "Error CLI notification.", default: { accentColor: "red", icon: "Bell", presentation: "card", hiddenInCompact: false } },
  "system.notification.stop": { id: "system.notification.stop", category: "system", label: "Notification (stop)", description: "Stop CLI notification.", default: { accentColor: "red", icon: "Bell", presentation: "card", hiddenInCompact: false } },
  "system.hook_started": { id: "system.hook_started", category: "system", label: "Hook started", description: "A hook began running.", default: { icon: "Hook" } },
  "system.hook_response": { id: "system.hook_response", category: "system", label: "Hook response", description: "A hook returned.", default: { icon: "Hook" } },
  "system.permission_denied": { id: "system.permission_denied", category: "system", label: "Permission denied", description: "A tool permission was denied.", default: { accentColor: "red", icon: "ShieldX", presentation: "card", hiddenInCompact: false } },
  "system.userPromptSubmit": { id: "system.userPromptSubmit", category: "system", label: "Prompt submitted", description: "UserPromptSubmit lifecycle envelope.", default: { icon: "Send" } },
  "system.api_error": { id: "system.api_error", category: "system", label: "API error", description: "An API or tool error.", default: { accentColor: "red", icon: "AlertTriangle", presentation: "card", hiddenInCompact: false } },
  "system.unknown": { id: "system.unknown", category: "system", label: "System (other)", description: "Any unrecognized system subtype.", default: { icon: "Info" } },
  "permission.request": { id: "permission.request", category: "system", label: "Permission request", description: "Live tool-permission prompt.", default: { presentation: "card", icon: "ShieldQuestion", accentColor: "amber", hiddenInCompact: false } },
  "permission.askUserQuestion": { id: "permission.askUserQuestion", category: "system", label: "Question (live)", description: "Live AskUserQuestion prompt.", default: { presentation: "card", icon: "MessageCircleQuestion", accentColor: "indigo", hiddenInCompact: false } },
  // ── summary / fallback (resolve to system) ──
  "summary.compaction": { id: "summary.compaction", category: "system", label: "Conversation summary", description: "Compaction summary card.", default: { icon: "FileText", presentation: "card", widget: "SummaryWidget", hiddenInCompact: false, compactBoundaryLocked: true } },
  "unknown": { id: "unknown", category: "system", label: "Unknown", description: "Unclassifiable message — shows raw payload.", default: { presentation: "side-line", icon: "HelpCircle", accentColor: "orange", borderStyle: "dashed", headerLabel: "Unknown", hiddenInCompact: false, compactBoundaryLocked: true, showRawPayload: true } },
};

export function categoryOf(id: string): Category {
  return KIND_REGISTRY[id]?.category ?? "system";
}

export const DEFAULT_CATEGORIES: Record<Category, CategoryStyle> = {
  user:   { label: "User",   description: "Your prompts, commands, tool results, injected context.", presentation: "card", accentColor: "blue",    icon: "User", headerLabel: "You",    borderStyle: "solid", alignment: "right", hiddenInCompact: false },
  agent:  { label: "Agent",  description: "Claude's text, thinking, tool calls, completions.",        presentation: "card", accentColor: "primary", icon: "Bot",  headerLabel: "Claude", borderStyle: "solid", alignment: "left",  hiddenInCompact: false },
  system: { label: "System", description: "Notifications, hooks, errors, lifecycle, prompts.",         presentation: "card", accentColor: "muted",   icon: "Info", headerLabel: null,     borderStyle: "solid", alignment: "left",  hiddenInCompact: true  },
};

// ─── style fields ────────────────────────────────────────────────────────────

// The styling fields shared by categories and kind registry entries — everything
// that drives a card's look. Identity fields (id/label/description) are excluded.
export const STYLE_FIELDS: (keyof KindStyle)[] = [
  "presentation", "accentColor", "icon", "headerLabel", "borderStyle", "alignment",
  "hiddenInCompact", "compactBoundaryLocked", "widget", "showRawPayload",
  "iconBordered", "iconBgOpacity",
];

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

// ─── legacy origin resolver (used by pre-v5 mergeConfig branches) ────────────

const BOOKKEEPING_IDS = new Set([
  "pr-link", "mode", "last-prompt", "queue-operation",
  "ai-title", "file-history-snapshot", "permission-mode",
]);

export function originOf(kindId: string): Category {
  if (BOOKKEEPING_IDS.has(kindId)) return "system";
  const head = kindId.split(".")[0];
  switch (head) {
    case "user": return "user";
    case "assistant": return "agent";
    default: return "system";
  }
}

// ─── legacy override matchers ────────────────────────────────────────────────
//
// Used by pre-v5 mergeConfig branches and by UI components that match saved
// overrides against messages. These types and helpers remain for backward
// compatibility with persisted configs that contain an overrides array.

export type MatchOp = "eq" | "contains" | "regex";

/** A single `path op value` triple tested against a message. */
export interface MatchCondition {
  path: string;
  op: MatchOp;
  value: string | number | boolean | null;
}

/** A user-authored, category-scoped style rule. */
export interface Override {
  /** Stable, unique id. */
  id: string;
  label: string;
  /** Scope + base style + tree grouping. */
  category: Category;
  /** Conditions ANDed together; empty ⇒ matches every message in `category`. */
  match: MatchCondition[];
  /** Sparse style patch edited in the right panel. */
  style: Partial<KindStyle>;
}

/** A matchable message: a real `JsonlNode` (render/list path) or any bare
 *  `{ raw }` bag (previews, tests). */
type JsonlNodeLike = JsonlNode | { raw?: unknown };

/**
 * Resolve a dotted path against a raw message object, returning the set of
 * values it reaches.
 */
export function getByPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = root == null ? [] : [root];
  for (const seg of path.split(".")) {
    const isArray = seg.endsWith("[]");
    const key = isArray ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const c of current) {
      if (c == null || typeof c !== "object") continue;
      const v = (c as Record<string, unknown>)[key];
      if (isArray) {
        if (Array.isArray(v)) next.push(...v);
      } else {
        next.push(v);
      }
    }
    current = next;
  }
  return current;
}

function valuesForPath(
  message: JsonlNodeLike | undefined,
  kindId: string,
  category: Category,
  path: string,
): unknown[] {
  if (path === "$kind") return [kindId];
  if (path === "$category") return [category];
  const raw = message ? (message as { raw?: unknown }).raw : undefined;
  return getByPath(raw, path);
}

function valueSatisfies(value: unknown, op: MatchOp, literal: MatchCondition["value"]): boolean {
  switch (op) {
    case "eq":
      return value === literal;
    case "contains":
      return typeof value === "string" && typeof literal === "string" && value.includes(literal);
    case "regex":
      if (typeof value !== "string" || typeof literal !== "string") return false;
      try {
        return new RegExp(literal).test(value);
      } catch {
        return false;
      }
  }
}

/**
 * True when every condition holds (AND). A condition holds when at least one
 * value its path resolves to satisfies the operator. An empty condition list
 * matches every message (specificity 0).
 */
export function conditionsMatch(
  match: MatchCondition[],
  message: JsonlNodeLike | undefined,
  kindId: string,
  category: Category,
): boolean {
  for (const c of match) {
    const candidates = valuesForPath(message, kindId, category, c.path);
    if (!candidates.some((v) => valueSatisfies(v, c.op, c.value))) return false;
  }
  return true;
}

/**
 * Full cascade resolution for a specific message using the legacy overrides
 * array. Used by pre-v5 mergeConfig branches and components that read saved
 * override arrays from older persisted configs.
 */
export function resolveMessageStyle(
  config: MessageRenderingConfig,
  message: JsonlNodeLike | undefined,
  kindId: string,
): KindStyle {
  const category = originOf(kindId);
  const base = config.categories[category];
  const hits = (config.overrides ?? [])
    .filter((o) => o.category === category && conditionsMatch(o.match, message, kindId, category))
    .slice()
    .sort((a, b) => a.match.length - b.match.length);
  return hits.reduce<KindStyle>((acc, o) => ({ ...acc, ...o.style }), { ...base });
}

/**
 * Produce an effective config whose category base for `kindId`'s origin is
 * replaced by `style`. Used by MessageFrame and the Appearance preview.
 */
export function withResolvedKindStyle(
  config: MessageRenderingConfig,
  kindId: string,
  style: KindStyle,
): MessageRenderingConfig {
  const cat = originOf(kindId);
  return {
    ...config,
    categories: {
      ...config.categories,
      [cat]: { ...config.categories[cat], ...style } as CategoryStyle,
    },
  };
}

// ─── typography ─────────────────────────────────────────────────────────────
//
// Global typography applied to every message kind. Two style slots — the
// `header` row that sits above a card's body, and the `content` body text.
// Per-kind typography customization is intentionally out of scope; one pair
// of sliders keeps the UI simple and the config small.

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
  version: 4;
  defaultViewMode: "compact" | "verbose";
  categories: Record<Category, CategoryStyle>;
  /** Per-kind user style patches — the third layer of resolveKind. */
  kinds: Record<string, Partial<KindStyle>>;
  overrides: Override[];
  palette: Palette;
  hardFilters: HardFilters;
  typography: Typography;
  terminal: Terminal;
  debug: DebugOptions;
}

export function createDefaultConfig(): MessageRenderingConfig {
  return {
    version: 4,
    defaultViewMode: "verbose",
    categories: structuredClone(DEFAULT_CATEGORIES),
    kinds: {},
    overrides: [],
    palette: structuredClone(DEFAULT_PALETTE),
    hardFilters: { ...DEFAULT_HARD_FILTERS },
    typography: structuredClone(DEFAULT_TYPOGRAPHY),
    terminal: { ...DEFAULT_TERMINAL },
    debug: { ...DEFAULT_DEBUG },
  };
}

/**
 * Drop override fields that equal their category default; remove an override
 * entirely when nothing diverges. Keeps the persisted override map sparse.
 *
 * `exempt` lists override ids that must survive even when fully redundant —
 * used by the settings UI so a freshly added (still-empty) override the user
 * is actively editing isn't pruned out from under them before they diverge a
 * field. Exempt overrides still have redundant *fields* trimmed.
 */
export function pruneRedundantOverrides(
  config: MessageRenderingConfig,
  exempt: ReadonlySet<string> = new Set(),
): MessageRenderingConfig {
  const overrides: Override[] = [];
  for (const o of config.overrides) {
    const base = config.categories[o.category] as unknown as Record<string, unknown>;
    const keptStyle: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(o.style)) {
      if (value !== base[field]) keptStyle[field] = value;
    }
    // A rule that carries match conditions is never dropped — it expresses an
    // intentional grouping even when its style is empty. Style-only redundancy
    // (no conditions, no diverging fields) is pruned unless the rule is the
    // one being actively edited (exempt).
    const hasStyle = Object.keys(keptStyle).length > 0;
    const hasMatch = o.match.length > 0;
    if (hasStyle || hasMatch || exempt.has(o.id)) {
      overrides.push({ ...o, style: keptStyle as Partial<KindStyle> });
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

/** Shallow-merge saved category styles over the defaults already on `base`. */
function mergeCategories(base: MessageRenderingConfig, saved: Record<string, unknown>): void {
  if (!isRecord(saved.categories)) return;
  for (const c of CATEGORIES) {
    const sc = (saved.categories as Record<string, unknown>)[c];
    if (!isRecord(sc)) continue;
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

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

const MATCH_OPS: readonly MatchOp[] = ["eq", "contains", "regex"];

/** Validate a raw match list into well-formed conditions, dropping junk. */
function validateMatch(raw: unknown): MatchCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: MatchCondition[] = [];
  for (const c of raw) {
    if (!isRecord(c)) continue;
    if (typeof c.path !== "string") continue;
    if (!(MATCH_OPS as readonly string[]).includes(c.op as string)) continue;
    const v = c.value;
    if (!(typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null)) continue;
    out.push({ path: c.path, op: c.op as MatchOp, value: v });
  }
  return out;
}

/** Validate a sparse style patch off a raw record (the override's `style`). */
function validateStylePatch(rawStyle: unknown, palette: Palette): Partial<KindStyle> {
  const patch: Partial<KindStyle> = {};
  if (!isRecord(rawStyle)) return patch;
  for (const f of STYLE_FIELDS) {
    const val = validateStyleField(f, rawStyle, palette);
    if (val !== undefined) (patch as Record<string, unknown>)[f] = val;
  }
  return patch;
}

/** Validate a saved override object from a persisted config. Returns null when it lacks an id. */
function validateOverride(entry: unknown, base: MessageRenderingConfig): Override | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.id !== "string" || entry.id === "") return null;
  const id = entry.id;
  const category = isCategory(entry.category) ? entry.category : originOf(id);
  const label = typeof entry.label === "string" ? entry.label : id;
  return {
    id,
    label,
    category,
    match: validateMatch(entry.match),
    style: validateStylePatch(entry.style, base.palette),
  };
}

/** Upsert a `$kind eq <id>` style patch onto an Override[] (used during pre-v5 config conversion). */
function upsertKindOverride(overrides: Override[], id: string, stylePatch: Partial<KindStyle>): void {
  const existing = overrides.find(
    (o) => o.id === id && o.match.length === 1 && o.match[0].path === "$kind",
  );
  if (existing) {
    existing.style = { ...existing.style, ...stylePatch };
  } else {
    overrides.push(kindOverride(id, id, stylePatch));
  }
}

export function mergeConfig(saved: unknown): MessageRenderingConfig {
  const base = createDefaultConfig();
  if (!isRecord(saved)) return base;

  // v5 (current): categories shallow-merged; kinds map validated entry by entry;
  // shared blocks merged last. The saved overrides array is authoritative —
  // defaults the user deleted must stay deleted.
  if (saved.version === 4) {
    mergeCategories(base, saved);
    if (Array.isArray(saved.overrides)) {
      base.overrides = saved.overrides
        .map((e) => validateOverride(e, base))
        .filter((o): o is Override => o !== null);
    }
    return mergeShared(base, saved);
  }

  // Pre-v5 (version 3): override record was keyed by kind id. Convert each
  // entry into a `$kind eq <id>` rule so it survives in the overrides array.
  // The saved record is authoritative (replaces the defaults).
  if (saved.version === 3) {
    mergeCategories(base, saved);
    if (isRecord(saved.overrides)) {
      const converted: Override[] = [];
      for (const [id, entry] of Object.entries(saved.overrides as Record<string, unknown>)) {
        if (!isRecord(entry)) continue;
        const label = typeof entry.label === "string" ? entry.label : id;
        converted.push({
          id,
          label,
          category: originOf(id),
          match: [{ path: "$kind", op: "eq", value: id }],
          style: validateStylePatch(entry, base.palette),
        });
      }
      base.overrides = converted;
    }
    return mergeShared(base, saved);
  }

  // Pre-v5 (version 2 or older): convert each customized flat kind into a
  // `$kind` override by diffing its style fields against the category default.
  // Additive — layered onto the seeded defaults so unrelated entries survive.
  if (isRecord(saved.kinds)) {
    for (const [id, entry] of Object.entries(saved.kinds as Record<string, unknown>)) {
      if (!isRecord(entry)) continue;
      // Diff against the kind's CURRENT effective style (category base merged
      // with the seeded default), so a saved value that diverges from a seeded
      // default is captured even when it equals the bare category base.
      const resolved = resolveMessageStyle(base, { raw: {} }, id) as unknown as Record<string, unknown>;
      const diff: Partial<KindStyle> = {};
      for (const f of STYLE_FIELDS) {
        const val = validateStyleField(f, entry, base.palette);
        if (val !== undefined && val !== resolved[f]) (diff as Record<string, unknown>)[f] = val;
      }
      if (Object.keys(diff).length > 0) {
        upsertKindOverride(base.overrides, id, diff);
      }
    }
  }

  return mergeShared(base, saved);
}

/**
 * Merge the shared (non-kind) config blocks — view mode, palette, hard
 * filters, typography, debug, terminal — from a saved record onto `base`.
 * Used by all mergeConfig version branches after their version-specific work.
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

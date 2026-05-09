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
  // Unicode fallbacks
  "ℹ",
  "✗",
  "⚠",
  "none",
] as const;

export type IconName = (typeof ALLOWED_ICONS)[number];

// ─── message kinds ──────────────────────────────────────────────────────────

export type Origin = "user" | "assistant" | "system" | "tool" | "subagent";
export type Alignment = "left" | "right" | "full";

export interface MessageKindConfig {
  id: string;
  label: string; // display name in the settings UI
  description: string; // one-line help text
  origin: Origin;
  icon: IconName;
  headerLabel: string | null; // null => no header text
  accentColor: PaletteName;
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
}

export type MessageKindsById = Record<string, MessageKindConfig>;

export const DEFAULT_KINDS: MessageKindConfig[] = [
  // USER
  {
    id: "user.prompt",
    label: "User prompt",
    description: "Your typed message. Right-aligned user card.",
    origin: "user",
    icon: "User",
    headerLabel: "You",
    accentColor: "blue",
    alignment: "right",
    hiddenInCompact: false,
    compactBoundaryLocked: true,
  },
  {
    id: "user.image",
    label: "Pasted image",
    description: "Base64 images pasted or dragged into a user message.",
    origin: "user",
    icon: "none",
    headerLabel: "Pasted image",
    accentColor: "blue",
    alignment: "right",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
  },
  {
    id: "user.subagentPrompt",
    label: "Subagent prompt",
    description: "Prompts generated by the Task tool for subagent runs.",
    origin: "subagent",
    icon: "Bot",
    headerLabel: null,
    accentColor: "amber",
    alignment: "left",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },
  {
    id: "user.sdkSystemBracket",
    label: "SDK system message",
    description: "Short bracketed SDK notices like [Request interrupted].",
    origin: "system",
    icon: "ℹ",
    headerLabel: "SDK System Message",
    accentColor: "info",
    alignment: "full",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },
  {
    id: "user.systemContext",
    label: "System context",
    description: "Skill/CLAUDE.md/system-reminder context injections.",
    origin: "system",
    icon: "Info",
    headerLabel: "System Context",
    accentColor: "gray",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
    widget: "SystemWidget",
  },
  {
    id: "user.skillInjection",
    label: "Skill injection",
    description: "User-role message injected by the SDK after a Skill tool runs (the SKILL.md body).",
    origin: "system",
    icon: "Sparkles",
    // Headerless — the renderer shows a dynamic "Skill: {skillName}" line
    // below the header row, which would conflict with a static label.
    headerLabel: null,
    accentColor: "purple",
    alignment: "right",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
  },
  {
    id: "user.command",
    label: "Slash command",
    description: "User-issued slash command echoed by the CLI (e.g. /clear, /model).",
    origin: "user",
    icon: "Terminal",
    headerLabel: null,
    accentColor: "blue",
    alignment: "right",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
    widget: "CommandWidget",
  },
  {
    id: "user.commandOutput",
    label: "Slash command output",
    description: "Output captured from a local slash command (CLI stdout).",
    origin: "user",
    icon: "Terminal",
    headerLabel: null,
    accentColor: "green",
    alignment: "right",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
    widget: "CommandOutputWidget",
  },

  // ASSISTANT
  {
    id: "assistant.text",
    label: "Assistant text",
    description: "Claude's markdown-rendered reply content.",
    origin: "assistant",
    icon: "Bot",
    headerLabel: null,
    accentColor: "primary",
    alignment: "left",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
  },
  {
    id: "assistant.thinking",
    label: "Thinking",
    description: "Extended thinking blocks. Collapsible widget.",
    origin: "assistant",
    icon: "none",
    headerLabel: null,
    accentColor: "primary",
    alignment: "left",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
    widget: "ThinkingWidget",
  },
  {
    id: "assistant.toolUse",
    label: "Tool use",
    description: "Tool invocations. Per-tool widgets (Bash, Edit, etc.).",
    origin: "tool",
    icon: "Terminal",
    headerLabel: null,
    accentColor: "primary",
    alignment: "left",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
    widget: "@tool",
  },
  {
    id: "assistant.toolUse.unknown",
    label: "Tool use (unknown)",
    description: "Tool invocations whose tool name has no specialized widget. Fallback Terminal + JSON dump.",
    origin: "tool",
    icon: "Terminal",
    headerLabel: null,
    accentColor: "muted",
    alignment: "left",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },

  // TOOL RESULTS
  {
    id: "tool.result.generic",
    label: "Tool result",
    description: "Result of a tool call. Hidden when widget already rendered.",
    origin: "tool",
    icon: "Terminal",
    headerLabel: "Tool Result",
    accentColor: "muted",
    alignment: "left",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },
  {
    id: "tool.result.systemReminder",
    label: "System reminder (in result)",
    description: "Embedded <system-reminder> extracted from tool results.",
    origin: "system",
    icon: "Info",
    headerLabel: "System Reminder",
    accentColor: "gray",
    alignment: "left",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
    widget: "SystemReminderWidget",
  },

  // RESULT
  {
    id: "result.success",
    label: "Execution complete",
    description: "Successful turn result. Shows cost, duration, tokens.",
    origin: "system",
    icon: "CheckCircle2",
    headerLabel: "Execution Complete",
    accentColor: "green",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: true,
  },
  {
    id: "result.error",
    label: "Execution failed",
    description: "Failed turn result. Shows error message and metrics.",
    origin: "system",
    icon: "AlertCircle",
    headerLabel: "Execution Failed",
    accentColor: "red",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: true,
  },
  {
    id: "result.awaiting_background",
    label: "Awaiting background work",
    description:
      "Turn ended while a background subagent dispatch is still running. Parent will resume on wake-up.",
    origin: "system",
    icon: "Hourglass",
    headerLabel: "Awaiting Background Work",
    accentColor: "amber",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: true,
  },

  // SYSTEM
  {
    id: "system.init",
    label: "System init",
    description: "Session bootstrap info: model, cwd, tool registry.",
    origin: "system",
    icon: "Settings",
    headerLabel: "System Initialized",
    accentColor: "sysInit",
    alignment: "full",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
    widget: "SystemInitWidget",
  },
  {
    id: "system.notification.error",
    label: "Error notification",
    description: "API errors, rate limits, fatal notifications.",
    origin: "system",
    icon: "✗",
    headerLabel: null,
    accentColor: "red",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
  },
  {
    id: "system.notification.stop",
    label: "Stop notification",
    description: "User-initiated or SDK stop signals.",
    origin: "system",
    icon: "CircleStop",
    headerLabel: null,
    accentColor: "red",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
  },
  {
    id: "system.notification.warn",
    label: "Warning notification",
    description: "Non-fatal SDK warnings.",
    origin: "system",
    icon: "⚠",
    headerLabel: null,
    accentColor: "info",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
  },
  {
    id: "system.notification.info",
    label: "Info notification",
    description: "Informational SDK notices.",
    origin: "system",
    icon: "none",
    headerLabel: null,
    accentColor: "info",
    alignment: "full",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },
  {
    id: "system.hook.started",
    label: "Hook started",
    description: "SDK lifecycle event fired when a configured hook begins.",
    origin: "system",
    icon: "Plug",
    headerLabel: null,
    accentColor: "muted",
    alignment: "full",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },
  {
    id: "system.hook.response",
    label: "Hook response",
    description: "SDK lifecycle event reporting a hook's exit code and output.",
    origin: "system",
    icon: "Plug",
    headerLabel: null,
    accentColor: "muted",
    alignment: "full",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },
  {
    id: "system.userPromptSubmit",
    label: "User-prompt-submit lifecycle",
    description: "SDK lifecycle event emitted when a user prompt is accepted, before any UserPromptSubmit hook runs.",
    origin: "system",
    icon: "Send",
    headerLabel: null,
    accentColor: "muted",
    alignment: "full",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },
  {
    id: "system.unknown",
    label: "System event (unknown)",
    description: "Fallback for system messages whose subtype is not init / notification / a hook lifecycle. Inline gray text.",
    origin: "system",
    icon: "Info",
    headerLabel: null,
    accentColor: "muted",
    alignment: "full",
    hiddenInCompact: true,
    compactBoundaryLocked: false,
  },

  // PERMISSION / SUMMARY
  {
    id: "permission.request",
    label: "Permission request",
    description: "Permission prompt. Always shown.",
    origin: "system",
    icon: "none",
    headerLabel: null,
    accentColor: "amber",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
    widget: "PermissionCard",
  },
  {
    // Sibling of permission.request, but specifically the agent's built-in
    // AskUserQuestion tool. The renderer branches on toolName so this card
    // can carry its own accent color independent of the generic Bash/Read
    // permission prompt — they're qualitatively different interactions
    // (agent asking the user vs. user gating the agent).
    id: "permission.askUserQuestion",
    label: "Agent question (AskUserQuestion)",
    description: "Multiple-choice question card the agent surfaces via the AskUserQuestion tool.",
    origin: "system",
    icon: "CircleHelp",
    headerLabel: null,
    accentColor: "purple",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
    widget: "AskUserQuestionCard",
  },
  {
    id: "summary.compaction",
    label: "Compaction summary",
    description: "Summary block generated by context compaction.",
    origin: "system",
    icon: "none",
    headerLabel: null,
    accentColor: "gray",
    alignment: "full",
    hiddenInCompact: false,
    compactBoundaryLocked: false,
    widget: "SummaryWidget",
  },
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
  dropMeta: boolean;
  dropTaskLifecycle: boolean;
  dropEmptyUser: boolean;
  dropHookLifecycle: boolean;
}

export const DEFAULT_HARD_FILTERS: HardFilters = {
  dropMeta: true,
  dropTaskLifecycle: true,
  dropEmptyUser: true,
  dropHookLifecycle: true,
};

// ─── debug ──────────────────────────────────────────────────────────────────

export interface DebugOptions {
  /** When true, every message card renders its raw SDK type (and subtype if
   *  present) on the bottom-left, so mis-classified cards are obvious. */
  showCardKindLabel: boolean;
}

export const DEFAULT_DEBUG: DebugOptions = {
  showCardKindLabel: false,
};

// ─── top-level config ───────────────────────────────────────────────────────

export interface MessageRenderingConfig {
  version: 1;
  defaultViewMode: "compact" | "verbose";
  palette: Palette;
  kinds: MessageKindsById;
  hardFilters: HardFilters;
  typography: Typography;
  debug: DebugOptions;
}

export function createDefaultConfig(): MessageRenderingConfig {
  const kinds: MessageKindsById = {};
  for (const k of DEFAULT_KINDS) kinds[k.id] = { ...k };
  return {
    version: 1,
    defaultViewMode: "verbose",
    palette: structuredClone(DEFAULT_PALETTE),
    kinds,
    hardFilters: { ...DEFAULT_HARD_FILTERS },
    typography: structuredClone(DEFAULT_TYPOGRAPHY),
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

export function mergeConfig(saved: unknown): MessageRenderingConfig {
  const base = createDefaultConfig();
  if (!isRecord(saved)) return base;

  if (saved.defaultViewMode === "compact" || saved.defaultViewMode === "verbose") {
    base.defaultViewMode = saved.defaultViewMode;
  }

  if (isRecord(saved.palette)) {
    for (const key of Object.keys(base.palette) as PaletteName[]) {
      const entry = (saved.palette as Record<string, unknown>)[key];
      if (isRecord(entry)) {
        const current = base.palette[key];
        base.palette[key] = {
          border: typeof entry.border === "string" ? entry.border : current.border,
          bg: typeof entry.bg === "string" || entry.bg === null ? (entry.bg as string | null) : current.bg,
          swatch: typeof entry.swatch === "string" ? entry.swatch : current.swatch,
        };
      }
    }
  }

  if (isRecord(saved.kinds)) {
    for (const id of Object.keys(base.kinds)) {
      const override = (saved.kinds as Record<string, unknown>)[id];
      if (isRecord(override)) {
        const current = base.kinds[id];
        base.kinds[id] = {
          ...current,
          icon: typeof override.icon === "string" && (ALLOWED_ICONS as readonly string[]).includes(override.icon)
            ? (override.icon as IconName)
            : current.icon,
          headerLabel:
            override.headerLabel === null || typeof override.headerLabel === "string"
              ? (override.headerLabel as string | null)
              : current.headerLabel,
          accentColor:
            typeof override.accentColor === "string" && override.accentColor in base.palette
              ? (override.accentColor as PaletteName)
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
        };
      }
    }
  }

  if (isRecord(saved.hardFilters)) {
    const hf = saved.hardFilters as Record<string, unknown>;
    base.hardFilters = {
      dropMeta: typeof hf.dropMeta === "boolean" ? hf.dropMeta : base.hardFilters.dropMeta,
      dropTaskLifecycle:
        typeof hf.dropTaskLifecycle === "boolean" ? hf.dropTaskLifecycle : base.hardFilters.dropTaskLifecycle,
      dropEmptyUser: typeof hf.dropEmptyUser === "boolean" ? hf.dropEmptyUser : base.hardFilters.dropEmptyUser,
      dropHookLifecycle:
        typeof hf.dropHookLifecycle === "boolean" ? hf.dropHookLifecycle : base.hardFilters.dropHookLifecycle,
    };
  }

  if (isRecord(saved.typography)) {
    const t = saved.typography as Record<string, unknown>;
    base.typography = {
      header: mergeTypographyStyle(t.header, base.typography.header),
      content: mergeTypographyStyle(t.content, base.typography.content),
      icon: mergeIconStyle(t.icon, base.typography.icon),
    };
  }

  if (isRecord(saved.debug)) {
    const d = saved.debug as Record<string, unknown>;
    base.debug = {
      showCardKindLabel:
        typeof d.showCardKindLabel === "boolean"
          ? d.showCardKindLabel
          : base.debug.showCardKindLabel,
    };
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
  const raw = saved as Record<string, unknown>;

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
  const s = saved as Record<string, unknown>;
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

/**
 * Tool-input typing bridge.
 *
 * Claude Agent SDK ships per-tool input schemas via the `sdk-tools`
 * subpath export (`BashInput`, `FileReadInput`, `GrepInput`, …) but
 * does NOT model the link between a tool's `name` string and its
 * input shape. The widget switch in `StreamMessage.tsx` and the
 * permission preview in `PermissionCard.tsx` both discriminate on
 * tool name and then read fields off `content.input` (typed as
 * `unknown` upstream). This file closes the gap so each branch can
 * narrow once and read typed fields downstream.
 *
 * Single source of truth: `KNOWN_TOOL_NAMES` is a const tuple of the
 * PascalCase tool names we model. Everything else derives from it —
 * the `KnownToolName` literal-union type, the lowercased
 * `TOOLS_WITH_WIDGETS_LOWER` Set used by the tool-result suppression
 * path in `StreamMessage.tsx`, and the runtime `isKnownToolName`
 * guard. Adding a tool is a one-touch change to the tuple plus an
 * entry in `ToolInputByName` (which the compiler enforces via the
 * `<K extends KnownToolName>` constraint on `asToolInput`).
 *
 * Tools NOT shipped under `sdk-tools` as of 0.2.141 — `LS`, `TodoRead`,
 * `MultiEdit` — get local interfaces that mirror exactly what our
 * widgets read. Swap to the SDK type if a future release adds them.
 */

// Tool input shapes formerly imported from
// `@anthropic-ai/claude-agent-sdk/sdk-tools`. After the SDK was removed
// (Phase A) they live here as plain interfaces. Field sets match what
// the widgets in `StreamMessage.tsx` and `PermissionCard.tsx` read.

export interface AgentInput {
  description: string;
  prompt: string;
  subagent_type?: string;
}

export interface BashInput {
  command: string;
  description?: string;
  run_in_background?: boolean;
  timeout?: number;
}

export interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

export interface FileWriteInput {
  file_path: string;
  content: string;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  '-i'?: boolean;
  '-n'?: boolean;
  '-o'?: boolean;
  context?: number;
  head_limit?: number;
  multiline?: boolean;
}

export interface WebFetchInput {
  url: string;
  prompt: string;
}

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

/**
 * Grep's SDK shape no longer models `include` / `exclude` — those were
 * superseded upstream by `glob` / `type`. Our `GrepWidget` still
 * renders them when present, so we carry them as locally-extended
 * fields. Pre-existing condition; replacing the widget contract belongs
 * in its own task.
 */
export type GrepInputExtended = GrepInput & {
  include?: string;
  exclude?: string;
};

/** LS isn't in `sdk-tools` as of 0.2.141. Mirrors what `LSWidget` reads. */
export interface LSInput {
  path: string;
  ignore?: string[];
}

/**
 * TodoRead isn't in `sdk-tools` as of 0.2.141. The tool takes no
 * meaningful input — it reads the stored list and returns it as the
 * tool result. The empty interface below documents that contract;
 * `TodoReadWidget` extracts todos from the result, not the input.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TodoReadInput {}

/** MultiEdit isn't shipped as a distinct schema (only `FileEditInput` is single-edit). */
export interface MultiEditInput {
  file_path: string;
  edits: { old_string: string; new_string: string; replace_all?: boolean }[];
}

/**
 * Single source of truth for the PascalCase tool names we model.
 * `KnownToolName` and `TOOLS_WITH_WIDGETS_LOWER` are derived from this
 * tuple; the `ToolInputByName` interface keys must match (enforced at
 * compile time by the `<K extends KnownToolName>` constraint on
 * `asToolInput` indexing into `ToolInputByName[K]`).
 */
export const KNOWN_TOOL_NAMES = [
  'Bash',
  'Edit',
  'MultiEdit',
  'Read',
  'Write',
  'Glob',
  'Grep',
  'TodoRead',
  'LS',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
] as const;

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

/**
 * Lowercased mirror of `KNOWN_TOOL_NAMES` for the tool-result
 * suppression path in `StreamMessage.tsx`. Derived — never
 * hand-maintained — so adding a tool can never desync the two layers.
 */
export const TOOLS_WITH_WIDGETS_LOWER: ReadonlySet<string> = new Set(
  KNOWN_TOOL_NAMES.map((n) => n.toLowerCase()),
);

/**
 * The canonical map of tool-name → typed input. Add an entry here
 * when a new branch in the widget switch needs typed access. The
 * `<K extends KnownToolName>` constraint on `asToolInput` means
 * every key in `KNOWN_TOOL_NAMES` must appear here, or its branches
 * fail to compile.
 */
export interface ToolInputByName {
  Bash: BashInput;
  Edit: FileEditInput;
  MultiEdit: MultiEditInput;
  Read: FileReadInput;
  Write: FileWriteInput;
  Glob: GlobInput;
  Grep: GrepInputExtended;
  TodoRead: TodoReadInput;
  LS: LSInput;
  WebFetch: WebFetchInput;
  WebSearch: WebSearchInput;
  Task: AgentInput;
  Agent: AgentInput;
}

/**
 * Runtime guard for "this string is one of the PascalCase tool names
 * we model." Powers the dev-mode warning below and any caller that
 * needs a fast type-narrowed check without going through the typed
 * map.
 */
export function isKnownToolName(name: unknown): name is KnownToolName {
  if (typeof name !== 'string') return false;
  return (KNOWN_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Narrow `input` from `unknown` to the typed payload when `name`
 * matches `expected`. Returns `null` on mismatch so the caller can
 * fall through to the next branch with a simple `if (!x) {}` chain.
 *
 * The SDK ships compile-time types but no runtime guarantee — Claude
 * can emit malformed input and MCP servers return whatever — so the
 * shape is asserted, not validated field-by-field. Each widget still
 * reads with optional access so a missing field renders gracefully.
 */
export function asToolInput<K extends KnownToolName>(
  name: string | undefined,
  expected: K,
  input: unknown,
): ToolInputByName[K] | null {
  if (name !== expected) return null;
  if (input == null || typeof input !== 'object') return null;
  return input as ToolInputByName[K];
}

/**
 * Variant for branches that fold multiple tool names onto one widget
 * (e.g. Task / Agent both dispatch a subagent). Returns the matched
 * name alongside the narrowed input so the caller can still branch
 * on which one fired if needed. Case-sensitive against the SDK's
 * PascalCase contract — see `isSubagentDispatch` for the matching
 * tightening.
 */
export function asToolInputOneOf<K extends KnownToolName>(
  name: string | undefined,
  expected: readonly K[],
  input: unknown,
): { name: K; input: ToolInputByName[K] } | null {
  if (!name) return null;
  if (!(expected as readonly string[]).includes(name)) return null;
  if (input == null || typeof input !== 'object') return null;
  return { name: name as K, input: input as ToolInputByName[K] };
}

/**
 * Dev-mode diagnostic: fires when a tool_use block arrives carrying a
 * known PascalCase tool name (i.e. one we have a widget branch for)
 * but `renderToolWidget` reached the end without matching any branch.
 * That's the exact failure mode the SDK type adoption was meant to
 * surface — a known name with malformed / unexpected input falls
 * through to the generic JSON display silently.
 *
 * Production-no-op (gated on `import.meta.env.DEV`). Fires at most
 * once per tool_use that hits the bottom of the switch; not throttled
 * across multiple instances.
 */
export function warnUnhandledKnownTool(
  toolName: string | undefined,
  rawInput: unknown,
): void {
  if (!import.meta.env.DEV) return;
  if (!toolName || !(KNOWN_TOOL_NAMES as readonly string[]).includes(toolName)) return;
  const keys =
    rawInput && typeof rawInput === 'object'
      ? Object.keys(rawInput).join(', ') || 'none'
      : 'none';
  console.warn(
    `[StreamMessage] tool_use "${toolName}" matched a known tool name but no widget branch matched. Input keys: ${keys}`,
  );
}

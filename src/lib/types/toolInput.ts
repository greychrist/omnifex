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
 * Keys are PascalCase tool names as Claude emits them on the wire —
 * matching the SDK's convention. The renderer historically lowercased
 * `content.name` before comparing; we drop that here in favor of
 * exact-match against the canonical SDK form. If a non-canonical name
 * ever appears, the branch falls through to the generic display
 * (which is what `.toLowerCase()` was guarding against, defensively,
 * for tools that never actually existed under a different case).
 *
 * Tools NOT shipped under `sdk-tools` as of 0.2.141 — `LS`, `TodoRead`,
 * `MultiEdit` — get local interfaces that mirror exactly what our
 * widgets read. Swap to the SDK type if a future release adds them.
 */

import type {
  AgentInput,
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

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
 * The canonical map of tool-name → typed input. Add an entry here
 * when a new branch in the widget switch needs typed access.
 */
export interface ToolInputByName {
  Bash: BashInput;
  Edit: FileEditInput;
  MultiEdit: MultiEditInput;
  Read: FileReadInput;
  Write: FileWriteInput;
  Glob: GlobInput;
  Grep: GrepInputExtended;
  TodoWrite: TodoWriteInput;
  TodoRead: TodoReadInput;
  LS: LSInput;
  WebFetch: WebFetchInput;
  WebSearch: WebSearchInput;
  Task: AgentInput;
  Agent: AgentInput;
}

export type KnownToolName = keyof ToolInputByName;

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
 * on which one fired if needed.
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

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

export type GrepInputExtended = GrepInput & {
  include?: string;
  exclude?: string;
};

export interface LSInput {
  path: string;
  ignore?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TodoReadInput {}

export interface MultiEditInput {
  file_path: string;
  edits: { old_string: string; new_string: string; replace_all?: boolean }[];
}

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

export const TOOLS_WITH_WIDGETS_LOWER: ReadonlySet<string> = new Set(
  KNOWN_TOOL_NAMES.map((n) => n.toLowerCase()),
);

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

export function isKnownToolName(name: unknown): name is KnownToolName {
  if (typeof name !== 'string') return false;
  return (KNOWN_TOOL_NAMES as readonly string[]).includes(name);
}

/** The CLI's schemas are compile-time only: the shape is asserted, not validated. */
export function asToolInput<K extends KnownToolName>(
  name: string | undefined,
  expected: K,
  input: unknown,
): ToolInputByName[K] | null {
  if (name !== expected) return null;
  if (input == null || typeof input !== 'object') return null;
  return input as ToolInputByName[K];
}

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

/** Claude can emit a non-string `file_path`/`command`/`glob`; check before string work. Empty strings fail too. */
export function toolInputString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

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

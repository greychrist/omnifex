import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 1;

/** app_settings key under which the user-editable prompt template lives. */
export const PROMPT_TEMPLATE_SETTING_KEY = 'sessionsSummary.promptTemplate';

/**
 * FNV-1a hash of a string. 32-bit, returned as 8-char hex. Used to tag
 * sidecars with the prompt template they were produced under so the
 * size-change gate auto-invalidates whenever the user edits the prompt.
 *
 * Cheap (no crypto), stable across restarts, collision-rate fine for
 * cache invalidation.
 */
export function promptHash(template: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < template.length; i++) {
    hash ^= template.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface SessionSummary {
  version: number;
  headline: string;
  paragraph: string;
  messageCount: number;
  jsonlSize: number;
  generatedAt: string;
  model: string;
  accountName: string;
  truncated?: boolean;
  /** FNV-1a hash of the prompt template this summary was produced under.
   *  A mismatch with the current template hash invalidates the size-gate
   *  cache so a refresh click regenerates with the new prompt. */
  promptHash?: string;
  /** @deprecated Replaced by `promptHash`. Kept readable for older sidecars. */
  promptVersion?: number;
}

// ---------------------------------------------------------------------------
// Sidecar I/O
// ---------------------------------------------------------------------------

/** Path of the sidecar that lives next to a session JSONL. */
export function sidecarPathFor(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.summary.json');
}

/**
 * Read a sidecar from disk. Returns null on any failure (missing file,
 * unreadable, corrupt JSON, schema version mismatch). The renderer treats
 * null as "no summary yet" and falls through to the first-message preview.
 */
export function readSidecar(sidecarPath: string): SessionSummary | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== CURRENT_SCHEMA_VERSION
  ) {
    return null;
  }
  return parsed as SessionSummary;
}

/**
 * Write a sidecar atomically: write to <path>.tmp, then rename. A crash
 * mid-write can never leave a partially-written sidecar.
 */
export function writeSidecar(sidecarPath: string, summary: SessionSummary): void {
  const tmpPath = sidecarPath + '.tmp';
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2), 'utf-8');
  fs.renameSync(tmpPath, sidecarPath);
}

// ---------------------------------------------------------------------------
// Transcript extraction
// ---------------------------------------------------------------------------

export interface ExtractedTranscript {
  transcript: string;
  messageCount: number;
}

/**
 * Walk a JSONL string and return a flat USER/ASSISTANT transcript.
 *
 * Keep:
 *   - type === 'user' with text content (drop isMeta, drop <command-name>
 *     and <command-stdout> wrappers; matches the filter in
 *     extractSessionMetadata in claude.ts).
 *   - type === 'assistant' — only the `text` blocks. Drop tool_use blocks.
 *
 * Drop entirely:
 *   - tool_result entries (they ride on user-type rows; the user-row text
 *     check below skips them since their content is structured tool
 *     output, not a string).
 *   - type === 'summary' (SDK auto-compaction summary entries).
 *   - any line that fails to parse as JSON.
 */
export function extractTranscript(jsonlContent: string): ExtractedTranscript {
  const lines: string[] = [];
  let messageCount = 0;

  for (const rawLine of jsonlContent.split('\n')) {
    if (!rawLine.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.isMeta) continue;

    if (entry.type === 'user') {
      const content = entry.message?.content;
      let text: string | null = null;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        // tool_result rows have content as an array of objects; only treat
        // it as user text if there's a plain text element.
        const textPart = content.find(
          (c: any) => c?.type === 'text' && typeof c.text === 'string',
        );
        if (textPart) text = textPart.text;
      }
      if (!text) continue;
      // Skip the command-tag wrappers that <command-name>foo</command-name>
      // injects from slash command preludes.
      if (/^<command-(name|stdout|args|message)>/.test(text)) continue;
      lines.push(`USER: ${text}`);
      messageCount += 1;
      continue;
    }

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      const textParts = content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n');
      if (!textParts) continue;
      lines.push(`ASSISTANT: ${textParts}`);
      messageCount += 1;
      continue;
    }

    // Ignore everything else (summary, system, etc.).
  }

  return { transcript: lines.join('\n'), messageCount };
}

// ---------------------------------------------------------------------------
// Truncation safety net
// ---------------------------------------------------------------------------

const MAX_TRANSCRIPT_CHARS = 720_000; // ~180K tokens at 4 chars/token
const KEEP_HEAD_CHARS = 240_000;
const KEEP_TAIL_CHARS = 240_000;

export interface TruncationResult {
  transcript: string;
  truncated: boolean;
}

/**
 * Cap the transcript at ~180K tokens so it fits comfortably under any
 * mainline Claude model's 200K context with room for prompt + output.
 * When over the cap, keep the first 240K and last 240K characters with
 * an elision marker between them. Char-based heuristic is intentional —
 * precise tokenization is overkill for a safety net that fires on <1%
 * of sessions.
 */
export function truncateForModel(transcript: string): TruncationResult {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return { transcript, truncated: false };
  }
  const head = transcript.slice(0, KEEP_HEAD_CHARS);
  const tail = transcript.slice(transcript.length - KEEP_TAIL_CHARS);
  const elidedChars = transcript.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS;
  const elidedTokens = Math.round(elidedChars / 4);
  const marker = `\n\n[… ~${elidedTokens.toLocaleString()} tokens elided …]\n\n`;
  return { transcript: head + marker + tail, truncated: true };
}

// ---------------------------------------------------------------------------
// XML response parsing
// ---------------------------------------------------------------------------

export interface ParsedSummary {
  headline: string;
  paragraph: string;
}

/**
 * Extract <headline> and <paragraph> from the model's response. Tolerates
 * prose around the tags. Returns null when either tag is missing — the
 * caller should treat that as a recoverable failure (don't overwrite an
 * existing sidecar).
 */
export function parseSummaryXML(response: string): ParsedSummary | null {
  const headlineMatch = response.match(/<headline>([\s\S]*?)<\/headline>/);
  const paragraphMatch = response.match(/<paragraph>([\s\S]*?)<\/paragraph>/);
  if (!headlineMatch || !paragraphMatch) return null;
  const headline = headlineMatch[1].trim();
  const paragraph = paragraphMatch[1].trim();
  if (!headline || !paragraph) return null;
  return { headline, paragraph };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Default prompt template used when the user hasn't customized one.
 * Loaded as the initial value into the app_settings table on first
 * launch (see `ensureDefaultSettings` in main.ts) and exposed via the
 * settings UI. Editing the template in the UI rewrites the
 * app_settings row; the in-memory `runQuery` callback always reads the
 * latest value at call time.
 */
export const DEFAULT_SUMMARY_PROMPT = `You are summarizing a coding-assistant session for a developer's records.
Produce a one-line headline (8–14 words) and a 2–3 sentence paragraph (~50 words) that capture the THEMES of the session — what general area or capability was worked on, what the broader goals were, what kind of problem the user was trying to solve.

Stay at a higher level of abstraction. Do NOT list specific file names, function names, library names, line numbers, or step-by-step changes. Generalize:
- "Iterating on the session list UI" — not "edited SessionList.tsx to add pagination."
- "Improving the authentication flow" — not "added refresh-token logic to auth.ts:42."
- "Debugging a multi-account routing edge case" — not "fixed the path-rule resolver in accounts.ts."

The headline answers: "what kind of work was this?"
The paragraph answers: "what was the user generally trying to accomplish, and where did it land?"

No filler. No hedging. No code snippets.

Format your response EXACTLY:
<headline>...</headline>
<paragraph>...</paragraph>

`;

function buildSummaryPrompt(transcript: string, preamble: string): string {
  return `${preamble}<transcript>\n${transcript}\n</transcript>`;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export interface ResolvedAccount {
  /** User-defined account label, stored in the sidecar's `accountName`. */
  name: string;
  /** Path passed as CLAUDE_CONFIG_DIR when calling the SDK. */
  configDir: string;
  /** Whether auto-on-close + manual button are enabled for this account. */
  summarizeOnClose: boolean;
  /** SDK model id, e.g. 'claude-haiku-4-5'. Null when toggle is off / unset. */
  summaryModel: string | null;
}

export interface SessionsSummaryDeps {
  /**
   * Resolve a JSONL path from a session uuid + project path + the
   * resolved account's configDir. The configDir is the root we anchor
   * paths to — the caller (renderer or lifecycle close hook) holds it
   * at tab level. Pass `null` when it isn't known and the implementation
   * should search all known accounts as a last-resort.
   */
  jsonlPathFor(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): string;
  /** Resolve the account responsible for this project, or null. */
  resolveAccount(projectPath: string): ResolvedAccount | null;
  /** Send a single user prompt to the SDK and return the assistant text. */
  runQuery(opts: {
    prompt: string;
    model: string;
    cwd: string;
    configDir: string;
  }): Promise<string>;
  /**
   * Called after a successful sidecar write so the renderer can refresh
   * the matching row. Not called when generateSummary returns null
   * (skipped, gated, malformed XML, etc.).
   */
  onSummaryUpdated?: (sessionUuid: string) => void;
  /**
   * Read the current prompt template (user-edited or default). Resolved
   * fresh on every call so prompt edits land without restart and the
   * sidecar's `promptHash` reflects what was actually sent to the model.
   */
  getPromptTemplate(): string;
}

/**
 * Discriminated result of `generateSummary`. Returning a tagged object lets
 * the renderer tell "skipped because toggle off" apart from "succeeded with
 * no change" — both of those used to collapse to `null`, which made the
 * manual refresh button feel broken when the account was unconfigured.
 *
 * Hard errors (auth, network) still throw out of `generateSummary` so they
 * surface as toasts rather than as result codes.
 */
export type SummaryGenerateResult =
  | { status: 'generated'; summary: SessionSummary }
  | { status: 'unchanged'; summary: SessionSummary }
  | {
      status: 'skipped';
      reason: 'no-account' | 'toggle-off' | 'no-model' | 'empty-session' | 'jsonl-missing' | 'jsonl-unreadable';
    }
  | { status: 'malformed-response' };

export interface SessionsSummaryService {
  /**
   * Read the cached sidecar for a session. `configDir` is the resolved
   * account's config_dir as held at the tab level (renderer) or session
   * level (lifecycle hook). Pass `null` when the caller doesn't have it
   * and the service should search all accounts.
   */
  getSummary(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): SessionSummary | null;
  generateSummary(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): Promise<SummaryGenerateResult>;
}

export function createSessionsSummaryService(
  deps: SessionsSummaryDeps,
): SessionsSummaryService {
  // Per-session in-flight map for dedup. Keyed by `${projectPath}::${uuid}`.
  const inFlight = new Map<string, Promise<SummaryGenerateResult>>();

  function getSummary(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): SessionSummary | null {
    const jsonlPath = deps.jsonlPathFor(sessionUuid, projectPath, configDir);
    return readSidecar(sidecarPathFor(jsonlPath));
  }

  async function generateSummaryInner(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): Promise<SummaryGenerateResult> {
    const account = deps.resolveAccount(projectPath);
    if (!account) {
      console.warn(
        `[sessions-summary] No account resolved for ${projectPath}; skipping.`,
      );
      return { status: 'skipped', reason: 'no-account' };
    }
    if (!account.summarizeOnClose) {
      return { status: 'skipped', reason: 'toggle-off' };
    }
    if (!account.summaryModel) {
      return { status: 'skipped', reason: 'no-model' };
    }

    const jsonlPath = deps.jsonlPathFor(sessionUuid, projectPath, configDir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      console.warn(`[sessions-summary] JSONL missing: ${jsonlPath}; skipping.`);
      return { status: 'skipped', reason: 'jsonl-missing' };
    }
    const jsonlSize = stat.size;

    // Size-change gate: skip when the JSONL hasn't grown since the last
    // successful summary AND the cached sidecar's promptHash matches the
    // hash of the prompt template we're about to use. A hash mismatch
    // invalidates the cache so prompt edits in the UI land on the next
    // refresh click without any manual cache-busting.
    const sidecarPath = sidecarPathFor(jsonlPath);
    const cached = readSidecar(sidecarPath);
    const promptTemplate = deps.getPromptTemplate();
    const currentPromptHash = promptHash(promptTemplate);
    if (
      cached &&
      cached.jsonlSize === jsonlSize &&
      cached.promptHash === currentPromptHash
    ) {
      return { status: 'unchanged', summary: cached };
    }

    let jsonlContent: string;
    try {
      jsonlContent = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      console.warn(`[sessions-summary] JSONL unreadable: ${jsonlPath}; skipping.`);
      return { status: 'skipped', reason: 'jsonl-unreadable' };
    }
    const { transcript, messageCount } = extractTranscript(jsonlContent);
    if (!transcript || messageCount === 0) {
      return { status: 'skipped', reason: 'empty-session' };
    }
    const { transcript: capped, truncated } = truncateForModel(transcript);

    console.log(
      `[sessions-summary] Calling ${account.summaryModel} via ${account.configDir} for ${sessionUuid} (${messageCount} msgs, ${jsonlSize} bytes${truncated ? ', truncated' : ''})`,
    );

    const prompt = buildSummaryPrompt(capped, promptTemplate);
    const response = await deps.runQuery({
      prompt,
      model: account.summaryModel,
      cwd: projectPath,
      configDir: account.configDir,
    });

    const parsed = parseSummaryXML(response);
    if (!parsed) {
      console.warn(
        `[sessions-summary] Model returned malformed XML; sidecar untouched. Raw response: ${response.slice(0, 200)}`,
      );
      return { status: 'malformed-response' };
    }

    const summary: SessionSummary = {
      version: CURRENT_SCHEMA_VERSION,
      headline: parsed.headline,
      paragraph: parsed.paragraph,
      messageCount,
      jsonlSize,
      generatedAt: new Date().toISOString(),
      model: account.summaryModel,
      accountName: account.name,
      promptHash: currentPromptHash,
      ...(truncated ? { truncated: true } : {}),
    };
    writeSidecar(sidecarPath, summary);
    deps.onSummaryUpdated?.(sessionUuid);
    return { status: 'generated', summary };
  }

  async function generateSummary(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): Promise<SummaryGenerateResult> {
    const key = `${projectPath}::${sessionUuid}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = generateSummaryInner(sessionUuid, projectPath, configDir).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return { getSummary, generateSummary };
}

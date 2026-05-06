import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 1;

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
  /** Resolve a JSONL path from a session uuid + project path. */
  jsonlPathFor(sessionUuid: string, projectPath: string): string;
  /** Resolve the account responsible for this project, or null. */
  resolveAccount(projectPath: string): ResolvedAccount | null;
  /** Send a single user prompt to the SDK and return the assistant text. */
  runQuery(opts: {
    prompt: string;
    model: string;
    cwd: string;
    configDir: string;
  }): Promise<string>;
}

export interface SessionsSummaryService {
  getSummary(sessionUuid: string, projectPath: string): SessionSummary | null;
  generateSummary(
    sessionUuid: string,
    projectPath: string,
  ): Promise<SessionSummary | null>;
}

export function createSessionsSummaryService(
  deps: SessionsSummaryDeps,
): SessionsSummaryService {
  function getSummary(
    sessionUuid: string,
    projectPath: string,
  ): SessionSummary | null {
    const jsonlPath = deps.jsonlPathFor(sessionUuid, projectPath);
    return readSidecar(sidecarPathFor(jsonlPath));
  }

  async function generateSummary(
    _sessionUuid: string,
    _projectPath: string,
  ): Promise<SessionSummary | null> {
    // Real implementation lands in Task 7.
    return null;
  }

  return { getSummary, generateSummary };
}

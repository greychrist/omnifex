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

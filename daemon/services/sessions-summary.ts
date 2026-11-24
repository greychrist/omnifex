import fs from 'node:fs';
import path from 'node:path';
import { isRequestReplayLine } from './util/request-replay';

export const CURRENT_SCHEMA_VERSION = 1;

export const PROMPT_TEMPLATE_SETTING_KEY = 'sessionsSummary.promptTemplate';

// Gating is the caller's job: generateSummary checks neither flag.
export const ENABLED_SETTING_KEY = 'sessionsSummary.enabled';
export const AUTO_ON_CLOSE_SETTING_KEY = 'sessionsSummary.autoOnClose';

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
  promptHash?: string;
  /** @deprecated Replaced by `promptHash`. Kept readable for older sidecars. */
  promptVersion?: number;
}

export function sidecarPathFor(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.summary.json');
}

export function readSidecar(sidecarPath: string): SessionSummary | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf-8');
  } catch {
    return null;
  }
  return parseSidecar(raw);
}

export async function readSidecarAsync(sidecarPath: string): Promise<SessionSummary | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(sidecarPath, 'utf-8');
  } catch {
    return null;
  }
  return parseSidecar(raw);
}

function parseSidecar(raw: string): SessionSummary | null {
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

export function writeSidecar(sidecarPath: string, summary: SessionSummary): void {
  const tmpPath = sidecarPath + '.tmp';
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2), 'utf-8');
  fs.renameSync(tmpPath, sidecarPath);
}

export interface ExtractedTranscript {
  transcript: string;
  messageCount: number;
}

interface TranscriptEntry {
  isMeta?: boolean;
  type?: string;
  message?: { content?: unknown };
}

function isTextPart(c: unknown): c is { type: 'text'; text: string } {
  const part = c as { type?: unknown; text?: unknown } | null | undefined;
  return part?.type === 'text' && typeof part.text === 'string';
}

export function extractTranscript(jsonlContent: string): ExtractedTranscript {
  const lines: string[] = [];
  let messageCount = 0;

  for (const rawLine of jsonlContent.split('\n')) {
    if (!rawLine.trim() || isRequestReplayLine(rawLine)) continue;
    let entry: TranscriptEntry | null;
    try {
      entry = JSON.parse(rawLine) as TranscriptEntry | null;
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
        const textPart = (content as unknown[]).find(isTextPart);
        if (textPart) text = textPart.text;
      }
      if (!text) continue;
      if (/^<command-(name|stdout|args|message)>/.test(text)) continue;
      lines.push(`USER: ${text}`);
      messageCount += 1;
      continue;
    }

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      const textParts = (content as unknown[])
        .filter(isTextPart)
        .map((c) => c.text)
        .join('\n');
      if (!textParts) continue;
      lines.push(`ASSISTANT: ${textParts}`);
      messageCount += 1;
      continue;
    }
  }

  return { transcript: lines.join('\n'), messageCount };
}

const MAX_TRANSCRIPT_CHARS = 720_000;
const KEEP_HEAD_CHARS = 240_000;
const KEEP_TAIL_CHARS = 240_000;

export interface TruncationResult {
  transcript: string;
  truncated: boolean;
}

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

export interface ParsedSummary {
  headline: string;
  paragraph: string;
}

/** Null when a tag is missing: a recoverable failure that must not overwrite an existing sidecar. */
export function parseSummaryXML(response: string): ParsedSummary | null {
  const headlineMatch = /<headline>([\s\S]*?)<\/headline>/.exec(response);
  const paragraphMatch = /<paragraph>([\s\S]*?)<\/paragraph>/.exec(response);
  if (!headlineMatch || !paragraphMatch) return null;
  const headline = headlineMatch[1].trim();
  const paragraph = paragraphMatch[1].trim();
  if (!headline || !paragraph) return null;
  return { headline, paragraph };
}

export const DEFAULT_SUMMARY_PROMPT = `You are summarizing a coding-assistant session for a developer's records.
Produce a one-line headline (8–14 words) and a 2–3 bullet points (< 50 words) that capture the THEMES of the session — what general area or capability was worked on, what the broader goals were, what kind of problem the user was trying to solve.

If nothing of note was done, just say so.  Nothing of note. or Testing functionality.

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

export interface ResolvedAccount {
  name: string;
  configDir: string;
  summaryModel: string | null;
}

export interface SessionsSummaryDeps {
  /** No synthetic `~/.claude` fallback: null means skip. */
  jsonlPathFor(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): string | null;
  resolveAccount(projectPath: string): ResolvedAccount | null;
  /** No `cwd`: the runner picks a scratch dir so the CLI's transcript never lands in the user's project. */
  runQuery(opts: {
    prompt: string;
    model: string;
    configDir: string;
  }): Promise<string>;
  onSummaryUpdated?: (sessionUuid: string) => void;
  /** Read fresh per call so the sidecar's `promptHash` matches what was sent. */
  getPromptTemplate(): string;
  onGenerationStateChanged?: (sessionUuid: string, generating: boolean) => void;
}

export type SummaryGenerateResult =
  | { status: 'generated'; summary: SessionSummary }
  | { status: 'unchanged'; summary: SessionSummary }
  | {
      status: 'skipped';
      reason: 'no-account' | 'toggle-off' | 'no-model' | 'empty-session' | 'jsonl-missing' | 'jsonl-unreadable';
    }
  | { status: 'malformed-response' };

export interface SessionsSummaryService {
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
  /** Seeds the renderer's spinner: a `generating: true` event can fire before the SessionList subscribes. */
  getGeneratingSessionUuids(): string[];
}

export function createSessionsSummaryService(
  deps: SessionsSummaryDeps,
): SessionsSummaryService {
  const inFlight = new Map<string, Promise<SummaryGenerateResult>>();
  const generatingNow = new Set<string>();

  function getSummary(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): SessionSummary | null {
    const jsonlPath = deps.jsonlPathFor(sessionUuid, projectPath, configDir);
    if (!jsonlPath) return null;
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
    if (!account.summaryModel) {
      return { status: 'skipped', reason: 'no-model' };
    }

    const jsonlPath = deps.jsonlPathFor(sessionUuid, projectPath, configDir);
    if (!jsonlPath) {
      return { status: 'skipped', reason: 'no-account' };
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(jsonlPath);
    } catch {
      console.warn(`[sessions-summary] JSONL missing: ${jsonlPath}; skipping.`);
      return { status: 'skipped', reason: 'jsonl-missing' };
    }
    const jsonlSize = stat.size;

    const sidecarPath = sidecarPathFor(jsonlPath);
    const cached = await readSidecarAsync(sidecarPath);
    const promptTemplate = deps.getPromptTemplate();
    const currentPromptHash = promptHash(promptTemplate);
    if (
      cached?.jsonlSize === jsonlSize &&
      cached.promptHash === currentPromptHash
    ) {
      return { status: 'unchanged', summary: cached };
    }

    // Async: transcripts reach tens of MB, on the daemon's one event loop.
    let jsonlContent: string;
    try {
      jsonlContent = await fs.promises.readFile(jsonlPath, 'utf-8');
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
    generatingNow.add(sessionUuid);
    deps.onGenerationStateChanged?.(sessionUuid, true);
    let response: string;
    try {
      response = await deps.runQuery({
        prompt,
        model: account.summaryModel,
        configDir: account.configDir,
      });
    } finally {
      generatingNow.delete(sessionUuid);
      deps.onGenerationStateChanged?.(sessionUuid, false);
    }

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

  return {
    getSummary,
    generateSummary,
    getGeneratingSessionUuids: () => Array.from(generatingNow),
  };
}

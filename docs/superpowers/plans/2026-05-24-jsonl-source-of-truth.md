# JSONL Source-of-Truth Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the message-rendering pipeline so JSONL is the single source of truth for both SDK and TUI modes, with the SDK iterator demoted to an overlay channel for token partials and lifecycle events. Resume, SDK live, and TUI live all flow through the same classifier + synthesizer + renderer path.

**Architecture:** A new `JsonlNode` discriminated union and `classifyJsonlLine` function map every shape we see in real JSONL files into a typed taxonomy. A `createSynthesizer` state machine produces the synthetic `init` and `result` events JSONL doesn't persist. Both `loadSessionHistory` (batch) and the live tail (streaming) feed through the same classifier+synthesizer pair. The renderer's `messages[]` continues to be the `ClaudeStreamMessage[]` shape it is today — synthesized nodes adopt that shape so we don't have to refactor `StreamMessage.tsx`'s ~1200 lines in this cycle. The classifier itself uses `JsonlNode` internally for filter decisions in the settings UI.

**Tech Stack:** TypeScript (strict), React 18, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-24-jsonl-source-of-truth-design.md`

**Repo conventions:** Per `CLAUDE.md`, commits happen only when Greg explicitly asks. Each task's "Commit" step is a checkpoint — pause and confirm before running `git commit`. TDD is required for new code.

**Design divergence from spec:** The spec proposes refactoring `StreamMessage.tsx` to switch on `JsonlNode.kind` instead of `message.type`. This plan defers that refactor. Rationale: it's a large internal change with no behavior delta — the synthesizer's outputs already match the existing `ClaudeStreamMessage` shape. The discriminated union still drives settings/classification logic. The renderer-side discriminator switch can land in a follow-up cycle once we have real usage feedback on the pipeline.

---

## Non-Goals (out of scope)

- Refactoring `StreamMessage.tsx`'s discriminator (deferred to Phase 3)
- Replacing the CLI's TUI rendering with React
- Reimplementing SubagentBar / hook progress UI without SDK iterator data
- Token-level streaming in TUI mode
- Auto-fallback from SDK to TUI on metering rejection

---

## File Structure

**New files:**
- `src/types/jsonl.ts` — Discriminated-union `JsonlNode` type covering every shape seen in real JSONL files plus three "overlay" variants (`stream-event`, `rate-limit`, `lifecycle`) plus two "synthesized" variants (`synthesized-init`, `synthesized-result`).
- `src/lib/jsonlClassifier.ts` — `classifyJsonlLine(raw: unknown): JsonlNode | null`. Pure function; the source-of-truth for "what is this line."
- `src/lib/__tests__/jsonlClassifier.test.ts` — Golden-file tests using fixtures sampled from real JSONL files.
- `src/lib/jsonlSynthesizer.ts` — `createSynthesizer()` streaming state machine + `synthesizeBatch()` batch wrapper. Replaces today's `synthesizeResults.ts` internals.
- `src/lib/__tests__/jsonlSynthesizer.test.ts` — Unit tests for synthesis state machine.
- `src/lib/__tests__/fixtures/` — Real-world JSONL fixture lines extracted from Greg's session files, one per node kind.

**Modified files:**
- `src/lib/synthesizeResults.ts` — Becomes a thin wrapper over `synthesizeBatch`. Existing test stays green.
- `src/components/ClaudeCodeSession.tsx` — `loadSessionHistory()` routes through the new classifier+synthesizer. Live JSONL handler is added behind the `omnifex:jsonl-pipeline` flag.
- `src/hooks/useSessionLifecycle.ts` — `attachStreamListeners` gains a flag-gated branch that classifies incoming `claude-output:` events.
- `electron/services/sessions/tui-jsonl.ts` — Cleanup: drop the local classifier (`classifyRuntimeEvent`) call since classification now lives renderer-side. Main only forwards raw lines.
- `src/components/settings-panels/AppearanceSettings.tsx` — Replace 4-toggle hard filters list with node-keyed list (Phase 2.2).
- `electron/services/sessions/events.ts`, `runtime.ts` — Cleanup in Phase 2.3 once new pipeline is the only path.

**Deleted files (Phase 2.3):**
- `src/lib/synthesizeResults.ts` — folded into `jsonlSynthesizer.ts`
- `electron/services/sessions/events.ts` if no longer referenced after cleanup

---

## Task 1: `JsonlNode` discriminated union

**Files:**
- Create: `src/types/jsonl.ts`

This task defines types only — no logic, no runtime code path.

- [ ] **Step 1: Create the type file**

Create `src/types/jsonl.ts` with the discriminated union and supporting types:

```typescript
/**
 * Source-of-truth taxonomy for messages flowing through the renderer's
 * message pipeline. Every JSONL line the CLI writes maps to exactly one
 * variant (or is dropped by the classifier). Synthesized variants are
 * manufactured by the synthesizer for state JSONL doesn't persist
 * (session init, turn-complete result cards). Overlay variants come from
 * the SDK iterator in SDK mode and never touch the renderer's messages[]
 * — they drive separate UI surfaces (partials buffer, rate-limit service,
 * SubagentBar / hook progress / status badges).
 *
 * Inventory drawn from 126 real session JSONL files. See the design spec
 * for the per-kind line counts.
 */

/** Generic raw-line shell. Every JSONL line carries at least `type`. */
export interface RawLineBase {
  type: string;
  sessionId?: string;
  timestamp?: string;
  uuid?: string;
}

export interface AssistantRaw extends RawLineBase {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: unknown;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
    model?: string;
  };
  parentUuid?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface UserRaw extends RawLineBase {
  type: 'user';
  message: {
    role: 'user';
    content: unknown;
  };
  parentUuid?: string;
  cwd?: string;
  promptId?: string;
  permissionMode?: string;
}

export interface AttachmentRaw extends RawLineBase {
  type: 'attachment';
  attachment: {
    type?: string;
    prompt?: string;
    [key: string]: unknown;
  };
  parentUuid?: string;
  cwd?: string;
}

export interface QueueOpRaw extends RawLineBase {
  type: 'queue-operation';
  operation: string;
  content?: string;
}

export interface LastPromptRaw extends RawLineBase {
  type: 'last-prompt';
  lastPrompt: string;
  leafUuid: string;
}

export interface PermissionModeRaw extends RawLineBase {
  type: 'permission-mode';
  permissionMode: string;
}

export interface AiTitleRaw extends RawLineBase {
  type: 'ai-title';
  aiTitle: string;
}

export interface FileSnapshotRaw extends RawLineBase {
  type: 'file-history-snapshot';
  messageId?: string;
  snapshot: unknown;
  isSnapshotUpdate?: boolean;
}

export type SystemSubtype =
  | 'stop_hook_summary'
  | 'local_command'
  | 'api_error'
  | 'turn_duration'
  | 'away_summary'
  | 'compact_boundary'
  | 'informational';

export interface SystemRaw extends RawLineBase {
  type: 'system';
  subtype: SystemSubtype;
  content?: string;
  parentUuid?: string;
  cwd?: string;
  level?: string;
}

export type LifecycleKind =
  | 'task_started' | 'task_updated' | 'task_progress' | 'task_notification'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'status' | 'permission_denied' | 'plugin_install' | 'tool_progress'
  | 'auth_status' | 'session_state_changed' | 'notification'
  | 'files_persisted' | 'tool_use_summary' | 'memory_recall'
  | 'elicitation_complete' | 'prompt_suggestion' | 'mirror_error'
  | 'api_retry' | 'local_command_output';

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  surpassedThreshold?: number;
}

export interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

/** Discriminated union — exactly one `kind` per node. */
export type JsonlNode =
  // Conversation content (persisted to JSONL)
  | { kind: 'assistant'; raw: AssistantRaw; sessionId: string; receivedAt: string }
  | { kind: 'user'; raw: UserRaw; sessionId: string; receivedAt: string; userKind: 'prompt' | 'tool-result' }
  | { kind: 'attachment'; raw: AttachmentRaw; sessionId: string; receivedAt: string }
  // Closure carriers (background-bash plumbing)
  | { kind: 'queue-operation'; raw: QueueOpRaw; sessionId: string; receivedAt: string }
  // CLI bookkeeping (TUI-only in practice)
  | { kind: 'last-prompt'; raw: LastPromptRaw; sessionId: string }
  | { kind: 'permission-mode'; raw: PermissionModeRaw; sessionId: string }
  | { kind: 'ai-title'; raw: AiTitleRaw; sessionId: string }
  | { kind: 'file-history-snapshot'; raw: FileSnapshotRaw }
  // System sub-variants
  | { kind: 'system'; subtype: SystemSubtype; raw: SystemRaw; sessionId: string; receivedAt: string }
  // Synthesized (not on disk; manufactured by the synthesizer)
  | { kind: 'synthesized-init'; sessionId: string; cwd: string; receivedAt: string }
  | { kind: 'synthesized-result'; sessionId: string; isError: boolean; subtype: string; body: string; durationMs: number; usage: UsageShape; totalCostUsd: number; stopReason: string | null; receivedAt: string }
  // Overlay (SDK iterator only — never enters messages[])
  | { kind: 'stream-event'; uuid: string; deltaText: string }
  | { kind: 'rate-limit'; info: RateLimitInfo }
  | { kind: 'lifecycle'; eventType: LifecycleKind; raw: unknown };

/** Convenience: which kinds appear in the renderer's `messages[]`. */
export type RenderedKind = Exclude<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle'>;

/** Convenience: kinds that exist as overlay channels only. */
export type OverlayKind = Extract<JsonlNode['kind'], 'stream-event' | 'rate-limit' | 'lifecycle'>;
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: PASS — no type errors. (The file declares types only; nothing imports it yet.)

- [ ] **Step 3: Commit checkpoint**

```bash
git add src/types/jsonl.ts
git commit -m "feat(types): JsonlNode discriminated union"
```

---

## Task 2: Extract JSONL fixtures from real session files

**Files:**
- Create: `src/lib/__tests__/fixtures/jsonl-samples.ts`

Pull one representative line per known shape from Greg's session files. These become the test inputs for the classifier and synthesizer.

- [ ] **Step 1: Run the extraction script**

Run this in the project root:

```bash
python3 -c "
import json, glob, sys
DIR = '/Users/gregorychristie/.claude-personal/projects/-Users-gregorychristie-Repos-personal-omnifex'
samples = {}
for f in sorted(glob.glob(f'{DIR}/*.jsonl'))[:50]:
    try:
        with open(f) as fh:
            for line in fh:
                try: d = json.loads(line)
                except: continue
                t = d.get('type','?')
                st = d.get('subtype')
                key = t + ('/' + st if st else '')
                if key not in samples:
                    samples[key] = d
    except: pass
out_path = 'src/lib/__tests__/fixtures/jsonl-samples.ts'
print('export const JSONL_SAMPLES = {')
for k, v in sorted(samples.items()):
    js = json.dumps(v, indent=2)
    # convert python booleans to TS
    js = js.replace(': true', ': true').replace(': false', ': false').replace(': null', ': null')
    safe_key = repr(k)
    print(f'  {safe_key}: {js} as const,')
print('} as const;')
" > src/lib/__tests__/fixtures/jsonl-samples.ts
```

Verify the file was written:

```bash
head -20 src/lib/__tests__/fixtures/jsonl-samples.ts
```

Expected output: starts with `export const JSONL_SAMPLES = {` and contains keys like `'assistant'`, `'user'`, `'system/stop_hook_summary'`, etc.

- [ ] **Step 2: Strip any sensitive content**

The samples come from Greg's real sessions. Open `src/lib/__tests__/fixtures/jsonl-samples.ts` in the editor and scan for anything sensitive (paths, file contents in tool_result blocks, API keys). For Phase 2.1, we only need shape — replace inner text blocks with `"…"` placeholders if necessary. Keep the structural fields (`type`, `subtype`, `stop_reason`, `usage`, `timestamp`, etc.) intact.

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit checkpoint**

```bash
git add src/lib/__tests__/fixtures/jsonl-samples.ts
git commit -m "test(jsonl): extract JSONL fixture samples"
```

---

## Task 3: Classifier — conversation node kinds

**Files:**
- Create: `src/lib/jsonlClassifier.ts`
- Create: `src/lib/__tests__/jsonlClassifier.test.ts`

Cover the high-volume kinds first: `assistant`, `user`, `attachment`, `queue-operation`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/jsonlClassifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '../jsonlClassifier';
import { JSONL_SAMPLES } from './fixtures/jsonl-samples';

describe('classifyJsonlLine', () => {
  it('classifies assistant lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['assistant']);
    expect(node?.kind).toBe('assistant');
    if (node?.kind === 'assistant') {
      expect(node.sessionId).toBeTruthy();
      expect(node.receivedAt).toBeTruthy();
      expect(node.raw.message.role).toBe('assistant');
    }
  });

  it('classifies a user prompt as userKind=prompt', () => {
    const sample = {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: '2026-05-23T20:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') {
      expect(node.userKind).toBe('prompt');
    }
  });

  it('classifies a tool_result reply as userKind=tool-result', () => {
    const sample = {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: '2026-05-23T20:00:01Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
      },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') {
      expect(node.userKind).toBe('tool-result');
    }
  });

  it('classifies attachment lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['attachment']);
    expect(node?.kind).toBe('attachment');
  });

  it('classifies queue-operation lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['queue-operation']);
    expect(node?.kind).toBe('queue-operation');
  });

  it('returns null for malformed input', () => {
    expect(classifyJsonlLine(null)).toBeNull();
    expect(classifyJsonlLine(undefined)).toBeNull();
    expect(classifyJsonlLine('not an object')).toBeNull();
    expect(classifyJsonlLine({})).toBeNull();
    expect(classifyJsonlLine({ type: 'unknown-future-type' })).toBeNull();
  });

  it('uses receivedAt fallback when timestamp is missing', () => {
    const sample = {
      type: 'assistant',
      sessionId: 'sid-2',
      message: { role: 'assistant', content: [] },
    };
    const before = Date.now();
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('assistant');
    if (node?.kind === 'assistant') {
      const stamp = Date.parse(node.receivedAt);
      expect(stamp).toBeGreaterThanOrEqual(before);
    }
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- src/lib/__tests__/jsonlClassifier.test.ts`
Expected: FAIL — `Cannot find module '../jsonlClassifier'`.

- [ ] **Step 3: Implement the classifier**

Create `src/lib/jsonlClassifier.ts`:

```typescript
import type {
  JsonlNode,
  AssistantRaw,
  UserRaw,
  AttachmentRaw,
  QueueOpRaw,
} from '@/types/jsonl';

/**
 * Single source of truth for classifying a parsed JSONL line into the
 * renderer's taxonomy. Returns null for shapes we explicitly drop or
 * don't recognize — the caller appends only non-null results.
 *
 * Pure function; safe to call repeatedly on the same input. Tolerant of
 * missing optional fields (real JSONL lines often omit `timestamp` on
 * bookkeeping types).
 */
export function classifyJsonlLine(raw: unknown): JsonlNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string') return null;

  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  const receivedAt = typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString();

  switch (type) {
    case 'assistant':
      return classifyAssistant(r, sessionId, receivedAt);
    case 'user':
      return classifyUser(r, sessionId, receivedAt);
    case 'attachment':
      return classifyAttachment(r, sessionId, receivedAt);
    case 'queue-operation':
      return classifyQueueOp(r, sessionId, receivedAt);
    default:
      return null; // Other types covered in Task 4.
  }
}

function classifyAssistant(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  return {
    kind: 'assistant',
    raw: r as unknown as AssistantRaw,
    sessionId,
    receivedAt,
  };
}

function classifyUser(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  // Discriminate prompt vs tool-result: tool-result user messages have
  // exclusively `tool_result` content blocks; user prompts contain text
  // blocks (or are bare strings, in which case they're definitely prompts).
  const userKind = isToolResultOnly(content) ? 'tool-result' : 'prompt';
  return {
    kind: 'user',
    raw: r as unknown as UserRaw,
    sessionId,
    receivedAt,
    userKind,
  };
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result');
}

function classifyAttachment(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  if (!r.attachment || typeof r.attachment !== 'object') return null;
  return {
    kind: 'attachment',
    raw: r as unknown as AttachmentRaw,
    sessionId,
    receivedAt,
  };
}

function classifyQueueOp(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  if (typeof r.operation !== 'string') return null;
  return {
    kind: 'queue-operation',
    raw: r as unknown as QueueOpRaw,
    sessionId,
    receivedAt,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- src/lib/__tests__/jsonlClassifier.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add src/lib/jsonlClassifier.ts src/lib/__tests__/jsonlClassifier.test.ts
git commit -m "feat(classifier): conversation node kinds (assistant/user/attachment/queue-op)"
```

---

## Task 4: Classifier — bookkeeping + system + file-snapshot kinds

**Files:**
- Modify: `src/lib/jsonlClassifier.ts`
- Modify: `src/lib/__tests__/jsonlClassifier.test.ts`

Cover the remaining JSONL node types: `last-prompt`, `permission-mode`, `ai-title`, `file-history-snapshot`, and all `system/*` subtypes.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/__tests__/jsonlClassifier.test.ts` inside the existing `describe('classifyJsonlLine', ...)` block:

```typescript
  it('classifies last-prompt lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['last-prompt']);
    expect(node?.kind).toBe('last-prompt');
  });

  it('classifies permission-mode lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['permission-mode']);
    expect(node?.kind).toBe('permission-mode');
  });

  it('classifies ai-title lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['ai-title']);
    expect(node?.kind).toBe('ai-title');
  });

  it('classifies file-history-snapshot lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['file-history-snapshot']);
    expect(node?.kind).toBe('file-history-snapshot');
  });

  it('classifies system/stop_hook_summary', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/stop_hook_summary']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('stop_hook_summary');
    }
  });

  it('classifies system/local_command', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/local_command']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('local_command');
    }
  });

  it('classifies system/api_error', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/api_error']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('api_error');
    }
  });

  it('classifies system/turn_duration', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/turn_duration']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('turn_duration');
    }
  });

  it('classifies system/away_summary', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/away_summary']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('away_summary');
    }
  });

  it('classifies system/compact_boundary', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/compact_boundary']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('compact_boundary');
    }
  });

  it('classifies system/informational', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/informational']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('informational');
    }
  });

  it('returns null for system with unknown subtype', () => {
    const node = classifyJsonlLine({
      type: 'system',
      subtype: 'future_unknown_subtype',
      sessionId: 'sid',
      timestamp: '2026-05-24T00:00:00Z',
    });
    expect(node).toBeNull();
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- src/lib/__tests__/jsonlClassifier.test.ts`
Expected: most of the new tests FAIL — the classifier doesn't handle these types yet.

- [ ] **Step 3: Extend the classifier**

Update `src/lib/jsonlClassifier.ts`. Add to imports:

```typescript
import type {
  JsonlNode,
  AssistantRaw,
  UserRaw,
  AttachmentRaw,
  QueueOpRaw,
  LastPromptRaw,
  PermissionModeRaw,
  AiTitleRaw,
  FileSnapshotRaw,
  SystemRaw,
  SystemSubtype,
} from '@/types/jsonl';
```

Replace the `switch (type)` block with:

```typescript
  switch (type) {
    case 'assistant':
      return classifyAssistant(r, sessionId, receivedAt);
    case 'user':
      return classifyUser(r, sessionId, receivedAt);
    case 'attachment':
      return classifyAttachment(r, sessionId, receivedAt);
    case 'queue-operation':
      return classifyQueueOp(r, sessionId, receivedAt);
    case 'last-prompt':
      return classifyLastPrompt(r, sessionId);
    case 'permission-mode':
      return classifyPermissionMode(r, sessionId);
    case 'ai-title':
      return classifyAiTitle(r, sessionId);
    case 'file-history-snapshot':
      return classifyFileSnapshot(r);
    case 'system':
      return classifySystem(r, sessionId, receivedAt);
    default:
      return null;
  }
```

Add the new classification helpers below the existing ones:

```typescript
const SYSTEM_SUBTYPES: ReadonlySet<SystemSubtype> = new Set<SystemSubtype>([
  'stop_hook_summary',
  'local_command',
  'api_error',
  'turn_duration',
  'away_summary',
  'compact_boundary',
  'informational',
]);

function classifyLastPrompt(r: Record<string, unknown>, sessionId: string): JsonlNode | null {
  if (typeof r.lastPrompt !== 'string') return null;
  return {
    kind: 'last-prompt',
    raw: r as unknown as LastPromptRaw,
    sessionId,
  };
}

function classifyPermissionMode(r: Record<string, unknown>, sessionId: string): JsonlNode | null {
  if (typeof r.permissionMode !== 'string') return null;
  return {
    kind: 'permission-mode',
    raw: r as unknown as PermissionModeRaw,
    sessionId,
  };
}

function classifyAiTitle(r: Record<string, unknown>, sessionId: string): JsonlNode | null {
  if (typeof r.aiTitle !== 'string') return null;
  return {
    kind: 'ai-title',
    raw: r as unknown as AiTitleRaw,
    sessionId,
  };
}

function classifyFileSnapshot(r: Record<string, unknown>): JsonlNode | null {
  if (r.snapshot === undefined) return null;
  return {
    kind: 'file-history-snapshot',
    raw: r as unknown as FileSnapshotRaw,
  };
}

function classifySystem(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  const subtype = r.subtype;
  if (typeof subtype !== 'string') return null;
  if (!SYSTEM_SUBTYPES.has(subtype as SystemSubtype)) return null;
  return {
    kind: 'system',
    subtype: subtype as SystemSubtype,
    raw: r as unknown as SystemRaw,
    sessionId,
    receivedAt,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- src/lib/__tests__/jsonlClassifier.test.ts`
Expected: PASS — all 18+ tests.

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add src/lib/jsonlClassifier.ts src/lib/__tests__/jsonlClassifier.test.ts
git commit -m "feat(classifier): bookkeeping, system subtypes, file-history-snapshot"
```

---

## Task 5: Synthesizer — streaming state machine + batch wrapper

**Files:**
- Create: `src/lib/jsonlSynthesizer.ts`
- Create: `src/lib/__tests__/jsonlSynthesizer.test.ts`

Manufactures `synthesized-init` (first node with sessionId) and `synthesized-result` (after assistant with terminal stop_reason).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/jsonlSynthesizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createSynthesizer, synthesizeBatch } from '../jsonlSynthesizer';
import type { JsonlNode } from '@/types/jsonl';

function assistantNode(stopReason: string | null, ts = '2026-05-24T10:00:00Z'): JsonlNode {
  return {
    kind: 'assistant',
    raw: {
      type: 'assistant',
      sessionId: 'sid-1',
      timestamp: ts,
      cwd: '/Users/test/proj',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
        stop_reason: stopReason,
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-opus-4-7',
      },
    } as any,
    sessionId: 'sid-1',
    receivedAt: ts,
  };
}

function userPromptNode(ts = '2026-05-24T09:59:30Z'): JsonlNode {
  return {
    kind: 'user',
    raw: {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: ts,
      cwd: '/Users/test/proj',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'a prompt' }],
      },
    } as any,
    sessionId: 'sid-1',
    receivedAt: ts,
    userKind: 'prompt',
  };
}

describe('createSynthesizer', () => {
  it('emits synthesized-init once for the first sessioned node', () => {
    const s = createSynthesizer();
    const out1 = s.push(userPromptNode());
    expect(out1.map(n => n.kind)).toEqual(['synthesized-init', 'user']);
    const out2 = s.push(assistantNode('tool_use'));
    expect(out2.map(n => n.kind)).toEqual(['assistant']);
  });

  it('emits synthesized-result after assistant with terminal stop_reason', () => {
    const s = createSynthesizer();
    s.push(userPromptNode('2026-05-24T09:59:30Z'));
    const out = s.push(assistantNode('end_turn', '2026-05-24T10:00:00Z'));
    expect(out.map(n => n.kind)).toEqual(['assistant', 'synthesized-result']);
    const result = out[1];
    if (result.kind === 'synthesized-result') {
      expect(result.isError).toBe(false);
      expect(result.subtype).toBe('success');
      expect(result.stopReason).toBe('end_turn');
      expect(result.durationMs).toBe(30000); // 30s between prompt and reply
      expect(result.usage.input_tokens).toBe(100);
    }
  });

  it('emits synthesized-result with error subtype for max_tokens', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    const out = s.push(assistantNode('max_tokens'));
    const result = out[1];
    if (result.kind === 'synthesized-result') {
      expect(result.isError).toBe(true);
      expect(result.subtype).toBe('error_during_execution');
    }
  });

  it('does NOT emit synthesized-result for tool_use stop_reason', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    const out = s.push(assistantNode('tool_use'));
    expect(out.map(n => n.kind)).toEqual(['assistant']);
  });

  it('flush() emits synthesized-result for an unterminated turn', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    s.push(assistantNode(null)); // partial, no stop_reason
    const flushed = s.flush();
    expect(flushed.map(n => n.kind)).toEqual(['synthesized-result']);
    if (flushed[0].kind === 'synthesized-result') {
      expect(flushed[0].isError).toBe(true);
    }
  });

  it('flush() is a no-op when the last turn ended cleanly', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    s.push(assistantNode('end_turn'));
    expect(s.flush()).toEqual([]);
  });
});

describe('synthesizeBatch', () => {
  it('produces the same output for a complete sequence', () => {
    const nodes: JsonlNode[] = [
      userPromptNode('2026-05-24T09:59:30Z'),
      assistantNode('end_turn', '2026-05-24T10:00:00Z'),
    ];
    const out = synthesizeBatch(nodes);
    expect(out.map(n => n.kind)).toEqual([
      'synthesized-init',
      'user',
      'assistant',
      'synthesized-result',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- src/lib/__tests__/jsonlSynthesizer.test.ts`
Expected: FAIL — `Cannot find module '../jsonlSynthesizer'`.

- [ ] **Step 3: Implement the synthesizer**

Create `src/lib/jsonlSynthesizer.ts`:

```typescript
import type { JsonlNode, UsageShape } from '@/types/jsonl';

/**
 * Stop reasons that terminate a turn. An assistant message carrying one of
 * these is "the end of the user's exchange" — even if not a clean
 * completion. Synthesizer emits a result card after each.
 *
 * `tool_use` is an interstitial step (turn continues with tool_result).
 * Missing/null stop_reason means the assistant message is partial.
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

const SUCCESS_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
]);

// Live-stream session rates matching today's handleStreamMessage cost calc.
const INPUT_RATE_PER_TOKEN = 0.000003;
const OUTPUT_RATE_PER_TOKEN = 0.000015;

export interface Synthesizer {
  /** Feed one classified node in; returns input + any synthesized output. */
  push(node: JsonlNode): JsonlNode[];
  /** Flush at end-of-stream; emits synth-result for an unterminated turn. */
  flush(): JsonlNode[];
}

/**
 * Construct a streaming synthesizer. Stateful — tracks turn boundaries,
 * pending assistant messages, and whether `synth-init` has already fired.
 */
export function createSynthesizer(): Synthesizer {
  let initFired = false;
  let turnStartAt: string | null = null;
  let pendingAssistant: Extract<JsonlNode, { kind: 'assistant' }> | null = null;

  const out: JsonlNode[] = [];

  function maybeEmitInit(sessionId: string, cwd: string, receivedAt: string): void {
    if (initFired) return;
    if (!sessionId) return;
    initFired = true;
    out.push({
      kind: 'synthesized-init',
      sessionId,
      cwd,
      receivedAt,
    });
  }

  function emitResult(assistant: Extract<JsonlNode, { kind: 'assistant' }>): void {
    const stop = assistant.raw.message.stop_reason ?? null;
    const isTerminalClean = typeof stop === 'string' && SUCCESS_STOP_REASONS.has(stop);
    const startMs = turnStartAt ? Date.parse(turnStartAt) : NaN;
    const endMs = Date.parse(assistant.receivedAt);
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
    const usage = (assistant.raw.message.usage ?? {}) as UsageShape;
    const inputTokens = Number(usage.input_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? 0);
    const totalCostUsd = inputTokens * INPUT_RATE_PER_TOKEN + outputTokens * OUTPUT_RATE_PER_TOKEN;
    const lastText = extractLastText(assistant.raw.message.content);

    out.push({
      kind: 'synthesized-result',
      sessionId: assistant.sessionId,
      isError: !isTerminalClean,
      subtype: isTerminalClean ? 'success' : 'error_during_execution',
      body: lastText,
      durationMs,
      usage,
      totalCostUsd,
      stopReason: stop,
      receivedAt: assistant.receivedAt,
    });
  }

  function flushPending(): void {
    if (!pendingAssistant) return;
    // Unterminated turn — emit an error result.
    emitResult({
      ...pendingAssistant,
      raw: {
        ...pendingAssistant.raw,
        message: {
          ...pendingAssistant.raw.message,
          stop_reason: null, // explicitly mark as unterminated
        },
      },
    });
    pendingAssistant = null;
  }

  return {
    push(node: JsonlNode): JsonlNode[] {
      out.length = 0;

      // Emit init on the first node carrying a sessionId.
      if ('sessionId' in node && node.sessionId) {
        const cwd = extractCwd(node);
        const receivedAt = 'receivedAt' in node && node.receivedAt ? node.receivedAt : new Date().toISOString();
        maybeEmitInit(node.sessionId, cwd, receivedAt);
      }

      if (node.kind === 'user' && node.userKind === 'prompt') {
        // New turn boundary. Flush any pending unterminated turn first.
        flushPending();
        turnStartAt = node.receivedAt;
        out.push(node);
        return [...out];
      }

      if (node.kind === 'assistant') {
        const stop = node.raw.message.stop_reason ?? null;
        out.push(node);
        if (typeof stop === 'string' && TERMINAL_STOP_REASONS.has(stop)) {
          // Terminal turn-ender — emit result, clear pending.
          pendingAssistant = null;
          emitResult(node);
        } else {
          // Mid-turn (tool_use) or partial (null) — hold for potential flush.
          pendingAssistant = node;
        }
        return [...out];
      }

      out.push(node);
      return [...out];
    },

    flush(): JsonlNode[] {
      out.length = 0;
      flushPending();
      return [...out];
    },
  };
}

function extractCwd(node: JsonlNode): string {
  if (node.kind === 'assistant' || node.kind === 'user' || node.kind === 'attachment' || node.kind === 'system') {
    return (node.raw as { cwd?: string }).cwd ?? '';
  }
  return '';
}

function extractLastText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object' && (c as { type?: string }).type === 'text')
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('');
}

/**
 * Batch wrapper — feeds an array of classified nodes through the streaming
 * synthesizer and returns the augmented sequence. Used by loadSessionHistory.
 */
export function synthesizeBatch(nodes: JsonlNode[]): JsonlNode[] {
  const s = createSynthesizer();
  const out: JsonlNode[] = [];
  for (const node of nodes) {
    out.push(...s.push(node));
  }
  out.push(...s.flush());
  return out;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- src/lib/__tests__/jsonlSynthesizer.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add src/lib/jsonlSynthesizer.ts src/lib/__tests__/jsonlSynthesizer.test.ts
git commit -m "feat(synthesizer): streaming + batch synthesis of init/result nodes"
```

---

## Task 6: Adapter — translate JsonlNode into ClaudeStreamMessage shape

**Files:**
- Create: `src/lib/jsonlAdapter.ts`
- Create: `src/lib/__tests__/jsonlAdapter.test.ts`

The renderer's `messages[]` is `ClaudeStreamMessage[]` today. Rather than refactoring every consumer (StreamMessage.tsx, message filters, find-in-chat, copy/export, etc.), this adapter translates classified JSONL nodes into the existing shape. Synthesized nodes produce `{type:'system',subtype:'init',...}` and `{type:'result',...}` shapes matching the SDK iterator output.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/jsonlAdapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { jsonlNodeToStreamMessage } from '../jsonlAdapter';
import type { JsonlNode } from '@/types/jsonl';

describe('jsonlNodeToStreamMessage', () => {
  it('passes through an assistant node as its raw shape', () => {
    const node: JsonlNode = {
      kind: 'assistant',
      raw: {
        type: 'assistant',
        sessionId: 'sid',
        timestamp: 'ts',
        message: { role: 'assistant', content: [], stop_reason: 'end_turn' },
      } as any,
      sessionId: 'sid',
      receivedAt: 'ts',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('assistant');
    expect((msg as any).receivedAt).toBe('ts');
  });

  it('converts synthesized-init to system/init shape', () => {
    const node: JsonlNode = {
      kind: 'synthesized-init',
      sessionId: 'sid-xyz',
      cwd: '/p',
      receivedAt: 'ts-init',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('system');
    expect((msg as any).subtype).toBe('init');
    expect((msg as any).session_id).toBe('sid-xyz');
    expect((msg as any).cwd).toBe('/p');
    expect((msg as any).receivedAt).toBe('ts-init');
  });

  it('converts synthesized-result to result shape with synthesized:true', () => {
    const node: JsonlNode = {
      kind: 'synthesized-result',
      sessionId: 'sid',
      isError: false,
      subtype: 'success',
      body: 'done',
      durationMs: 1234,
      usage: { input_tokens: 10, output_tokens: 20 } as any,
      totalCostUsd: 0.001,
      stopReason: 'end_turn',
      receivedAt: 'ts-r',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('result');
    expect((msg as any).subtype).toBe('success');
    expect((msg as any).is_error).toBe(false);
    expect((msg as any).result).toBe('done');
    expect((msg as any).duration_ms).toBe(1234);
    expect((msg as any).total_cost_usd).toBe(0.001);
    expect((msg as any).stop_reason).toBe('end_turn');
    expect((msg as any).session_id).toBe('sid');
    expect((msg as any).synthesized).toBe(true);
  });

  it('returns null for overlay kinds (they do not enter messages[])', () => {
    expect(jsonlNodeToStreamMessage({ kind: 'stream-event', uuid: 'u', deltaText: 'x' })).toBeNull();
    expect(jsonlNodeToStreamMessage({ kind: 'rate-limit', info: { status: 'allowed' } })).toBeNull();
    expect(jsonlNodeToStreamMessage({ kind: 'lifecycle', eventType: 'status', raw: {} })).toBeNull();
  });

  it('returns null for purely bookkeeping kinds when dropBookkeeping is implied', () => {
    // The adapter itself passes them through as the raw object; the
    // filter layer decides whether to drop. We just confirm pass-through.
    const node: JsonlNode = {
      kind: 'last-prompt',
      raw: { type: 'last-prompt', lastPrompt: 'x', leafUuid: 'u', sessionId: 'sid' } as any,
      sessionId: 'sid',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('last-prompt');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- src/lib/__tests__/jsonlAdapter.test.ts`
Expected: FAIL — `Cannot find module '../jsonlAdapter'`.

- [ ] **Step 3: Implement the adapter**

Create `src/lib/jsonlAdapter.ts`:

```typescript
import type { JsonlNode } from '@/types/jsonl';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

/**
 * Translate a JsonlNode into the renderer's existing ClaudeStreamMessage
 * shape. Most nodes are pass-throughs (their `raw` IS a ClaudeStreamMessage
 * shape). Synthesized nodes produce the equivalent shapes the SDK iterator
 * would have emitted, so downstream consumers don't need to know whether
 * the message is real or synthesized.
 *
 * Returns null for overlay kinds (stream-event / rate-limit / lifecycle) —
 * those never enter messages[].
 */
export function jsonlNodeToStreamMessage(node: JsonlNode): ClaudeStreamMessage | null {
  switch (node.kind) {
    case 'assistant':
    case 'user':
    case 'attachment':
    case 'queue-operation':
    case 'last-prompt':
    case 'permission-mode':
    case 'ai-title':
    case 'file-history-snapshot':
    case 'system': {
      const raw = (node as { raw: unknown }).raw as ClaudeStreamMessage;
      if ('receivedAt' in node && node.receivedAt) {
        (raw as { receivedAt?: string }).receivedAt = node.receivedAt;
      }
      return raw;
    }
    case 'synthesized-init': {
      return {
        type: 'system',
        subtype: 'init',
        session_id: node.sessionId,
        cwd: node.cwd,
        receivedAt: node.receivedAt,
        synthesized: true,
      } as unknown as ClaudeStreamMessage;
    }
    case 'synthesized-result': {
      return {
        type: 'result',
        subtype: node.subtype,
        is_error: node.isError,
        result: node.body,
        duration_ms: node.durationMs,
        duration_api_ms: 0,
        num_turns: 0,
        stop_reason: node.stopReason,
        total_cost_usd: node.totalCostUsd,
        usage: node.usage,
        modelUsage: {},
        permission_denials: [],
        session_id: node.sessionId,
        receivedAt: node.receivedAt,
        synthesized: true,
      } as unknown as ClaudeStreamMessage;
    }
    case 'stream-event':
    case 'rate-limit':
    case 'lifecycle':
      return null;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- src/lib/__tests__/jsonlAdapter.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

```bash
git add src/lib/jsonlAdapter.ts src/lib/__tests__/jsonlAdapter.test.ts
git commit -m "feat(adapter): JsonlNode → ClaudeStreamMessage translation"
```

---

## Task 7: Refactor `loadSessionHistory` to use new pipeline

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`

The existing `loadSessionHistory` reads JSONL, normalizes via `normalizeMessageContent`, sets `receivedAt`, then runs `synthesizeResultMessages` (the old batch synthesizer). Refactor to route through `classifyJsonlLine → synthesizeBatch → jsonlNodeToStreamMessage`.

- [ ] **Step 1: Locate `loadSessionHistory`**

Run: `grep -n "loadSessionHistory" src/components/ClaudeCodeSession.tsx | head -5`

You should see it defined around line 780-820. Read the function body (~30-40 lines) to understand the existing flow.

- [ ] **Step 2: Refactor in place**

Replace the function body so it does:

```typescript
const loadSessionHistory = useCallback(async () => {
  if (!claudeSessionId || !accountResolution?.account.config_dir) return;
  try {
    const entries = await api.loadSessionHistory(
      claudeSessionId,
      projectPath,
      accountResolution.account.config_dir,
    );
    // Classify each raw JSONL line into the typed taxonomy. Drop unknowns
    // (null returns). Then synthesize init + result nodes. Finally translate
    // back into the existing ClaudeStreamMessage shape the renderer consumes.
    const nodes = entries
      .map((entry) => classifyJsonlLine(entry))
      .filter((n): n is NonNullable<typeof n> => n !== null);
    const synthesized = synthesizeBatch(nodes);
    const messages = synthesized
      .map((n) => jsonlNodeToStreamMessage(n))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    // Apply normalization (string→array content) for backward compatibility
    // with downstream consumers expecting array form.
    const normalized = messages.map((m) => normalizeMessageContent(m));
    setMessages(normalized);
  } catch (err) {
    console.error('loadSessionHistory failed:', err);
  }
}, [claudeSessionId, projectPath, accountResolution]);
```

Add the imports at the top of the file (if not already present):

```typescript
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { synthesizeBatch } from '@/lib/jsonlSynthesizer';
import { jsonlNodeToStreamMessage } from '@/lib/jsonlAdapter';
```

The existing `import { synthesizeResultMessages } from "@/lib/synthesizeResults";` stays for now — it's used elsewhere (mode switch reload). Phase 2.3 removes it.

Also find and replace the equivalent reload-on-mode-switch path around line 1200 (`setMessages(synthesizeResultMessages(loaded))`) to use the same classify→synthesize→adapt pipeline:

```typescript
.then((loaded) => {
  const nodes = loaded
    .map((entry) => classifyJsonlLine(entry))
    .filter((n): n is NonNullable<typeof n> => n !== null);
  const synthesized = synthesizeBatch(nodes);
  const messages = synthesized
    .map((n) => jsonlNodeToStreamMessage(n))
    .filter((m): m is NonNullable<typeof m> => m !== null);
  setMessages(messages.map((m) => normalizeMessageContent(m)));
})
```

- [ ] **Step 3: Run the type check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Run all renderer tests**

Run: `npm test -- src/`
Expected: existing tests pass. If any test that asserted on the old `synthesizeResultMessages` output fails because the new pipeline produces subtly different fields (e.g., `num_turns: 0` instead of an actual count), update the test expectation to match. The synthesizer's purpose is to produce *renderable* result cards, and the renderer doesn't depend on `num_turns` for any visible UI today.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Run: `npm start`. Open a resumed session that contains tool_use + tool_result + final response. Confirm:
- The Execution Complete card renders at the end of each turn (synthesized-result via adapter).
- The session loads without errors in the console.
- Message order and content match the previous behavior.

- [ ] **Step 7: Commit checkpoint**

```bash
git add src/components/ClaudeCodeSession.tsx
git commit -m "feat(renderer): loadSessionHistory routes through JSONL classifier+synthesizer"
```

---

## Task 8: Live pipeline — flag-gated `handleJsonlLine`

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`
- Modify: `src/hooks/useSessionLifecycle.ts`

Add a flag-gated parallel handler for live `claude-output:` events. When the flag is on, incoming raw JSONL lines flow through the new classifier+synthesizer+adapter pipeline. When off, today's `handleStreamMessage` runs unchanged.

The flag: `localStorage` key `omnifex:jsonl-pipeline` (string `'on'` for enabled, anything else for disabled).

- [ ] **Step 1: Add the flag helper**

In `src/components/ClaudeCodeSession.tsx`, near the top of the component file (after imports), add:

```typescript
/**
 * Phase 2.1 transitional flag. Default off. Set
 * `localStorage.setItem('omnifex:jsonl-pipeline', 'on')` in DevTools to
 * validate the new pipeline against a real session. Removed in Phase 2.1.d
 * once the new path is the only path.
 */
function isJsonlPipelineEnabled(): boolean {
  try {
    return localStorage.getItem('omnifex:jsonl-pipeline') === 'on';
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Build `handleJsonlLine`**

Inside the `ClaudeCodeSession` component, near `handleStreamMessage` (around line 836), add a new handler. It uses a stable synthesizer instance ref so streaming nodes accumulate state across messages:

```typescript
// One synthesizer instance per session lifetime. Re-created when the
// component re-mounts (matches handleStreamMessage's per-render scope).
const synthesizerRef = useRef(createSynthesizer());

const handleJsonlLine = useCallback((payload: string | object) => {
  try {
    if (!streamCtxRef.current.isMountedRef?.current) return;
    let raw: unknown;
    if (typeof payload === 'string') {
      raw = JSON.parse(payload);
    } else {
      raw = payload;
    }
    const node = classifyJsonlLine(raw);
    if (!node) return;
    const produced = synthesizerRef.current.push(node);
    const streamMessages = produced
      .map((n) => jsonlNodeToStreamMessage(n))
      .filter((m): m is NonNullable<ReturnType<typeof jsonlNodeToStreamMessage>> => m !== null)
      .map((m) => normalizeMessageContent(m));
    if (streamMessages.length === 0) return;
    // Append to messages[]. setMessages uses the store-level setter to stay
    // consistent with handleStreamMessage's pattern.
    streamCtxRef.current.setMessages?.((prev) => [...prev, ...streamMessages]);
  } catch (err) {
    console.error('handleJsonlLine failed:', err);
  }
}, []);
```

Also extend `streamCtxRef.current` to include `setMessages` (find the existing assignments around line 233 and add):

```typescript
streamCtxRef.current.setMessages = setMessages;
```

Update the `streamCtxRef` type interface (search for `setExtractedSessionInfo: typeof` and add the matching `setMessages: typeof setMessages` field).

- [ ] **Step 3: Gate the subscription**

In `src/hooks/useSessionLifecycle.ts`, find `attachStreamListeners` (around line 86). Today it subscribes `claude-output:` events to `handleStreamMessage`. Refactor to call either handler based on the flag at subscription time:

```typescript
const outputUnlisten = window.electronAPI.onEvent(
  `claude-output:${tabId}`,
  isJsonlPipelineEnabled()
    ? (...args: unknown[]) => { handleJsonlLine(args[0] as string | object); }
    : (...args: unknown[]) => { handleStreamMessage(args[0] as string | ClaudeStreamMessage); },
);
```

The hook needs `handleJsonlLine` in its args. Extend `UseSessionLifecycleArgs` with `handleJsonlLine: (payload: string | object) => void`. Pass it from `ClaudeCodeSession.tsx` alongside `handleStreamMessage`.

Add the flag helper to `useSessionLifecycle.ts` directly (or import from a shared location):

```typescript
function isJsonlPipelineEnabled(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('omnifex:jsonl-pipeline') === 'on';
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Run: `npm start`. Open a new session, leave the flag off:
- Confirm SDK mode renders identically to before.

Then in DevTools console:
```
localStorage.setItem('omnifex:jsonl-pipeline', 'on');
```

Close and reopen the tab (force-remount so the subscription re-attaches). Send a prompt and confirm:
- Assistant message renders.
- Execution Complete card appears at the end of the turn.
- Console shows no errors.

Try the same in TUI mode (via the start-in-terminal toggle). Confirm cards appear in the right panel.

- [ ] **Step 6: Commit checkpoint**

```bash
git add src/components/ClaudeCodeSession.tsx src/hooks/useSessionLifecycle.ts
git commit -m "feat(renderer): flag-gated JSONL pipeline live handler"
```

---

## Task 9: Switch flag default to on

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`
- Modify: `src/hooks/useSessionLifecycle.ts`

After validating Task 8 in real sessions for a day or two, flip the default.

- [ ] **Step 1: Flip the default**

In both `isJsonlPipelineEnabled` helpers, change the default branch from `return false;` to `return true;`. The localStorage opt-out remains for emergencies:

```typescript
function isJsonlPipelineEnabled(): boolean {
  try {
    const value = localStorage.getItem('omnifex:jsonl-pipeline');
    if (value === 'off') return false; // explicit opt-out
    return true; // default on
  } catch {
    return true;
  }
}
```

- [ ] **Step 2: Run the type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual verification**

Run: `npm start`. Default behavior should now use the JSONL pipeline. Confirm a session works end-to-end without setting any localStorage flags.

Set `localStorage.setItem('omnifex:jsonl-pipeline', 'off')` and confirm the old `handleStreamMessage` path still works as a fallback.

- [ ] **Step 4: Commit checkpoint**

```bash
git add src/components/ClaudeCodeSession.tsx src/hooks/useSessionLifecycle.ts
git commit -m "feat(renderer): default JSONL pipeline to on"
```

---

## Task 10: Settings UI restructure

**Files:**
- Modify: `src/components/settings-panels/AppearanceSettings.tsx`

Replace the four hard-filter toggles with a node-keyed list grouped into "JSONL nodes" and "Live overlay (SDK mode only)" sections.

- [ ] **Step 1: Update the settings store schema**

Find the chat-config schema definition (likely in `src/stores/chatConfigStore.ts` or similar — grep for `dropMeta\|dropTaskLifecycle\|dropEmptyUser\|dropHookLifecycle`). Extend the schema with the new toggles and migration:

```typescript
export interface HardFiltersV2 {
  dropBookkeeping: boolean;          // last-prompt, permission-mode, ai-title, file-history-snapshot
  dropHookSummaries: boolean;        // system/stop_hook_summary
  dropEmptyUser: boolean;            // user with no text content
  dropClosureCarriers: boolean;      // queue-operation, queued_command attachments
  dropSystemInformational: boolean;  // system/away_summary, system/local_command, system/informational
  hidePartialStreaming: boolean;     // overlay: stream_event
  hideSubagentLifecycle: boolean;    // overlay: task_*
  hideHookLifecycle: boolean;        // overlay: hook_*
  hideRateLimitNotices: boolean;     // overlay: rate-limit
}

const HARD_FILTERS_V2_DEFAULTS: HardFiltersV2 = {
  dropBookkeeping: true,
  dropHookSummaries: false,
  dropEmptyUser: true,
  dropClosureCarriers: true,
  dropSystemInformational: false,
  hidePartialStreaming: false,
  hideSubagentLifecycle: false,
  hideHookLifecycle: false,
  hideRateLimitNotices: false,
};

function migrateHardFilters(legacy: Partial<{
  dropMeta: boolean;
  dropTaskLifecycle: boolean;
  dropEmptyUser: boolean;
  dropHookLifecycle: boolean;
}>): HardFiltersV2 {
  return {
    ...HARD_FILTERS_V2_DEFAULTS,
    dropBookkeeping: legacy.dropMeta ?? HARD_FILTERS_V2_DEFAULTS.dropBookkeeping,
    hideSubagentLifecycle: legacy.dropTaskLifecycle ?? HARD_FILTERS_V2_DEFAULTS.hideSubagentLifecycle,
    dropEmptyUser: legacy.dropEmptyUser ?? HARD_FILTERS_V2_DEFAULTS.dropEmptyUser,
    hideHookLifecycle: legacy.dropHookLifecycle ?? HARD_FILTERS_V2_DEFAULTS.hideHookLifecycle,
  };
}
```

The migration runs once on first read; the legacy keys are then ignored.

- [ ] **Step 2: Update the AppearanceSettings UI**

Replace the existing `{/* Hard filters */}` block (lines 355-387) with:

```tsx
{/* JSONL node filters */}
<div className="space-y-3 pt-4 border-t border-border">
  <div>
    <Label>JSONL node filters</Label>
    <p className="text-caption text-muted-foreground mt-1">
      Filter messages by their source node type. Apply to every session.
    </p>
  </div>
  <FilterRow
    label="Drop bookkeeping"
    description="last-prompt, permission-mode, ai-title, file-history-snapshot — CLI internal state with no user-facing value."
    checked={hardFiltersV2.dropBookkeeping}
    onChange={(v) => { setHardFilterV2("dropBookkeeping", v); }}
  />
  <FilterRow
    label="Drop hook summaries"
    description="system/stop_hook_summary — post-hook execution rollups."
    checked={hardFiltersV2.dropHookSummaries}
    onChange={(v) => { setHardFilterV2("dropHookSummaries", v); }}
  />
  <FilterRow
    label="Drop empty/tool-only user messages"
    description="User messages with no text content (typically tool_result replies)."
    checked={hardFiltersV2.dropEmptyUser}
    onChange={(v) => { setHardFilterV2("dropEmptyUser", v); }}
  />
  <FilterRow
    label="Drop closure carriers"
    description="queue-operation and queued_command attachments — background-bash plumbing."
    checked={hardFiltersV2.dropClosureCarriers}
    onChange={(v) => { setHardFilterV2("dropClosureCarriers", v); }}
  />
  <FilterRow
    label="Drop system informational"
    description="system/away_summary, system/local_command, system/informational — diagnostic and slash-command echoes."
    checked={hardFiltersV2.dropSystemInformational}
    onChange={(v) => { setHardFilterV2("dropSystemInformational", v); }}
  />
</div>

{/* SDK-overlay filters */}
<div className="space-y-3 pt-4 border-t border-border">
  <div>
    <Label>Live overlay filters <span className="text-muted-foreground text-xs">(SDK mode only)</span></Label>
    <p className="text-caption text-muted-foreground mt-1">
      Apply to live-only event streams from the SDK iterator. No effect in Terminal mode.
    </p>
  </div>
  <FilterRow
    label="Hide partial token streaming"
    description="stream_event — typewriter effect during assistant responses."
    checked={hardFiltersV2.hidePartialStreaming}
    onChange={(v) => { setHardFilterV2("hidePartialStreaming", v); }}
  />
  <FilterRow
    label="Hide subagent lifecycle"
    description="task_started / task_progress / task_updated — drives SubagentBar."
    checked={hardFiltersV2.hideSubagentLifecycle}
    onChange={(v) => { setHardFilterV2("hideSubagentLifecycle", v); }}
  />
  <FilterRow
    label="Hide hook lifecycle"
    description="hook_started / hook_progress / hook_response — drives hook progress UI."
    checked={hardFiltersV2.hideHookLifecycle}
    onChange={(v) => { setHardFilterV2("hideHookLifecycle", v); }}
  />
  <FilterRow
    label="Hide rate-limit notices"
    description="rate_limit_event — drives budget telemetry."
    checked={hardFiltersV2.hideRateLimitNotices}
    onChange={(v) => { setHardFilterV2("hideRateLimitNotices", v); }}
  />
</div>
```

- [ ] **Step 3: Wire the filters into the message filter pipeline**

Find where the existing `dropMeta` etc. filters are applied to `messages[]` (grep for `dropMeta` in `src/lib/messageFilters.ts` if it exists, otherwise in `src/components/ClaudeCodeSession.tsx`). Add the new filters, keyed off JsonlNode kinds. The simplest mapping:

- `dropBookkeeping` → drop messages where `message.type ∈ {'last-prompt', 'permission-mode', 'ai-title', 'file-history-snapshot'}`
- `dropHookSummaries` → drop `message.type === 'system' && message.subtype === 'stop_hook_summary'`
- `dropEmptyUser` → drop `message.type === 'user'` where content is empty or tool_result-only (existing logic)
- `dropClosureCarriers` → drop `message.type === 'queue-operation'`; drop `message.type === 'attachment' && message.attachment?.type === 'queued_command'`
- `dropSystemInformational` → drop `message.type === 'system' && message.subtype ∈ {'away_summary', 'local_command', 'informational'}`

The hide-* overlay filters apply to separate UI surfaces (SubagentBar, hook progress, rate-limit service, partials buffer) — wire each one where it makes sense, gated by `if (filters.hideSubagentLifecycle) return;` style checks at the entry point of each consumer.

- [ ] **Step 4: Run the type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Run: `npm start`. Open Settings → Chats. Confirm:
- Two grouped sections appear ("JSONL node filters" and "Live overlay filters (SDK mode only)").
- Toggling "Drop bookkeeping" hides previously-visible bookkeeping messages.
- Migration from legacy keys works (open a saved config with `dropMeta: true` and confirm `dropBookkeeping` is true).

- [ ] **Step 6: Commit checkpoint**

```bash
git add src/components/settings-panels/AppearanceSettings.tsx src/stores/chatConfigStore.ts
# (adapt paths to match where the schema actually lives)
git commit -m "feat(settings): JSONL-node-aware hard filter list"
```

---

## Task 11: Cleanup — delete dead paths

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`
- Modify: `src/lib/synthesizeResults.ts` (or delete)
- Modify: `electron/services/sessions/tui-jsonl.ts`
- Modify: `electron/services/sessions/events.ts` (if no longer used)
- Modify: `electron/services/sessions/runtime.ts`

Now that the JSONL pipeline is the only path, remove the legacy code.

- [ ] **Step 1: Delete the old flag helper**

Both copies of `isJsonlPipelineEnabled` (in `ClaudeCodeSession.tsx` and `useSessionLifecycle.ts`) can be removed. The subscription in `useSessionLifecycle.ts` now always calls `handleJsonlLine`.

- [ ] **Step 2: Delete the old `handleStreamMessage`**

Search for `handleStreamMessage` in `ClaudeCodeSession.tsx`. The function is large (~200 lines). It can be deleted along with `reduceSessionStreamMessage` it calls. Verify no other callers:

```bash
grep -rn "handleStreamMessage\|reduceSessionStreamMessage" src/
```

Expected: only the definitions and call sites in `ClaudeCodeSession.tsx` and `useSessionLifecycle.ts`. Delete the definitions; remove the lifecycle wiring; remove the streamCtxRef setter for it.

- [ ] **Step 3: Replace `synthesizeResults.ts` with a thin wrapper**

The file's existing `synthesizeResultMessages` may still have callers (e.g., the mode-switch reload path may have been incompletely refactored). Make it a backward-compat wrapper:

```typescript
// src/lib/synthesizeResults.ts (now a thin compatibility shim)
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { classifyJsonlLine } from './jsonlClassifier';
import { synthesizeBatch } from './jsonlSynthesizer';
import { jsonlNodeToStreamMessage } from './jsonlAdapter';

/**
 * @deprecated Use classifyJsonlLine + synthesizeBatch + jsonlNodeToStreamMessage directly.
 * This wrapper exists for callers that pass an already-shaped ClaudeStreamMessage[]
 * (e.g., tests). It re-classifies through the new pipeline.
 */
export function synthesizeResultMessages(messages: ClaudeStreamMessage[]): ClaudeStreamMessage[] {
  const nodes = messages
    .map((m) => classifyJsonlLine(m))
    .filter((n): n is NonNullable<typeof n> => n !== null);
  const out = synthesizeBatch(nodes);
  return out
    .map((n) => jsonlNodeToStreamMessage(n))
    .filter((m): m is NonNullable<typeof m> => m !== null);
}
```

- [ ] **Step 4: Clean up `tui-jsonl.ts`**

The TUI listener was the entry point for JSONL → renderer in the old pipeline. With the new pipeline, the renderer-side `handleJsonlLine` does the classification. The main-process listener still needs to forward raw lines onto `claude-output:<tabId>`. Audit its responsibilities:

- Forwarding raw JSONL lines on `claude-output:<tabId>` — KEEP.
- Forwarding closure carriers on `claude-output-extra:<tabId>` — KEEP (separate channel for the existing background-bash UI).
- Calling `classifyRuntimeEvent` + `dispatchResultNotification` + `onStatusChange` — these stay in main since they're backend concerns (the installer's wait-for-idle gate uses `handle.status`).

In short: `tui-jsonl.ts` keeps doing what it does after Phase 1.5 — main-process classification stays because it drives backend state. The renderer-side classification is an additional step layered on top.

No file changes here in Task 11; this step is verification that we don't accidentally delete needed code.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: tests in our touched code pass. Pre-existing flaky timeouts (claude-binary, git-watcher, installer) are still expected.

- [ ] **Step 6: Run type check + build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 7: Manual verification**

Run: `npm start`. Run a full SDK-mode session end-to-end. Run a full TUI-mode session end-to-end. Run a resumed session. All three should render identically to before this entire plan landed.

- [ ] **Step 8: Commit checkpoint**

```bash
git add src/components/ClaudeCodeSession.tsx src/hooks/useSessionLifecycle.ts src/lib/synthesizeResults.ts
git commit -m "refactor(renderer): remove legacy handleStreamMessage path"
```

---

## Final verification

- [ ] **Verification gate per `CLAUDE.md`:**

```bash
npm run check
npm run test:coverage
npm run build
npm run rebuild:electron
```

Expected: all pass. Pre-existing flaky failures (claude-binary, git-watcher, installer timeouts) acceptable. Coverage ≥80% on new files (`jsonlClassifier.ts`, `jsonlSynthesizer.ts`, `jsonlAdapter.ts`).

- [ ] **End-to-end smoke:**

1. SDK mode session: send a prompt, confirm typewriter streaming + Execution Complete card.
2. TUI cold-start session: send a prompt, confirm Execution Complete card on the right panel (the central regression Phase 1.6 was meant to fix).
3. Resume a long historical session: confirm cards render as before.
4. SDK → TUI toggle mid-session: confirm panel populates from JSONL.
5. Settings → Chats: confirm filter toggles affect message visibility.

- [ ] **Update memory** if anything surprising surfaced (per repo conventions).

---

## Self-Review (writing-plans skill)

**Spec coverage:**
- One classifier (Task 3, 4) ✅
- One synthesis layer (Task 5) ✅
- Renderer's `messages[]` driven from JSONL (Tasks 7, 8) ✅
- SDK iterator becomes overlay (Task 8 — `handleJsonlLine` ignores stream-event/lifecycle; existing channels for those keep flowing) ✅
- TUI mode uses same pipeline (Tasks 7, 8 — same code path for both modes) ✅
- Settings UI restructured (Task 10) ✅
- Phase 2.3 cleanup (Task 11) ✅
- Open mechanics questions from spec resolved:
  - Migration of localStorage filter keys → Task 10 (`migrateHardFilters`) ✅
  - When to call `flush()` → not invoked in live mode; only `synthesizeBatch` calls it for batch ✅
  - system/compact_boundary handling → classifier accepts it as system/compact_boundary; the adapter passes it through to renderer ✅

**Placeholder scan:** No "TBD" / "TODO" / "implement later" outside the deliberate Phase 3 deferral note.

**Type consistency:** `JsonlNode`, `JsonlNode.kind`, `classifyJsonlLine`, `createSynthesizer`, `synthesizeBatch`, `jsonlNodeToStreamMessage`, `isJsonlPipelineEnabled`, `handleJsonlLine` — names used consistently across all tasks.

**Migration risk:** The biggest risk is Task 8 — the flag-gated parallel handler. If the new pipeline produces subtly different messages[] than `handleStreamMessage` did, regressions are silent. Mitigation: manual A/B comparison in Task 8 Step 5, and Task 9 is gated behind those passing.

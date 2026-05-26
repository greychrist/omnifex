# Message-types settings redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the chat message-type taxonomy around the actual JSONL types and subtypes, add a side-line presentation variant alongside the existing card, introduce a single `unknown` bucket for diagnostic visibility, and fix the classifier-level bug that synthesized phantom `error_during_execution` cards for harness-injected user messages.

**Architecture:** Five phases. Phase 1 fixes the classifier and validates the synthesizer's behavior — this alone closes the phantom-error bug. Phase 2 expands the persisted config schema and replaces the kind catalog. Phase 3 splits the message frame into `card` and `side-line` variants. Phase 4 updates the Settings panel. Phase 5 removes redundant filters now subsumed by per-kind toggles.

**Tech Stack:** React 18 + TypeScript + Vitest + Tailwind v4. Renderer-only changes; the Electron main process is untouched.

**Spec:** `docs/superpowers/specs/2026-05-26-message-types-settings-redesign.md`.

---

## File structure

### New
- `src/components/StreamMessage/MessageFrame.tsx` — single switching component, picks `card` or `side-line` from config.
- `src/components/StreamMessage/MessageFrameCard.tsx` — moved from `src/components/MessageCard.tsx` (rename + relocate).
- `src/components/StreamMessage/MessageFrameSideLine.tsx` — new side-line variant.
- `src/lib/__tests__/jsonlClassifier.userMeta.test.ts` — new classifier cases.
- `src/lib/__tests__/jsonlSynthesizer.skillBody.test.ts` — bug-regression test for the phantom-error case.
- `src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx` — presentation dropdown / side-line UI hiding.
- `src/contexts/__tests__/MessageRenderingContext.firstLoad.test.tsx` — v1→v2 reset behavior.

### Modified
- `src/types/claudeStream.ts` — add `streamKind?: string` field on `ClaudeStreamMessage`.
- `src/types/jsonl.ts` — extend the `user` JsonlNode shape with `userKind` union; add `unknown` JsonlNode.
- `src/lib/jsonlClassifier.ts` — read `isMeta` and `sourceToolUseID`; emit five `userKind` values; return `kind: 'unknown'` for unmatched type/subtype.
- `src/lib/jsonlAdapter.ts` — set `streamKind` on every emitted `ClaudeStreamMessage`.
- `src/lib/blockKind.ts` — align block IDs with the new dotted catalog.
- `src/lib/messageFilters.ts` — drop the five JSONL hard filters (now redundant).
- `src/lib/compactGrouping.ts` — read `streamKind` instead of re-deriving.
- `src/lib/messageRenderingConfig.ts` — add `presentation`, `borderStyle`, `showRawPayload` fields; bump `version` to `2`; replace `DEFAULT_KINDS`.
- `src/contexts/MessageRenderingContext.tsx` — first-load reset when persisted version is missing or `< 2`.
- `src/components/StreamMessage.tsx` — route block rendering through `MessageFrame`.
- `src/components/AnsweredAskUserQuestionCard.tsx` — update `MessageCard` import to `MessageFrameCard` (or import the umbrella `MessageFrame`).
- `src/components/settings-panels/AppearanceSettings.tsx` — presentation + border dropdowns; conditional hiding of alignment / headerLabel for side-line; `showRawPayload` toggle for the `unknown` row only; remove the five JSONL hard-filter toggles; rebuild the Turn-preview sample stream.

### Deleted (after rename)
- `src/components/MessageCard.tsx` — replaced by `src/components/StreamMessage/MessageFrameCard.tsx`.

---

## Phase 1 — Pipeline fix (classifier + synthesizer)

This phase alone closes the phantom-error bug. After Phase 1 lands, the bug from the morning's release session can no longer reproduce.

### Task 1.1: Add `userKind` union to JsonlNode + `unknown` node

**Files:**
- Modify: `src/types/jsonl.ts`
- Test: covered indirectly by classifier tests in 1.2

- [ ] **Step 1: Update `UserNode` and add `UnknownNode`**

In `src/types/jsonl.ts`, change the `user` variant of `JsonlNode` to widen its `userKind`:

```ts
export type UserKind =
  | 'prompt'
  | 'tool-result'
  | 'meta-skill'
  | 'meta-attachment'
  | 'meta-other';

// ... existing imports / types ...

// (replace the existing `kind: 'user'` variant in the JsonlNode union with this)
{
  kind: 'user';
  raw: UserRaw;
  sessionId: string;
  receivedAt: string;
  userKind: UserKind;
}

// Add new variant to the JsonlNode union:
{
  kind: 'unknown';
  raw: Record<string, unknown>;
  sessionId: string;
  receivedAt: string;
}
```

- [ ] **Step 2: Run typecheck to surface every consumer that needs updating**

Run: `npm run check`
Expected: TypeScript errors at every `node.kind === 'user'` site that doesn't handle the new `userKind` values, and at every switch over `JsonlNode.kind` that doesn't handle `unknown`. Capture the list — Tasks 1.3 onward update them.

- [ ] **Step 3: Commit**

```bash
git add src/types/jsonl.ts
git commit -m "feat(jsonl): add UserKind union and unknown JsonlNode variant"
```

---

### Task 1.2: Classifier — `classifyUser` reads `isMeta` and `sourceToolUseID`

**Files:**
- Modify: `src/lib/jsonlClassifier.ts`
- Create: `src/lib/__tests__/jsonlClassifier.userMeta.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/jsonlClassifier.userMeta.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';

describe('classifyUser — userKind discrimination', () => {
  it('classifies plain text content as prompt', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('prompt');
  });

  it('classifies all-tool_result content as tool-result', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('tool-result');
  });

  it('classifies isMeta + sourceToolUseID as meta-skill', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      sourceToolUseID: 'toolu_abc',
      message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('meta-skill');
  });

  it('classifies isMeta + image marker as meta-attachment', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: '[Image: original 100x100 …]' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('meta-attachment');
  });

  it('classifies isMeta with neither marker as meta-other', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'arbitrary harness injection' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('meta-other');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/jsonlClassifier.userMeta.test.ts`
Expected: FAIL — all five cases except 'prompt' / 'tool-result' currently misclassify as 'prompt'.

- [ ] **Step 3: Implement `classifyUser` with the new discriminator**

In `src/lib/jsonlClassifier.ts`, replace the `classifyUser` function:

```ts
function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result');
}

function isAttachmentMarker(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return false;
  return first.text.startsWith('[Image: ');
}

function classifyUser(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  const isMeta = r.isMeta === true;
  const hasSourceToolUseID = typeof r.sourceToolUseID === 'string' && r.sourceToolUseID.length > 0;

  let userKind: 'prompt' | 'tool-result' | 'meta-skill' | 'meta-attachment' | 'meta-other';
  if (isToolResultOnly(content)) {
    userKind = 'tool-result';
  } else if (isMeta && hasSourceToolUseID) {
    userKind = 'meta-skill';
  } else if (isMeta && isAttachmentMarker(content)) {
    userKind = 'meta-attachment';
  } else if (isMeta) {
    userKind = 'meta-other';
  } else {
    userKind = 'prompt';
  }

  return { kind: 'user', raw: r as unknown as UserRaw, sessionId, receivedAt, userKind };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/jsonlClassifier.userMeta.test.ts`
Expected: PASS, all 5.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jsonlClassifier.ts src/lib/__tests__/jsonlClassifier.userMeta.test.ts
git commit -m "feat(classifier): discriminate user messages by isMeta and sourceToolUseID"
```

---

### Task 1.3: Classifier — return `kind: 'unknown'` instead of `null` for unmatched type / subtype

**Files:**
- Modify: `src/lib/jsonlClassifier.ts`
- Test: extend `src/lib/__tests__/jsonlClassifier.userMeta.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/lib/__tests__/jsonlClassifier.userMeta.test.ts`:

```ts
describe('classifyJsonlLine — unknown fallback', () => {
  it('returns kind: unknown for an unrecognized top-level type', () => {
    const node = classifyJsonlLine({
      type: 'mystery',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { foo: 'bar' },
    });
    expect(node?.kind).toBe('unknown');
  });

  it('returns kind: unknown for a known type with unrecognized subtype', () => {
    const node = classifyJsonlLine({
      type: 'system',
      subtype: 'never_seen_subtype',
      timestamp: '2026-05-26T00:00:00.000Z',
    });
    expect(node?.kind).toBe('unknown');
  });

  it('still returns null for completely malformed input', () => {
    expect(classifyJsonlLine(null)).toBeNull();
    expect(classifyJsonlLine('not-an-object')).toBeNull();
    expect(classifyJsonlLine({ /* missing type */ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/__tests__/jsonlClassifier.userMeta.test.ts`
Expected: FAIL on the two `unknown` cases (currently they return `null`).

- [ ] **Step 3: Update `classifyJsonlLine` and `classifySystem` / `classifyResult`**

In `src/lib/jsonlClassifier.ts`, replace the top-level `default:` branch:

```ts
    default:
      return {
        kind: 'unknown',
        raw: r,
        sessionId,
        receivedAt,
      };
```

In `classifySystem` (and analogously `classifyResult`), when the subtype is missing or not in the allow-list, return an unknown node:

```ts
function classifySystem(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  const subtype = r.subtype;
  if (typeof subtype !== 'string' || !SYSTEM_SUBTYPES.has(subtype as SystemSubtype)) {
    return { kind: 'unknown', raw: r, sessionId, receivedAt };
  }
  // ... existing return shape ...
}
```

Mirror the same pattern in `classifyResult`.

- [ ] **Step 4: Run all classifier tests**

Run: `npx vitest run src/lib/__tests__/jsonlClassifier`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jsonlClassifier.ts src/lib/__tests__/jsonlClassifier.userMeta.test.ts
git commit -m "feat(classifier): emit unknown JsonlNode for unmatched type/subtype"
```

---

### Task 1.4: Synthesizer — regression test for the phantom-error bug

**Files:**
- Create: `src/lib/__tests__/jsonlSynthesizer.skillBody.test.ts`

The synthesizer code doesn't change — Task 1.2 already makes the bug impossible to reproduce (meta-skill no longer triggers `flushPending`). This task pins that behavior with a regression test.

- [ ] **Step 1: Write the regression test**

Create `src/lib/__tests__/jsonlSynthesizer.skillBody.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { synthesizeBatch } from '@/lib/jsonlSynthesizer';

describe('synthesizer — skill-body injection regression', () => {
  it('does NOT emit a synthesized-result when a meta-skill user follows a tool_use assistant', () => {
    // Mirrors the JSONL we captured from the morning's release session:
    // user.prompt → assistant(text + tool_use:Skill) → user(tool_result) → user(meta-skill text).
    // The bug was that the meta-skill text was classified as user.prompt, which
    // triggered flushPending() against the prior assistant message and synthesized
    // a result with subtype 'error_during_execution'.
    const lines = [
      {
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'commit and push, then /omnifex-release' }] },
      },
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:22.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Committed and pushed. Now invoking the release skill.' },
            { type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'omnifex-release' } },
          ],
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:23.440Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_skill', content: '' }] },
      },
      {
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:23.439Z',
        isMeta: true,
        sourceToolUseID: 'toolu_skill',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n# OmniFex Release' }] },
      },
    ];

    const nodes = lines
      .map((l) => classifyJsonlLine(l))
      .filter((n): n is NonNullable<typeof n> => n !== null);

    const out = synthesizeBatch(nodes);
    const synthesizedResults = out.filter((n) => n.kind === 'synthesized-result');
    expect(synthesizedResults).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/lib/__tests__/jsonlSynthesizer.skillBody.test.ts`
Expected: PASS (because Task 1.2 already made this true).

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/jsonlSynthesizer.skillBody.test.ts
git commit -m "test(synthesizer): pin skill-body classification regression"
```

---

### Task 1.5: Adapter — set `streamKind` on every `ClaudeStreamMessage`

**Files:**
- Modify: `src/types/claudeStream.ts`
- Modify: `src/lib/jsonlAdapter.ts`
- Test: existing `src/lib/__tests__/jsonlAdapter.test.ts` (extend)

- [ ] **Step 1: Add the field to the type**

In `src/types/claudeStream.ts`, add an optional `streamKind` field to `ClaudeStreamMessage`:

```ts
export interface ClaudeStreamMessage {
  // ... existing fields ...
  /**
   * Dotted kind ID set by the classifier (e.g. "user.prompt",
   * "assistant.thinking", "result.success", "unknown"). Downstream
   * consumers — filters, blockKind, renderer, compactGrouping —
   * read this instead of re-deriving from type/subtype.
   */
  streamKind?: string;
}
```

- [ ] **Step 2: Write the failing adapter test**

Append to `src/lib/__tests__/jsonlAdapter.test.ts` (or create if not present):

```ts
it('sets streamKind on adapted messages', () => {
  const node = classifyJsonlLine({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-05-26T00:00:00.000Z',
    isMeta: true,
    sourceToolUseID: 'toolu_x',
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] },
  });
  expect(node).not.toBeNull();
  const msg = jsonlNodeToStreamMessage(node!);
  expect(msg?.streamKind).toBe('user.meta.skill');
});

it('sets streamKind = "unknown" for an unknown classification', () => {
  const node = classifyJsonlLine({ type: 'mystery', timestamp: '2026-05-26T00:00:00.000Z' });
  expect(node?.kind).toBe('unknown');
  const msg = jsonlNodeToStreamMessage(node!);
  expect(msg?.streamKind).toBe('unknown');
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/lib/__tests__/jsonlAdapter`
Expected: FAIL — `streamKind` is currently undefined on output.

- [ ] **Step 4: Implement `streamKind` assignment in the adapter**

In `src/lib/jsonlAdapter.ts`, find `jsonlNodeToStreamMessage` and add a `streamKind` computation that maps the JsonlNode to a dotted ID:

```ts
function deriveStreamKind(node: JsonlNode): string {
  switch (node.kind) {
    case 'user':
      switch (node.userKind) {
        case 'prompt': return 'user.prompt';
        case 'tool-result': return 'user.tool-result';
        case 'meta-skill': return 'user.meta.skill';
        case 'meta-attachment': return 'user.meta.attachment';
        case 'meta-other': return 'user.meta.other';
      }
      return 'user.prompt';
    case 'assistant':
      // assistant message-level streamKind defaults to the message's dominant
      // block kind; per-block kind lookups happen separately via blockKind.ts.
      return 'assistant.text';
    case 'system':
      return `system.${(node.raw as { subtype?: string }).subtype ?? 'informational'}`;
    case 'attachment':       return 'attachment';
    case 'queue-operation':  return 'queue-operation';
    case 'last-prompt':      return 'last-prompt';
    case 'permission-mode':  return 'permission-mode';
    case 'ai-title':         return 'ai-title';
    case 'file-history-snapshot': return 'file-history-snapshot';
    case 'real-result':
      return `result.${(node.raw as { subtype?: string }).subtype ?? 'success'}`;
    case 'synthesized-init':
      return 'system.init';
    case 'synthesized-result':
      return `result.${node.subtype}`;
    case 'unknown':
      return 'unknown';
  }
}
```

At the end of `jsonlNodeToStreamMessage`, before returning, set the field:

```ts
  const msg: ClaudeStreamMessage = { /* existing fields */ };
  msg.streamKind = deriveStreamKind(node);
  return msg;
```

- [ ] **Step 5: Run all adapter tests**

Run: `npx vitest run src/lib/__tests__/jsonlAdapter`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/claudeStream.ts src/lib/jsonlAdapter.ts src/lib/__tests__/jsonlAdapter.test.ts
git commit -m "feat(adapter): emit streamKind on every adapted message"
```

---

### Task 1.6: Phase 1 verification

- [ ] **Step 1: Run all renderer tests**

Run: `npm run check && npm test -- --run`
Expected: all green.

- [ ] **Step 2: Build the renderer**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Manually verify the phantom-error case**

Open the OmniFex app, start a chat session, immediately invoke any skill (e.g. `/verify` or any custom skill). Confirm: no red "Execution Failed" card appears between the skill banner and the next assistant message.

---

## Phase 2 — Schema, default catalog, first-load reset

### Task 2.1: Extend `MessageKindConfig` and bump version

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`

- [ ] **Step 1: Add the new fields to the interface**

In `src/lib/messageRenderingConfig.ts`, update `MessageKindConfig`:

```ts
export type Presentation = 'card' | 'side-line';
export type BorderStyle = 'solid' | 'dashed';

export interface MessageKindConfig {
  id: string;
  label: string;
  description: string;
  origin: Origin;
  icon: IconName;
  headerLabel: string | null;
  accentColor: string;
  alignment: Alignment;
  hiddenInCompact: boolean;
  compactBoundaryLocked: boolean;
  widget?: string;
  iconSize?: IconSize;
  iconBordered?: boolean;
  iconBgOpacity?: number;

  // New in v2:
  presentation: Presentation;
  borderStyle: BorderStyle;
  /** Only meaningful on the `unknown` row. */
  showRawPayload?: boolean;
}
```

- [ ] **Step 2: Extend the `Origin` union**

Replace:

```ts
export type Origin = "user" | "assistant" | "system" | "result" | "bookkeeping" | "fallback";
```

(`tool` and `subagent` were inconsistent — the new catalog groups by JSONL provenance.)

- [ ] **Step 3: Update the version literal**

Find the `version: 1` literal in the config type and bump:

```ts
export interface MessageRenderingConfig {
  version: 2;
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run check`
Expected: errors at every consumer that still references `version: 1` or that uses `Origin` values now removed. Capture and fix mechanically (will be fixed in 2.2 when the catalog is replaced).

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts
git commit -m "feat(config): add presentation/borderStyle fields and bump to v2"
```

---

### Task 2.2: Replace `DEFAULT_KINDS` with the v2 catalog

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`

- [ ] **Step 1: Replace `DEFAULT_KINDS` wholesale**

In `src/lib/messageRenderingConfig.ts`, replace the entire `DEFAULT_KINDS` array with the v2 catalog. Reproducing in full so out-of-order readers have the whole list:

```ts
export const DEFAULT_KINDS: MessageKindConfig[] = [
  // ───── ASSISTANT (block-level) ─────
  { id: "assistant.text", label: "Assistant text", description: "Assistant's prose response.", origin: "assistant", icon: "Bot", headerLabel: "Claude", accentColor: "primary", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "assistant.thinking", label: "Assistant thinking", description: "Extended thinking block before a tool call.", origin: "assistant", icon: "Brain", headerLabel: "Thinking", accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid", widget: "ThinkingWidget" },
  { id: "assistant.tool-use", label: "Tool call", description: "Assistant invoking a tool.", origin: "assistant", icon: "Terminal", headerLabel: null, accentColor: "info", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },

  // ───── USER ─────
  { id: "user.prompt", label: "User prompt", description: "Your typed message.", origin: "user", icon: "User", headerLabel: "You", accentColor: "blue", alignment: "right", hiddenInCompact: false, compactBoundaryLocked: true, presentation: "card", borderStyle: "solid" },
  { id: "user.tool-result", label: "Tool result", description: "Result returned by a tool.", origin: "user", icon: "CheckCheck", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.meta.skill", label: "Skill body", description: "Skill content injected by the harness.", origin: "user", icon: "Sparkles", headerLabel: "Skill", accentColor: "purple", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.meta.attachment", label: "Image attachment marker", description: "Inline marker that travels with a user prompt containing an image.", origin: "user", icon: "Image", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "user.meta.other", label: "Harness injection (other)", description: "Other isMeta=true user records we don't have a more specific kind for.", origin: "user", icon: "Info", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },

  // ───── SYSTEM ─────
  { id: "system.init", label: "Session init", description: "CLI session initialization.", origin: "system", icon: "Power", headerLabel: null, accentColor: "sysInit", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.notification", label: "Notification", description: "User-facing notifications.", origin: "system", icon: "Bell", headerLabel: null, accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "system.api_error", label: "API error", description: "Error returned by the Anthropic API.", origin: "system", icon: "AlertTriangle", headerLabel: null, accentColor: "red", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "system.stop_hook_summary", label: "Stop hook summary", description: "Summary of stop hooks that ran when the turn ended.", origin: "system", icon: "Hook", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.local_command", label: "Local command", description: "Echo of a /slash command the user ran.", origin: "system", icon: "ChevronRight", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.turn_duration", label: "Turn duration", description: "Diagnostic timing record.", origin: "system", icon: "Clock", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "system.away_summary", label: "Away summary", description: "Summary of what happened while user was away.", origin: "system", icon: "FileText", headerLabel: "Away summary", accentColor: "info", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "system.compact_boundary", label: "Compact boundary", description: "Marks where the conversation was compacted.", origin: "system", icon: "Scissors", headerLabel: "Compacted", accentColor: "muted", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid", widget: "CompactBoundaryWidget" },
  { id: "system.informational", label: "Informational", description: "Generic informational system message.", origin: "system", icon: "Info", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },

  // ───── RESULT ─────
  { id: "result.success", label: "Result · success", description: "Successful turn end.", origin: "result", icon: "Check", headerLabel: null, accentColor: "green", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "result.error_during_execution", label: "Result · error during execution", description: "Turn ended with an error.", origin: "result", icon: "AlertOctagon", headerLabel: "Execution Failed", accentColor: "red", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: true, presentation: "card", borderStyle: "solid" },
  { id: "result.user_interrupt", label: "Result · user interrupt", description: "User interrupted the assistant.", origin: "result", icon: "CircleStop", headerLabel: null, accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "result.max_tokens", label: "Result · max tokens", description: "Turn ended because max_tokens was reached.", origin: "result", icon: "AlertTriangle", headerLabel: "Max tokens", accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "result.refusal", label: "Result · refusal", description: "Assistant declined to respond.", origin: "result", icon: "ShieldOff", headerLabel: "Refused", accentColor: "amber", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },
  { id: "result.context_window_exceeded", label: "Result · context window exceeded", description: "Conversation exceeded the model's context window.", origin: "result", icon: "AlertTriangle", headerLabel: "Context window exceeded", accentColor: "red", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "card", borderStyle: "solid" },

  // ───── BOOKKEEPING (surfaced per Greg's "full control" preference) ─────
  { id: "attachment", label: "Attachment", description: "Attachment metadata record.", origin: "bookkeeping", icon: "Paperclip", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "queue-operation", label: "Queue operation", description: "Background queue operation record.", origin: "bookkeeping", icon: "ListOrdered", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "permission-mode", label: "Permission mode change", description: "Permission mode was changed mid-session.", origin: "bookkeeping", icon: "Shield", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "last-prompt", label: "Last prompt marker", description: "Bookmark of the last user prompt for resume.", origin: "bookkeeping", icon: "Bookmark", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "ai-title", label: "AI session title", description: "Generated session title.", origin: "bookkeeping", icon: "Tag", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },
  { id: "file-history-snapshot", label: "File history snapshot", description: "Snapshot of file state.", origin: "bookkeeping", icon: "Camera", headerLabel: null, accentColor: "muted", alignment: "left", hiddenInCompact: true, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "solid" },

  // ───── FALLBACK ─────
  { id: "unknown", label: "Unknown", description: "Diagnostic catch-all for unrecognized types or subtypes.", origin: "fallback", icon: "HelpCircle", headerLabel: "Unknown", accentColor: "orange", alignment: "left", hiddenInCompact: false, compactBoundaryLocked: false, presentation: "side-line", borderStyle: "dashed", showRawPayload: true },
];
```

If any `IconName` in the list isn't in `ALLOWED_ICONS`, add it. (Likely additions: `Brain`, `Power`, `Bell`, `Hook`, `Scissors`, `AlertOctagon`, `CircleStop`, `ShieldOff`, `Paperclip`, `ListOrdered`, `Shield`, `Bookmark`, `Tag`, `Camera`, `HelpCircle`, `Sparkles`, `Image`, `CheckCheck`.)

- [ ] **Step 2: Run typecheck**

Run: `npm run check`
Expected: PASS for `messageRenderingConfig.ts`. Other consumer errors are expected (Tasks 2.3 onward fix them).

- [ ] **Step 3: Commit**

```bash
git add src/lib/messageRenderingConfig.ts
git commit -m "feat(config): replace DEFAULT_KINDS with v2 catalog"
```

---

### Task 2.3: First-load reset behavior

**Files:**
- Modify: `src/contexts/MessageRenderingContext.tsx`
- Create: `src/contexts/__tests__/MessageRenderingContext.firstLoad.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/contexts/__tests__/MessageRenderingContext.firstLoad.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { MessageRenderingProvider, useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    loadSetting: vi.fn(),
    saveSetting: vi.fn(),
    log: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MessageRenderingProvider>{children}</MessageRenderingProvider>
);

describe('MessageRenderingContext — first-load reset', () => {
  beforeEach(() => {
    vi.mocked(api.loadSetting).mockReset();
    vi.mocked(api.saveSetting).mockReset();
    vi.mocked(api.log).mockReset();
  });

  it('resets a v1 config to v2 defaults and writes an app_logs entry', async () => {
    vi.mocked(api.loadSetting).mockResolvedValueOnce({ version: 1, kinds: { 'user.prompt': { /* stale */ } } });

    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });

    await waitFor(() => expect(result.current.config.version).toBe(2));
    expect(api.saveSetting).toHaveBeenCalledWith('message_rendering_config', expect.objectContaining({ version: 2 }));
    expect(api.log).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      source: 'frontend',
      category: 'settings:message-rendering',
      message: expect.stringContaining('reset'),
    }));
  });

  it('leaves a v2 config untouched', async () => {
    const existingV2 = { version: 2, kinds: {}, defaultViewMode: 'compact', hardFilters: {}, palette: {}, typography: {}, terminal: {} };
    vi.mocked(api.loadSetting).mockResolvedValueOnce(existingV2);

    renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(api.loadSetting).toHaveBeenCalled());

    expect(api.saveSetting).not.toHaveBeenCalled();
    expect(api.log).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/contexts/__tests__/MessageRenderingContext.firstLoad.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the reset logic**

In `src/contexts/MessageRenderingContext.tsx`, find the initial-load effect and add a version check:

```ts
const persisted = await api.loadSetting<MessageRenderingConfig>(MESSAGE_RENDERING_CONFIG_KEY);
if (!persisted || (persisted.version ?? 1) < 2) {
  const fresh = buildDefaultConfig(); // existing helper that assembles defaults
  await api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, fresh);
  await api.log({
    timestamp: new Date().toISOString(),
    level: 'info',
    source: 'frontend',
    category: 'settings:message-rendering',
    message: 'reset message rendering config v1 → v2 defaults',
  });
  setConfig(fresh);
} else {
  setConfig(persisted);
}
```

If `api.log` isn't a thing in this codebase, replace it with the equivalent logging call already used by other settings (search `messageRenderingConfig` or look at how `api.saveSetting` errors are logged today) and adjust the test to match.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/contexts/__tests__/MessageRenderingContext.firstLoad.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/MessageRenderingContext.tsx src/contexts/__tests__/MessageRenderingContext.firstLoad.test.tsx
git commit -m "feat(config): reset to v2 defaults on first load when persisted is v1"
```

---

### Task 2.4: Align `blockKind.ts` with new dotted IDs

**Files:**
- Modify: `src/lib/blockKind.ts`
- Test: extend `src/lib/__tests__/blockKind.test.ts`

- [ ] **Step 1: Inspect current block IDs**

Run: `grep -n "return '" src/lib/blockKind.ts | head -30`
Capture the current set of returned block IDs. The new IDs must be: `assistant.text`, `assistant.thinking`, `assistant.tool-use` (with the hyphen, not camelCase).

- [ ] **Step 2: Add the failing test**

Append to `src/lib/__tests__/blockKind.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyBlockKind } from '@/lib/blockKind';

describe('blockKind — alignment with new dotted catalog', () => {
  it('returns assistant.thinking for a thinking block', () => {
    expect(classifyBlockKind({ type: 'thinking', thinking: '...' }, /* ... */)).toBe('assistant.thinking');
  });
  it('returns assistant.text for a text block', () => {
    expect(classifyBlockKind({ type: 'text', text: 'hi' }, /* ... */)).toBe('assistant.text');
  });
  it('returns assistant.tool-use for a tool_use block', () => {
    expect(classifyBlockKind({ type: 'tool_use', name: 'Bash', input: {} }, /* ... */)).toBe('assistant.tool-use');
  });
});
```

(Replace the `/* ... */` placeholders with whatever extra args `classifyBlockKind` currently takes — check the file's existing signature.)

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/lib/__tests__/blockKind`
Expected: FAIL — current returns are likely `assistant.thinking`, `assistant.text`, `assistant.toolUse` (camelCase) or similar.

- [ ] **Step 4: Rename returns inside `blockKind.ts`**

`assistant.toolUse` → `assistant.tool-use` throughout. Leave other (sub-)IDs alone for now — the broader granularity stays as-is unless the existing IDs already conflict with the new catalog.

- [ ] **Step 5: Find every consumer of the old IDs**

Run: `grep -rn "assistant.toolUse" src/`
For each hit (likely the Settings palette + a few render branches), replace with `assistant.tool-use`.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run src/lib/__tests__/blockKind`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/blockKind.ts src/lib/__tests__/blockKind.test.ts $(grep -rl "assistant.toolUse" src/ 2>/dev/null)
git commit -m "refactor(blockKind): align IDs with v2 catalog (assistant.tool-use)"
```

---

### Task 2.5: Phase 2 verification

- [ ] **Step 1: Run full renderer suite**

Run: `npm run check && npm test -- --run`
Expected: all green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Boot the app**

Run: `npm start`
Expected: Settings → Chats → Message kinds shows the new catalog. Old user customizations are gone (expected, no migration). An `app_logs` row records the v1→v2 reset.

---

## Phase 3 — Rendering (MessageFrame + side-line variant)

### Task 3.1: Move `MessageCard.tsx` to `StreamMessage/MessageFrameCard.tsx`

**Files:**
- Create: `src/components/StreamMessage/MessageFrameCard.tsx` (moved content)
- Delete: `src/components/MessageCard.tsx`
- Modify: 2 import sites (`StreamMessage.tsx`, `AnsweredAskUserQuestionCard.tsx`)

- [ ] **Step 1: Create the new directory and move the file**

```bash
mkdir -p src/components/StreamMessage
git mv src/components/MessageCard.tsx src/components/StreamMessage/MessageFrameCard.tsx
```

- [ ] **Step 2: Rename the symbol**

Inside `src/components/StreamMessage/MessageFrameCard.tsx`, rename the exported component and props:

```ts
export interface MessageFrameCardProps extends MessageCardProps { /* same body */ }
export const MessageFrameCard: React.FC<MessageFrameCardProps> = (props) => {
  // existing body unchanged
};
```

Keep a temporary aliased export at the bottom so the next step's imports still compile:

```ts
export const MessageCard = MessageFrameCard;
export type MessageCardProps = MessageFrameCardProps;
```

- [ ] **Step 3: Update the two import sites**

In `src/components/StreamMessage.tsx` and `src/components/AnsweredAskUserQuestionCard.tsx`:

```ts
// Before:
import { MessageCard } from '@/components/MessageCard';
// After:
import { MessageFrameCard as MessageCard } from '@/components/StreamMessage/MessageFrameCard';
```

(Aliasing keeps the JSX `<MessageCard>` references unchanged.)

- [ ] **Step 4: Run typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Run tests + build**

Run: `npm test -- --run && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/StreamMessage/MessageFrameCard.tsx src/components/MessageCard.tsx src/components/StreamMessage.tsx src/components/AnsweredAskUserQuestionCard.tsx
git commit -m "refactor: move MessageCard → StreamMessage/MessageFrameCard"
```

---

### Task 3.2: Add `MessageFrameSideLine`

**Files:**
- Create: `src/components/StreamMessage/MessageFrameSideLine.tsx`
- Create: `src/components/StreamMessage/__tests__/MessageFrameSideLine.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `src/components/StreamMessage/__tests__/MessageFrameSideLine.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageFrameSideLine } from '@/components/StreamMessage/MessageFrameSideLine';

describe('MessageFrameSideLine', () => {
  it('renders the icon, label text, and a 2px left accent bar', () => {
    const { container } = render(
      <MessageFrameSideLine
        iconName="HelpCircle"
        accentColor="orange"
        borderStyle="dashed"
      >
        Unknown payload received
      </MessageFrameSideLine>
    );
    expect(screen.getByText('Unknown payload received')).toBeInTheDocument();
    const bar = container.querySelector('[data-testid="side-line-bar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('style')).toMatch(/border-left/);
    expect(bar?.getAttribute('style')).toMatch(/dashed/);
  });

  it('renders solid border by default', () => {
    const { container } = render(
      <MessageFrameSideLine iconName="Info" accentColor="muted" borderStyle="solid">
        text
      </MessageFrameSideLine>
    );
    const bar = container.querySelector('[data-testid="side-line-bar"]');
    expect(bar?.getAttribute('style')).toMatch(/solid/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrameSideLine.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement the component**

Create `src/components/StreamMessage/MessageFrameSideLine.tsx`:

```tsx
import * as React from 'react';
import * as LucideIcons from 'lucide-react';
import type { IconName, BorderStyle } from '@/lib/messageRenderingConfig';
import { resolveAccentSwatch } from '@/lib/accentStyle';

export interface MessageFrameSideLineProps {
  iconName: IconName;
  accentColor: string;
  borderStyle: BorderStyle;
  children: React.ReactNode;
}

export const MessageFrameSideLine: React.FC<MessageFrameSideLineProps> = ({
  iconName,
  accentColor,
  borderStyle,
  children,
}) => {
  const Icon = (LucideIcons[iconName as keyof typeof LucideIcons] as React.ComponentType<{ size?: number }>) ?? LucideIcons.Square;
  const swatch = resolveAccentSwatch(accentColor);

  return (
    <div className="flex items-center gap-2 py-1">
      <div
        data-testid="side-line-bar"
        style={{
          borderLeft: `2px ${borderStyle} ${swatch}`,
          height: '1.25rem',
          marginRight: '0.5rem',
        }}
      />
      <Icon size={14} />
      <span className="text-sm text-foreground/80">{children}</span>
    </div>
  );
};
```

(Use the project's existing `accentStyle.ts` helper for `resolveAccentSwatch`; if it isn't named exactly that, check `src/lib/accentStyle.ts` and adapt the import.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrameSideLine.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/StreamMessage/MessageFrameSideLine.tsx src/components/StreamMessage/__tests__/MessageFrameSideLine.test.tsx
git commit -m "feat(render): add MessageFrameSideLine variant"
```

---

### Task 3.3: Add `MessageFrame` switching component

**Files:**
- Create: `src/components/StreamMessage/MessageFrame.tsx`
- Create: `src/components/StreamMessage/__tests__/MessageFrame.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/StreamMessage/__tests__/MessageFrame.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MessageFrame } from '@/components/StreamMessage/MessageFrame';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

vi.mock('@/lib/api', () => ({ api: { loadSetting: vi.fn(async () => ({ version: 2, kinds: {
  'user.prompt': { id: 'user.prompt', label: '', description: '', origin: 'user', icon: 'User', headerLabel: 'You', accentColor: 'blue', alignment: 'right', hiddenInCompact: false, compactBoundaryLocked: true, presentation: 'card', borderStyle: 'solid' },
  'system.informational': { id: 'system.informational', label: '', description: '', origin: 'system', icon: 'Info', headerLabel: null, accentColor: 'muted', alignment: 'left', hiddenInCompact: true, compactBoundaryLocked: false, presentation: 'side-line', borderStyle: 'solid' },
}, defaultViewMode: 'compact', hardFilters: {}, palette: {}, typography: {}, terminal: {} })), saveSetting: vi.fn(), log: vi.fn() } }));

describe('MessageFrame', () => {
  it('renders MessageFrameCard when the kind presentation is card', () => {
    const { container } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.prompt">hi</MessageFrame>
      </MessageRenderingProvider>
    );
    // MessageFrameCard renders a bordered rounded container — the test asserts presence of the card-specific shell:
    expect(container.querySelector('[data-frame-variant="card"]')).not.toBeNull();
  });

  it('renders MessageFrameSideLine when the kind presentation is side-line', () => {
    const { container } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="system.informational">noise</MessageFrame>
      </MessageRenderingProvider>
    );
    expect(container.querySelector('[data-testid="side-line-bar"]')).not.toBeNull();
  });

  it('falls back to the unknown kind when streamKind is not in config', () => {
    const { container } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="not.in.catalog">???</MessageFrame>
      </MessageRenderingProvider>
    );
    // Unknown defaults to side-line + dashed:
    const bar = container.querySelector('[data-testid="side-line-bar"]');
    expect(bar?.getAttribute('style')).toMatch(/dashed/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrame.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement `MessageFrame`**

Create `src/components/StreamMessage/MessageFrame.tsx`:

```tsx
import * as React from 'react';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { MessageFrameCard } from './MessageFrameCard';
import { MessageFrameSideLine } from './MessageFrameSideLine';

export interface MessageFrameProps {
  streamKind: string;
  children: React.ReactNode;
  // Pass-through props for card variant (alignment, headerLabel, etc.)
  // come from the kind config; widget-specific overrides flow through children.
}

export const MessageFrame: React.FC<MessageFrameProps> = ({ streamKind, children }) => {
  const { config } = useMessageRenderingConfig();
  const kind = config.kinds[streamKind] ?? config.kinds.unknown;
  if (!kind) {
    // Defensive — unknown row missing entirely. Shouldn't happen post first-load reset.
    return <div data-frame-variant="missing">{children}</div>;
  }

  if (kind.presentation === 'card') {
    return (
      <div data-frame-variant="card">
        <MessageFrameCard
          icon={kind.icon}
          headerLabel={kind.headerLabel}
          accentColor={kind.accentColor}
          alignment={kind.alignment}
          borderStyle={kind.borderStyle}
        >
          {children}
        </MessageFrameCard>
      </div>
    );
  }

  return (
    <MessageFrameSideLine
      iconName={kind.icon}
      accentColor={kind.accentColor}
      borderStyle={kind.borderStyle}
    >
      {children}
    </MessageFrameSideLine>
  );
};
```

(The exact prop names `icon` / `headerLabel` / `accentColor` / `alignment` / `borderStyle` must match the existing `MessageFrameCard` (formerly `MessageCard`) signature. If they don't match today, do a tiny `MessageFrameCard` adapter inside this file to glue them — don't change `MessageFrameCard`'s contract in this task.)

`MessageFrameCard` needs a new `borderStyle` prop. If it doesn't accept one yet, add it now (defaulting to `solid`) and apply it as `border-style: <value>` on the outer card div.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrame.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/StreamMessage/MessageFrame.tsx src/components/StreamMessage/MessageFrameCard.tsx src/components/StreamMessage/__tests__/MessageFrame.test.tsx
git commit -m "feat(render): add MessageFrame variant-switching component"
```

---

### Task 3.4: Route `StreamMessage` blocks through `MessageFrame`

**Files:**
- Modify: `src/components/StreamMessage.tsx`
- Modify: `src/lib/blockKind.ts` (if needed to expose block streamKind)

- [ ] **Step 1: Locate the per-block render loop**

Run: `grep -n "blockKind\|classifyBlockKind\|MessageCard" src/components/StreamMessage.tsx | head -30`
Identify where individual blocks (thinking / text / tool_use) get rendered today.

- [ ] **Step 2: Wrap each block in a `MessageFrame`**

For each block render branch, replace the surrounding `MessageCard` with `<MessageFrame streamKind={blockStreamKind}>{blockContent}</MessageFrame>`, where `blockStreamKind` comes from `classifyBlockKind(block, …)`.

For top-level messages whose chrome is whole-message (user.prompt, system.*, result.*, etc.), replace their `MessageCard` wrapper with `<MessageFrame streamKind={message.streamKind ?? 'unknown'}>`.

- [ ] **Step 3: Move the copy/regenerate toolbar to the last card-presentation block**

In the assistant-message branch, after computing the list of visible blocks, find the index of the last block whose kind has `presentation: 'card'`. Attach the toolbar to that block's frame (pass it as a `footer` prop on `MessageFrameCard`, or render it as a sibling inside the card's body). If every block is side-line, attach to the last block regardless.

- [ ] **Step 4: Run snapshot / render tests**

Run: `npx vitest run src/components/`
Expected: existing snapshot tests for `StreamMessage` may need updates; review each diff and confirm it matches the spec (no double card frames, side-line where expected). Commit snapshot updates.

- [ ] **Step 5: Manually verify in the app**

Run: `npm start`
Expected: Open a session with a mix of thinking + text + tool_use blocks. Confirm the rhythm reads correctly — no nested card-in-card; thinking renders side-line in compact (per its default); text renders card; toolbar attaches to the last visible card.

- [ ] **Step 6: Commit**

```bash
git add src/components/StreamMessage.tsx $(git status -s | awk '/__snapshots__/ {print $2}')
git commit -m "refactor(render): route StreamMessage blocks through MessageFrame"
```

---

### Task 3.5: Phase 3 verification

- [ ] **Step 1: Full renderer test pass**

Run: `npm run check && npm test -- --run && npm run build`
Expected: all green.

- [ ] **Step 2: Eyeball the running app**

Run: `npm start` and click through: a chat session, a session with tool calls, a session with skill invocation, a session with thinking blocks, and the Settings → Chats → Turn preview tab. Confirm no visual regressions vs. the screenshots from earlier in the conversation.

---

## Phase 4 — Settings UI

### Task 4.1: Add Presentation + Border dropdowns to the kind editor

**Files:**
- Modify: `src/components/settings-panels/AppearanceSettings.tsx`
- Create: `src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearanceSettings } from '@/components/settings-panels/AppearanceSettings';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

vi.mock('@/lib/api', () => ({ /* as in Phase 2 test */ }));

describe('AppearanceSettings — presentation control', () => {
  it('shows a Presentation dropdown in each kind editor', async () => {
    render(<MessageRenderingProvider><AppearanceSettings /></MessageRenderingProvider>);
    // Open a kind row (use a known kind id from defaults):
    fireEvent.click(await screen.findByText(/User prompt/));
    expect(screen.getByLabelText(/Presentation/i)).toBeInTheDocument();
  });

  it('hides Alignment and Header label when Presentation is set to side-line', async () => {
    render(<MessageRenderingProvider><AppearanceSettings /></MessageRenderingProvider>);
    fireEvent.click(await screen.findByText(/User prompt/));
    fireEvent.change(screen.getByLabelText(/Presentation/i), { target: { value: 'side-line' } });
    expect(screen.queryByLabelText(/Alignment/i)).toBeNull();
    expect(screen.queryByLabelText(/Header label/i)).toBeNull();
  });

  it('shows a Border dropdown with solid/dashed options', async () => {
    render(<MessageRenderingProvider><AppearanceSettings /></MessageRenderingProvider>);
    fireEvent.click(await screen.findByText(/Unknown/));
    const border = screen.getByLabelText(/Border/i) as HTMLSelectElement;
    expect(border).toBeInTheDocument();
    expect(Array.from(border.options).map((o) => o.value)).toEqual(['solid', 'dashed']);
  });

  it('exposes the Show raw payload toggle only on the unknown row', async () => {
    render(<MessageRenderingProvider><AppearanceSettings /></MessageRenderingProvider>);
    fireEvent.click(await screen.findByText(/User prompt/));
    expect(screen.queryByLabelText(/Show raw payload/i)).toBeNull();

    fireEvent.click(await screen.findByText(/Unknown/));
    expect(screen.getByLabelText(/Show raw payload/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`
Expected: FAIL — controls don't exist yet.

- [ ] **Step 3: Add the controls to the kind editor**

In `src/components/settings-panels/AppearanceSettings.tsx`, find the existing kind-row editor (the expanded form when a kind is clicked) and add:

```tsx
<label className="block">
  <span className="text-xs text-muted-foreground">Presentation</span>
  <select
    aria-label="Presentation"
    value={kind.presentation}
    onChange={(e) => updateKind(kind.id, { presentation: e.target.value as 'card' | 'side-line' })}
  >
    <option value="card">Card</option>
    <option value="side-line">Side-line</option>
  </select>
</label>

<label className="block">
  <span className="text-xs text-muted-foreground">Border</span>
  <select
    aria-label="Border"
    value={kind.borderStyle}
    onChange={(e) => updateKind(kind.id, { borderStyle: e.target.value as 'solid' | 'dashed' })}
  >
    <option value="solid">Solid</option>
    <option value="dashed">Dashed</option>
  </select>
</label>

{kind.presentation === 'card' && (
  <>
    {/* existing Alignment + Header label controls go inside this block */}
  </>
)}

{kind.id === 'unknown' && (
  <label className="flex items-center gap-2">
    <input
      type="checkbox"
      aria-label="Show raw payload"
      checked={kind.showRawPayload ?? true}
      onChange={(e) => updateKind(kind.id, { showRawPayload: e.target.checked })}
    />
    <span className="text-xs">Show raw payload</span>
  </label>
)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/AppearanceSettings.tsx src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx
git commit -m "feat(settings): add Presentation/Border dropdowns and Show raw payload toggle"
```

---

### Task 4.2: Remove the five redundant JSONL hard-filter toggles

**Files:**
- Modify: `src/components/settings-panels/AppearanceSettings.tsx`
- Modify: `src/lib/messageRenderingConfig.ts` (drop fields from `hardFilters` type + default)

- [ ] **Step 1: Remove the toggles from the Global tab**

In `src/components/settings-panels/AppearanceSettings.tsx`, locate the "JSONL node filters" section and delete the five toggles (`dropBookkeeping`, `dropHookSummaries`, `dropEmptyUser`, `dropClosureCarriers`, `dropSystemInformational`). Keep the "Live overlay filters" section intact.

- [ ] **Step 2: Drop the fields from the config type**

In `src/lib/messageRenderingConfig.ts`, the `hardFilters` interface loses these five keys. Update both the type and the default value.

- [ ] **Step 3: Run typecheck**

Run: `npm run check`
Expected: errors at every consumer of the removed keys. Each consumer is a stale read — delete the call or replace with the equivalent per-kind `hiddenInCompact` check.

- [ ] **Step 4: Run tests + build**

Run: `npm test -- --run && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/AppearanceSettings.tsx src/lib/messageRenderingConfig.ts $(git status -s | awk '{print $2}')
git commit -m "refactor(settings): drop five JSONL hard-filter toggles redundant with per-kind hiddenInCompact"
```

---

### Task 4.3: Rebuild the Turn-preview sample stream

**Files:**
- Modify: `src/components/settings-panels/AppearanceSettings.tsx` (the Turn-preview tab body)

- [ ] **Step 1: Find the existing sample messages**

Run: `grep -n "Turn preview\|sampleMessages\|previewMessages" src/components/settings-panels/AppearanceSettings.tsx`
Locate the array driving the preview tab.

- [ ] **Step 2: Replace with a representative sample**

Replace the array with one entry per major kind in the new catalog. Aim for ~12 entries covering: user.prompt, assistant.thinking, assistant.text, assistant.tool-use, user.tool-result, user.meta.skill, system.notification, system.stop_hook_summary, system.api_error (one card and one side-line example), result.success, result.error_during_execution, attachment, plus one unknown row.

Each entry is a `ClaudeStreamMessage` with `streamKind` set to the exact ID. The preview component should already route through `MessageFrame` after Task 3.4.

- [ ] **Step 3: Manually verify**

Run: `npm start`
Expected: Settings → Chats → Turn preview shows all the new kinds side-by-side in compact and verbose. Each visually distinct (card vs side-line, accent colors).

- [ ] **Step 4: Commit**

```bash
git add src/components/settings-panels/AppearanceSettings.tsx
git commit -m "feat(settings): rebuild Turn-preview sample stream with v2 catalog"
```

---

### Task 4.4: Phase 4 verification

- [ ] **Step 1: Full gate**

Run: `npm run check && npm test -- --run && npm run build`
Expected: all green.

- [ ] **Step 2: Manual UI walk-through**

Run: `npm start` → Settings → Chats. Confirm:
- The kind list shows every entry from the v2 catalog grouped by origin.
- Each row's editor surfaces Presentation + Border dropdowns.
- The Alignment / Header label controls hide when Presentation = side-line.
- The Unknown row uniquely surfaces Show raw payload.
- The Global tab no longer shows the five JSONL hard-filter toggles.
- The Turn preview tab shows the new sample stream.

---

## Phase 5 — Cleanup

### Task 5.1: Simplify `messageFilters.ts`

**Files:**
- Modify: `src/lib/messageFilters.ts`
- Test: existing `src/lib/__tests__/messageFilters.test.ts`

- [ ] **Step 1: Inventory the now-redundant filter logic**

Run: `grep -n "dropBookkeeping\|dropHookSummaries\|dropEmptyUser\|dropClosureCarriers\|dropSystemInformational" src/lib/messageFilters.ts`
Capture the relevant branches.

- [ ] **Step 2: Delete each redundant branch**

For each match, delete the conditional. Per-kind `hiddenInCompact` now does the work. Keep:
- The `isSkillInjected` detection (Task 1.2 makes this redundant for classification, but messageFilters still uses it for special rendering; leave it for now — a follow-up can remove it once everything reads `streamKind`).
- The live-overlay filters (`hidePartialStreaming` etc.) — those are unrelated.

- [ ] **Step 3: Update the existing tests**

In `src/lib/__tests__/messageFilters.test.ts`, delete any `dropBookkeeping=true` / `dropHookSummaries=true` / etc. test cases. They reference fields that no longer exist.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/messageFilters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageFilters.ts src/lib/__tests__/messageFilters.test.ts
git commit -m "refactor(filters): drop hard-filter branches subsumed by per-kind hiddenInCompact"
```

---

### Task 5.2: `compactGrouping.ts` reads `streamKind`

**Files:**
- Modify: `src/lib/compactGrouping.ts`

- [ ] **Step 1: Find the existing kind derivation**

Run: `grep -n "blockKind\|message.type\|message.subtype" src/lib/compactGrouping.ts`
Locate where compact grouping derives a kind ID per message.

- [ ] **Step 2: Replace with `streamKind` lookup**

Where the file currently does:

```ts
const id = classifyMessageKind(message); // or some derivation
```

Replace with:

```ts
const id = message.streamKind ?? 'unknown';
```

- [ ] **Step 3: Delete the now-dead `classifyMessageKind` helper** (if it existed only for compact grouping). Use `git grep classifyMessageKind` to confirm zero remaining call sites; delete the function if there are none.

- [ ] **Step 4: Run tests + build**

Run: `npm test -- --run && npm run check && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/compactGrouping.ts
git commit -m "refactor(grouping): read streamKind off ClaudeStreamMessage instead of re-deriving"
```

---

### Task 5.3: Final verification

- [ ] **Step 1: Run the full gate one more time**

Run: `npm run check && npm test -- --run && npm run build`
Expected: all green.

- [ ] **Step 2: Walk through the app**

Run: `npm start`. Walk through:
- A fresh session, send a prompt, observe the chat rendering with the new chrome.
- Invoke any skill — confirm the phantom-error card we set out to fix does NOT appear.
- Open Settings → Chats → toggle Presentation on a few kinds, confirm the chat updates live.
- Force an unknown by editing a JSONL line manually or trust the dashed-border `Unknown` row in Turn preview.

- [ ] **Step 3: Final commit (if any straggler edits)**

```bash
git status   # should be clean
```

If clean, ship. Otherwise commit the strays under a single `chore(settings): finalize message-types redesign` commit and ship.

---

## Self-review

### Spec coverage

| Spec section | Plan task(s) |
|---|---|
| Schema | 2.1 |
| Kind catalog | 2.2 |
| Pipeline — classifier user discrimination | 1.2 |
| Pipeline — classifier unknown fallback | 1.3 |
| Pipeline — synthesizer regression | 1.4 |
| Pipeline — adapter streamKind | 1.5 |
| Pipeline — blockKind alignment | 2.4 |
| Rendering — MessageFrameCard rename | 3.1 |
| Rendering — MessageFrameSideLine | 3.2 |
| Rendering — MessageFrame variant switch | 3.3 |
| Rendering — copy/regenerate anchoring | 3.4 (Step 3) |
| Unknown bucket | covered by 1.3 + 2.2 + 3.3 + 4.1 |
| Settings UI — presentation + border + showRawPayload | 4.1 |
| Settings UI — remove redundant hardFilters | 4.2 |
| Settings UI — Turn preview rebuild | 4.3 |
| First-load reset | 2.3 |
| Testing strategy | covered per-task |
| Risks | 3.4 covers buttons; rename risk covered by 3.1 typecheck step |

### Placeholder scan
- Task 3.4 Step 2 says "find the index of the last block whose kind has `presentation: 'card'`" but doesn't show the full code. Acceptable because the surrounding file structure isn't knowable from the spec alone; the engineer needs to read `StreamMessage.tsx` first. Marked clearly.
- Task 2.3 Step 3 says "If `api.log` isn't a thing in this codebase, replace it with the equivalent". This is a known unknown — the spec doesn't pin the logging API. Marked clearly with concrete instructions.

### Type consistency
- `Presentation` and `BorderStyle` types declared in 2.1, used in 2.2 and 3.2 and 4.1 — consistent.
- `userKind` union values: declared in 1.1, used in 1.2, mapped in 1.5 — consistent.
- `streamKind` field: declared in 1.5, used in 3.3 (`MessageFrame`), 4.3 (preview), 5.2 (compactGrouping) — consistent.
- `MessageFrameCard` vs `MessageCard`: rename happens in 3.1 with a temporary alias, fully complete after all import sites flip.

No drift between tasks.


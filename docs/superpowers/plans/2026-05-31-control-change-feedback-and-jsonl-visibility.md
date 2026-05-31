# Control-change feedback + universal JSONL visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give visible, stylable transcript feedback when permission/effort/model changes, and make every JSONL bookkeeping kind render (collapsed in compact, reachable in verbose) instead of being silently dropped.

**Architecture:** Two mechanisms over the existing v5 `KIND_REGISTRY` + `resolveKind` model. (A) Add registry entries + render branches for the JSONL bookkeeping kinds (`permission-mode`, `last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot`) and teach `classifyStandaloneKind` to id them so compact-grouping honors their visibility. (B) Add a synthetic in-memory `control-change` `JsonlNode` variant injected via `appendMessage` when the effort/model pickers fire, rendered through one shared "control change" render branch. Permission already persists to JSONL (mechanism A renders it); effort/model are live-only.

**Tech Stack:** React 18 + TypeScript + Tailwind v4 (renderer), Vitest. Renderer + types only; no Electron service logic changes (the IPC handlers for set_effort/set_model/set_permission_mode already exist).

**Reference spec:** `docs/superpowers/specs/2026-05-31-control-change-feedback-and-jsonl-visibility-design.md`

**Branch:** continue on the current branch `redesign/message-kind-registry` (do NOT create a new branch; the registry work this builds on lives here).

---

## Notes for the implementer

- All paths relative to `/Users/gregorychristie/Repos/personal/omnifex`.
- Single test file: `npx vitest run <path>`. Full: `npm test`. Typecheck: `npm run check`. Build: `npm run build`.
- TDD throughout: failing test → red → implement → green → commit.
- After the final vitest run, run `npm run rebuild:electron` (rebuilds the native module for Electron so the app starts cleanly).
- **Read exact surrounding code before each edit.** This plan cites line numbers from a working snapshot, but the file may have shifted; match on the quoted code, not the line number.
- Pre-existing unrelated uncommitted files in the tree (`electron/services/sessions/lifecycle.ts`, `permissions.ts`, `queries.ts`, `src/components/SubagentBar.tsx`, two untracked test files) and the uncommitted `AnsweredAskUserQuestionCard` "Other:" fix are NOT part of this work — do not stage or revert them. Stage only the files each task lists.

### Key facts established during planning
- `JsonlNode` union: `src/types/jsonl.ts:131-146`. Bookkeeping variants `last-prompt`/`permission-mode`/`ai-title`/`file-history-snapshot` carry **no `receivedAt`**; `queue-operation` does.
- Renderer drops bookkeeping kinds at `src/components/StreamMessage.tsx:360-369` (`return null`).
- `classifyJsonlLine` (`src/lib/jsonlClassifier.ts`) runs on both resume (`AgentSession.tsx:826`) and live (`AgentSession.tsx:922`) ingest — rendering a kind covers both.
- `classifyStandaloneKind` (`src/lib/messageKind.ts`) gates compact-grouping: a kind it returns `null` for is force-swept into a hidden group regardless of its registry `hiddenInCompact` flag.
- **Control pickers are INLINE closures in the ControlBar JSX**, not named handlers. Confirmed locations in `AgentSession.tsx`: `onEffortChange={(level) => {...}}` (~line 2252), `onLiveModelChange={(newModel) => {...}}` (~line 2263), `onPermissionModeChange={(mode) => {...}}` (~line 2277). Each closure: updates local React state (`setEffort`/`setSelectedModel`/`setPermissionMode`), then `if (persistentSessionRef.current) { const tid = tabIdRef.current; api.sessionSet<X>(tid, value).catch(...) }`.
- **API method names** (NOT `api.setEffort`): `api.sessionSetEffort(tid, level)`, `api.sessionSetModel(tid, newModel)`, `api.sessionSetPermissionMode(tid, mode)`. They return promises; the existing closures only `.catch`, never `.then`.
- **Live-session guard** is `persistentSessionRef.current` (truthy when a stream-json session is running). Only inject markers inside that guard — a non-live (TUI/no-engine) tab has nowhere to show them and the control request no-ops anyway.
- **`appendMessage` is a ONE-ARG bound function** from `useTabSession` (`src/stores/claudeSessionStore.ts`): `appendMessage(msg: JsonlNode) => void` (already bound to this tab). In `AgentSession.tsx` it is destructured at ~line 185 and also reachable as `ctx.appendMessage(message)` in the live handler (~line 1050). In the picker closures, call the destructured `appendMessage(node)` directly (it's in scope in the component body where the JSX lives). Append the synthetic node with `sessionId: tabIdRef.current` (the live `tid`).
- Side-line presentation (`MessageFrameSideLine`) has **no footer**, so side-line kinds have no timestamp concern. Only `MessageFrameCard` renders a timestamp footer.
- `EffortLevel` includes `'default'` (the "let CLI default" sentinel); `onEffortChange` receives the raw `level` and passes it straight to `api.sessionSetEffort` — so the marker `value` should be `String(level)` (which is already `'high'`/`'default'`/etc.), no null-mapping needed.

---

## Phase A — Render the JSONL bookkeeping kinds

### Task A1: Registry entries for the five bookkeeping kinds

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts` (`KIND_REGISTRY`)
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/messageRenderingConfig.test.ts`:

```ts
import { KIND_REGISTRY, categoryOf, createDefaultConfig, resolveKind } from "@/lib/messageRenderingConfig";

describe("bookkeeping kind registry entries", () => {
  const ids = ["permission-mode", "last-prompt", "ai-title", "queue-operation", "file-history-snapshot"] as const;

  it("registers all five bookkeeping kinds under the system category", () => {
    for (const id of ids) {
      expect(KIND_REGISTRY[id], id).toBeDefined();
      expect(categoryOf(id), id).toBe("system");
    }
  });

  it("permission-mode is visible in compact; passive bookkeeping is hidden", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "permission-mode").hiddenInCompact).toBe(false);
    for (const id of ["last-prompt", "ai-title", "queue-operation", "file-history-snapshot"]) {
      expect(resolveKind(cfg, id).hiddenInCompact, id).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run red**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "bookkeeping kind registry"`
Expected: FAIL (ids not in registry).

- [ ] **Step 3: Implement**

In `src/lib/messageRenderingConfig.ts`, add these entries to `KIND_REGISTRY` (place after the `unknown` entry or in a new `// ── bookkeeping ──` group; all use icons already in `ALLOWED_ICONS`):

```ts
  // ── bookkeeping (real JSONL lines, previously dropped) ──
  "permission-mode": { id: "permission-mode", category: "system", label: "Permission mode", description: "Permission level changed mid-session.", default: { presentation: "side-line", icon: "ShieldCheck", accentColor: "amber", hiddenInCompact: false } },
  "last-prompt": { id: "last-prompt", category: "system", label: "Last-prompt bookmark", description: "Resume bookmark pointing at your most recent prompt.", default: { presentation: "side-line", icon: "Bookmark", accentColor: "muted", hiddenInCompact: true } },
  "ai-title": { id: "ai-title", category: "system", label: "Session title", description: "Auto-generated session title.", default: { presentation: "side-line", icon: "Tag", accentColor: "muted", hiddenInCompact: true } },
  "queue-operation": { id: "queue-operation", category: "system", label: "Background task", description: "Background-task enqueue (e.g. a run_in_background command).", default: { presentation: "side-line", icon: "ListOrdered", accentColor: "info", hiddenInCompact: true } },
  "file-history-snapshot": { id: "file-history-snapshot", category: "system", label: "File snapshot", description: "CLI editor undo/redo snapshot.", default: { presentation: "side-line", icon: "Clock", accentColor: "muted", hiddenInCompact: true } },
```

Verify each icon string (`ShieldCheck`, `Bookmark`, `Tag`, `ListOrdered`, `Clock`) is present in `ALLOWED_ICONS` in the same file; all five were confirmed present during planning.

- [ ] **Step 4: Run green**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(rendering): register the five JSONL bookkeeping kinds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: Classify bookkeeping kinds for compact-grouping

**Files:**
- Modify: `src/lib/messageKind.ts` (`classifyStandaloneKind`)
- Test: `src/lib/__tests__/messageKind.test.ts`

- [ ] **Step 1: Read** `src/lib/messageKind.ts` `classifyStandaloneKind` in full to see the existing `msg.kind` dispatch structure (the system / attachment / permission-request branches).

- [ ] **Step 2: Write the failing test**

Add to `src/lib/__tests__/messageKind.test.ts` (match the file's existing JsonlNode-literal style):

```ts
import { classifyStandaloneKind } from "@/lib/messageKind";

describe("classifyStandaloneKind — bookkeeping kinds", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["permission-mode", { kind: "permission-mode", raw: { type: "permission-mode", permissionMode: "acceptEdits" }, sessionId: "s" }],
    ["last-prompt", { kind: "last-prompt", raw: { type: "last-prompt", lastPrompt: "hi", leafUuid: "u" }, sessionId: "s" }],
    ["ai-title", { kind: "ai-title", raw: { type: "ai-title", aiTitle: "T" }, sessionId: "s" }],
    ["queue-operation", { kind: "queue-operation", raw: { type: "queue-operation", operation: "enqueue" }, sessionId: "s", receivedAt: "t" }],
    ["file-history-snapshot", { kind: "file-history-snapshot", raw: { type: "file-history-snapshot", snapshot: {} } }],
  ];
  it.each(cases)("returns %s for that node kind", (expected, node) => {
    expect(classifyStandaloneKind(node as never, [])).toBe(expected);
  });
});
```

- [ ] **Step 3: Run red**

Run: `npx vitest run src/lib/__tests__/messageKind.test.ts -t "bookkeeping kinds"`
Expected: FAIL (returns null today).

- [ ] **Step 4: Implement**

In `classifyStandaloneKind`, before the final `return null`, add a direct id passthrough for these node kinds. The kind id equals the node kind for all five, so:

```ts
  if (
    msg.kind === "permission-mode" ||
    msg.kind === "last-prompt" ||
    msg.kind === "ai-title" ||
    msg.kind === "queue-operation" ||
    msg.kind === "file-history-snapshot"
  ) {
    return msg.kind;
  }
```

Place this near the other `msg.kind`-based early branches (it must run before the `null` fallthrough). Ensure the function's parameter type already permits these kinds (it takes `JsonlNode`).

- [ ] **Step 5: Run green**

Run: `npx vitest run src/lib/__tests__/messageKind.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/messageKind.ts src/lib/__tests__/messageKind.test.ts
git commit -m "feat(rendering): classify bookkeeping kinds so compact-grouping honors visibility

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: Render the bookkeeping kinds in StreamMessage

**Files:**
- Modify: `src/components/StreamMessage.tsx`
- Test: `src/components/__tests__/MessageCard.test.tsx` (or a new `src/components/__tests__/bookkeepingKinds.test.tsx`)

- [ ] **Step 1: Read** `src/components/StreamMessage.tsx:354-414` to see the exact bookkeeping bail block and the `system` branch's `MessageFrame` usage to mirror.

- [ ] **Step 2: Write the failing test**

Create `src/components/__tests__/bookkeepingKinds.test.tsx`. Use `MessageRenderingPreviewProvider` + `createDefaultConfig()` (match the setup in `liveCardAccent.test.tsx`):

```tsx
import { render, screen } from "@testing-library/react";
import { MessageRenderingPreviewProvider } from "@/contexts/MessageRenderingContext";
import { createDefaultConfig } from "@/lib/messageRenderingConfig";
import { StreamMessage } from "@/components/StreamMessage";
import type { JsonlNode } from "@/types/jsonl";

function renderNode(node: JsonlNode) {
  return render(
    <MessageRenderingPreviewProvider config={createDefaultConfig()}>
      <StreamMessage message={node} streamMessages={[node]} />
    </MessageRenderingPreviewProvider>,
  );
}

it("renders a permission-mode change as 'Permission → <mode>'", () => {
  const node = { kind: "permission-mode", raw: { type: "permission-mode", permissionMode: "acceptEdits" }, sessionId: "s" } as JsonlNode;
  renderNode(node);
  expect(screen.getByText(/Permission → acceptEdits/)).toBeInTheDocument();
});

it("renders an ai-title node with the title", () => {
  const node = { kind: "ai-title", raw: { type: "ai-title", aiTitle: "Refactor auth" }, sessionId: "s" } as JsonlNode;
  renderNode(node);
  expect(screen.getByText(/Refactor auth/)).toBeInTheDocument();
});

it("renders a file-history-snapshot (no receivedAt) without throwing", () => {
  const node = { kind: "file-history-snapshot", raw: { type: "file-history-snapshot", snapshot: {} } } as JsonlNode;
  renderNode(node);
  expect(screen.getByText(/File snapshot/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run red**

Run: `npx vitest run src/components/__tests__/bookkeepingKinds.test.tsx`
Expected: FAIL (the kinds currently `return null`).

- [ ] **Step 4: Implement**

In `src/components/StreamMessage.tsx`:

(a) Remove `last-prompt`, `permission-mode`, `ai-title`, `file-history-snapshot` from the `return null` bail block (~lines 360-369). Leave `stream-event`, `rate-limit`, `lifecycle` in the bail (they are not transcript lines). The block becomes:

```tsx
    if (
      message.kind === 'stream-event' ||
      message.kind === 'rate-limit' ||
      message.kind === 'lifecycle'
    ) {
      return null;
    }
```

(b) Add a render branch for the five bookkeeping kinds (after the `system` branch is fine). Build a one-line body per kind and route through `MessageFrame` with `streamKind` = the kind id (so registry chrome + Settings apply). `queue-operation` is the only one with `receivedAt`; pass `message` to `MessageFrame` for all (the side-line variant ignores it, and it's harmless):

```tsx
    if (
      message.kind === 'permission-mode' ||
      message.kind === 'last-prompt' ||
      message.kind === 'ai-title' ||
      message.kind === 'queue-operation' ||
      message.kind === 'file-history-snapshot'
    ) {
      const body = (() => {
        switch (message.kind) {
          case 'permission-mode':
            return `Permission → ${message.raw.permissionMode}`;
          case 'last-prompt':
            return 'Bookmarked prompt';
          case 'ai-title':
            return `Session titled "${message.raw.aiTitle}"`;
          case 'queue-operation':
            return `Background: ${message.raw.operation}`;
          case 'file-history-snapshot':
            return message.raw.messageId
              ? `File snapshot (${message.raw.messageId})`
              : 'File snapshot';
        }
      })();
      return (
        <MessageFrame streamKind={message.kind} message={message as JsonlNode}>
          <span className="text-xs font-mono">{body}</span>
        </MessageFrame>
      );
    }
```

Note: TypeScript narrows `message.raw` per kind inside the switch because of the `JsonlNode` discriminated union. If the union's `file-history-snapshot` variant lacks `sessionId`/`receivedAt`, passing `message` to `MessageFrame` (whose `message?` prop is `JsonlNode`) still typechecks. If a cast is needed, use `message` directly (it is already a `JsonlNode`).

- [ ] **Step 5: Run green**

Run: `npx vitest run src/components/__tests__/bookkeepingKinds.test.tsx`
Expected: pass. Also run `npx vitest run src/components/__tests__/MessageCard.test.tsx` to confirm no regression.

- [ ] **Step 6: Verify the footer tolerates missing `receivedAt`**

Read `src/components/StreamMessage/MessageFrameCard.tsx` for where it renders the timestamp footer from `message.receivedAt`. These five default to `side-line` (no footer), but a user could switch one to `card` in Settings. Confirm the footer guards `receivedAt == null` (renders nothing rather than `Invalid Date`). If it does not, add a guard: only render the timestamp chip when `message?.receivedAt` is a non-empty string. If you change MessageFrameCard, add it to this task's commit.

- [ ] **Step 7: Commit**

```bash
git add src/components/StreamMessage.tsx src/components/__tests__/bookkeepingKinds.test.tsx
git commit -m "feat(rendering): render the five JSONL bookkeeping kinds (was return null)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Include `MessageFrameCard.tsx` in the add if Step 6 changed it.)

---

## Phase B — Synthetic control-change markers (effort/model, maybe permission)

### Task B1: `control-change` JsonlNode variant + registry entries

**Files:**
- Modify: `src/types/jsonl.ts`
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/messageRenderingConfig.test.ts`:

```ts
describe("control-change kinds", () => {
  it("registers control.effort and control.model under system, visible in compact", () => {
    const cfg = createDefaultConfig();
    for (const id of ["control.effort", "control.model"]) {
      expect(KIND_REGISTRY[id], id).toBeDefined();
      expect(categoryOf(id), id).toBe("system");
      expect(resolveKind(cfg, id).hiddenInCompact, id).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run red**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "control-change kinds"`
Expected: FAIL.

- [ ] **Step 3: Implement the type**

In `src/types/jsonl.ts`, add a variant to the `JsonlNode` union (after `lifecycle`):

```ts
  | { kind: 'control-change'; control: 'effort' | 'model' | 'permission'; value: string; sessionId: string; receivedAt: string };
```

(No `raw` — this node is synthesized, never parsed from JSONL. `classifyJsonlLine` will never produce it.)

- [ ] **Step 4: Implement registry entries**

In `src/lib/messageRenderingConfig.ts` `KIND_REGISTRY`, add (unified chrome — same icon/accent, distinct ids so each stays independently re-stylable):

```ts
  // ── synthetic control-change markers (live-session only) ──
  "control.effort": { id: "control.effort", category: "system", label: "Effort changed", description: "You changed the reasoning effort level.", default: { presentation: "side-line", icon: "Settings", accentColor: "info", hiddenInCompact: false } },
  "control.model": { id: "control.model", category: "system", label: "Model changed", description: "You changed the model.", default: { presentation: "side-line", icon: "Settings", accentColor: "info", hiddenInCompact: false } },
```

(`control.permission` is added in Task B3 only if B3's observation requires it.)

- [ ] **Step 5: Run green + typecheck**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts` then `npm run check`.
Expected: tests pass; typecheck clean (the new union variant may surface exhaustiveness errors in switches over `JsonlNode` — fix any by adding a `control-change` case or default. The most likely spot is `classifyStandaloneKind` and `StreamMessage`; B2 handles classify, B4 handles render. If `npm run check` fails ONLY in those two places, that's expected and resolved by B2/B4 — note it and continue. Fix any OTHER newly-surfaced exhaustiveness error here.)

- [ ] **Step 6: Commit**

```bash
git add src/types/jsonl.ts src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(rendering): control-change JsonlNode variant + control.effort/model kinds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: Classify control-change nodes

**Files:**
- Modify: `src/lib/messageKind.ts`
- Test: `src/lib/__tests__/messageKind.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("classifyStandaloneKind — control-change", () => {
  it("returns control.<control> for a synthetic control-change node", () => {
    const node = { kind: "control-change", control: "effort", value: "high", sessionId: "s", receivedAt: "t" };
    expect(classifyStandaloneKind(node as never, [])).toBe("control.effort");
    const m = { kind: "control-change", control: "model", value: "opus", sessionId: "s", receivedAt: "t" };
    expect(classifyStandaloneKind(m as never, [])).toBe("control.model");
  });
});
```

- [ ] **Step 2: Run red** → `npx vitest run src/lib/__tests__/messageKind.test.ts -t "control-change"` → FAIL.

- [ ] **Step 3: Implement** — in `classifyStandaloneKind`, add near the bookkeeping branch from A2:

```ts
  if (msg.kind === "control-change") {
    return `control.${msg.control}`;
  }
```

- [ ] **Step 4: Run green** → `npx vitest run src/lib/__tests__/messageKind.test.ts` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageKind.ts src/lib/__tests__/messageKind.test.ts
git commit -m "feat(rendering): classify synthetic control-change nodes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B3: Render control-change in StreamMessage + inject from pickers

**Files:**
- Modify: `src/components/StreamMessage.tsx`
- Modify: `src/components/AgentSession.tsx`
- Test: `src/components/__tests__/bookkeepingKinds.test.tsx` (add control-change render case)

- [ ] **Step 1: Write the failing render test**

Add to `src/components/__tests__/bookkeepingKinds.test.tsx`:

```tsx
it("renders a control-change effort node as 'Effort → high'", () => {
  const node = { kind: "control-change", control: "effort", value: "high", sessionId: "s", receivedAt: "2026-05-31T00:00:00Z" } as JsonlNode;
  renderNode(node);
  expect(screen.getByText(/Effort → high/)).toBeInTheDocument();
});
it("renders a control-change model node as 'Model → opus'", () => {
  const node = { kind: "control-change", control: "model", value: "opus", sessionId: "s", receivedAt: "2026-05-31T00:00:00Z" } as JsonlNode;
  renderNode(node);
  expect(screen.getByText(/Model → opus/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement the render branch** in `StreamMessage.tsx` (one branch for the whole family, using a label map):

```tsx
    if (message.kind === 'control-change') {
      const labels: Record<'effort' | 'model' | 'permission', string> = {
        effort: 'Effort',
        model: 'Model',
        permission: 'Permission',
      };
      return (
        <MessageFrame streamKind={`control.${message.control}`} message={message}>
          <span className="text-xs font-mono">{labels[message.control]} → {message.value}</span>
        </MessageFrame>
      );
    }
```

- [ ] **Step 4: Run green** → `npx vitest run src/components/__tests__/bookkeepingKinds.test.tsx` → pass.

- [ ] **Step 5: Inject from the pickers** in `AgentSession.tsx`. These are INLINE closures in the ControlBar JSX (see Notes), not `useCallback` handlers, and `appendMessage` is the one-arg bound function already destructured in the component body. Edit the existing `onEffortChange` closure (~line 2252) to append a marker after the IPC call resolves (append on `.then` so a failed change leaves no marker). The current closure is:

```tsx
              onEffortChange={(level) => {
                setEffort(level);
                if (persistentSessionRef.current) {
                  const tid = tabIdRef.current;
                  api.sessionSetEffort(tid, level).catch((err: unknown) => {
                    console.error('[sessions] sessionSetEffort failed:', err);
                  });
                }
              }}
```

Change it to:

```tsx
              onEffortChange={(level) => {
                setEffort(level);
                if (persistentSessionRef.current) {
                  const tid = tabIdRef.current;
                  api.sessionSetEffort(tid, level).then(() => {
                    appendMessage({
                      kind: 'control-change',
                      control: 'effort',
                      value: String(level),
                      sessionId: tid,
                      receivedAt: new Date().toISOString(),
                    });
                  }).catch((err: unknown) => {
                    console.error('[sessions] sessionSetEffort failed:', err);
                  });
                }
              }}
```

Mirror the same edit on the `onLiveModelChange` closure (~line 2263): inside the existing `api.sessionSetModel(tid, newModel)` call, add a `.then(() => appendMessage({ kind: 'control-change', control: 'model', value: String(newModel), sessionId: tid, receivedAt: new Date().toISOString() }))` before the existing `.catch`. Keep the existing `setSelectedModel(newModel)` line.

Confirm `appendMessage` is in scope at the JSX site (it is destructured near line 185). Do NOT modify the `onPermissionModeChange` closure yet — that's Step 6.

- [ ] **Step 6: Permission live-feedback decision (the one observation).**

Determine whether the CLI emits a `permission-mode` JSONL line **live** (immediately after `set_permission_mode`), which Phase A already renders. Two ways to check:
  - Preferred: launch the app (`npm start`), change the permission dropdown mid-session, and watch whether a "Permission → …" side-line row appears immediately (mechanism A) without a synthetic injection.
  - If you cannot run the app in this environment, default to the SAFE path: treat permission as NOT emitted live and inject a synthetic marker too (a duplicate on resume is avoided because the persisted line renders only on reload, and the synthetic one is live-only — but to avoid a *live* double, only inject synthetically and rely on A for resume).

  **If permission is NOT live (or you can't verify):**
  - Add a `control.permission` registry entry in `messageRenderingConfig.ts` with the same chrome as the other control markers EXCEPT keep it distinct from the persisted `permission-mode` kind: `{ presentation: "side-line", icon: "ShieldCheck", accentColor: "amber", hiddenInCompact: false }`.
  - Edit the existing `onPermissionModeChange` closure (~line 2277), adding a `.then(...)` to the `api.sessionSetPermissionMode(tid, mode)` call that appends `appendMessage({ kind: 'control-change', control: 'permission', value: String(mode), sessionId: tid, receivedAt: new Date().toISOString() })`, keeping the existing `setPermissionMode(mode)` and `.catch`.
  - **Avoid the live double:** since the persisted `permission-mode` line (mechanism A) renders on resume and the synthetic `control.permission` renders live, a session that stays open then resumes could show both. Accept this minor duplication (one is live-only, one is resume-only in practice) OR, if the CLI DOES emit live, skip the synthetic entirely. Document which path you took in the commit message.

  **If permission IS emitted live:** do nothing here — mechanism A is the permission marker. Note this in the commit message.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run src/components/__tests__/bookkeepingKinds.test.tsx` and `npm run check`.
Expected: pass + clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/StreamMessage.tsx src/components/AgentSession.tsx src/components/__tests__/bookkeepingKinds.test.tsx
git commit -m "feat(sessions): inject + render live control-change markers (effort/model[/permission])

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Include `messageRenderingConfig.ts` in the add if Step 6 added `control.permission`.)

---

## Phase C — Settings coverage + verification

### Task C1: Fixtures + coverage test

**Files:**
- Modify: `src/components/settings-panels/appearance/fixtures.ts`
- Modify: `src/lib/__tests__/messageKind.test.ts` (the `EMITTABLE_IDS` lockstep guard)

- [ ] **Step 1: Read** `src/components/settings-panels/appearance/fixtures.ts` `KIND_FIXTURES` and `src/lib/__tests__/messageKind.test.ts` `EMITTABLE_IDS`.

- [ ] **Step 2: Update the coverage test (red first)**

Extend `EMITTABLE_IDS` in `messageKind.test.ts` with the new ids: `permission-mode`, `last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot`, `control.effort`, `control.model` (and `control.permission` IFF Task B3 added it). The existing "no registry id is dead weight" test will now pass for these because A2/B2 made them classifier-reachable. Run `npx vitest run src/lib/__tests__/messageKind.test.ts` — it should pass once the list matches `KIND_REGISTRY` exactly. If "no dead weight" fails, reconcile the list with the registry (do not add unreachable ids).

- [ ] **Step 3: Add fixtures**

In `fixtures.ts` `KIND_FIXTURES`, add a sample string for each new id so the Settings live preview renders:

```ts
  "permission-mode": "Permission → acceptEdits",
  "last-prompt": "Bookmarked prompt",
  "ai-title": 'Session titled "Refactor auth"',
  "queue-operation": "Background: enqueue",
  "file-history-snapshot": "File snapshot",
  "control.effort": "Effort → high",
  "control.model": "Model → opus",
```

(Add `"control.permission": "Permission → acceptEdits"` IFF B3 added that kind.)

- [ ] **Step 4: Verify**

Run: `npx vitest run src/lib/__tests__/messageKind.test.ts src/components/settings-panels` and `npm run check`.
Expected: pass + clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/appearance/fixtures.ts src/lib/__tests__/messageKind.test.ts
git commit -m "feat(settings): fixtures + coverage for bookkeeping & control-change kinds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task C2: Full verification gate

- [ ] **Step 1:** `npm run check` → clean (ignore only `TS2688 'jest'` / `TS18003 No inputs` noise).
- [ ] **Step 2:** `npm run build` → succeeds.
- [ ] **Step 3:** `npm test` → all renderer tests pass (the `electron/__tests__` better-sqlite3 ABI failures are a known environment issue, unrelated — confirm the count of NON-electron failures is zero).
- [ ] **Step 4:** `npm run rebuild:electron` → native modules verified at Electron ABI.
- [ ] **Step 5: Commit** (only if any doc/fixup changed in this task; otherwise skip).

---

## Self-review (completed during planning)

- **Spec coverage:** Mechanism A (render bookkeeping) → A1/A2/A3; A4 footer guard → A3 Step 6. Mechanism B (synthetic markers) → B1/B2/B3; B4 permission observation → B3 Step 6. Stylability → registry entries (A1/B1) + fixtures (C1). Coverage test → C1. Verification → C2.
- **Placeholder scan:** No TBD/TODO. B3 Step 6 is a real branch with both outcomes specified, not a placeholder. Steps that depend on exact existing code (append binding, MessageFrameCard footer) instruct read-first because Bash reads during planning were partly unreliable — this is deliberate, not vagueness.
- **Type consistency:** `control-change` variant fields (`control`, `value`, `sessionId`, `receivedAt`) used identically in types (B1), classify (B2), render (B3), inject (B3), tests. Kind ids (`control.effort`/`control.model`/`control.permission`) consistent across registry, classify (`control.${control}`), fixtures, coverage list.
- **Resolved during planning (no longer soft):** `appendMessage` is the one-arg bound `useTabSession` function (B3 Step 5 uses it directly); API methods are `api.sessionSet{Effort,Model,PermissionMode}` and pickers are inline closures guarded by `persistentSessionRef.current` (B3 quotes the real closures verbatim); all six icons (`ShieldCheck`/`Bookmark`/`Tag`/`ListOrdered`/`Clock`/`Settings`) confirmed in `ALLOWED_ICONS`; `EMITTABLE_IDS` (the coverage list, `messageKind.test.ts:12`) and `KIND_FIXTURES` (`fixtures.ts:5`) anchors confirmed present.
- **Remaining soft spots:** (1) `MessageFrameCard` footer's `receivedAt` handling — A3 Step 6 verifies and guards (low risk: all new kinds default to side-line, which has no footer). (2) B4/permission live-vs-persist — resolved by observation with a documented safe default. (3) Adding the `control-change` union variant may surface `JsonlNode` switch-exhaustiveness errors beyond classify/render; B1 Step 5 says fix any that aren't classify/render there.

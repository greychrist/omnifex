# Control-change feedback + universal JSONL visibility

**Date:** 2026-05-31
**Status:** Approved (design)
**Builds on:** `2026-05-31-message-kind-registry-redesign-design.md` (the v5 id-keyed `KIND_REGISTRY` + `resolveKind` model). This feature adds new registry kinds and one new synthetic node type; it does not change the resolution model.

## Problem

Two gaps surfaced from the question "which message type fires when I change permission or effort level?":

1. **Control changes give no feedback.** Changing permission level, effort, or model is sent to the engine as an out-of-band control request (`electron/services/sessions/queries.ts` — `set_permission_mode`, `apply_flag_settings` for effort, `set_model` via `sendControlRequest`). The code comment at `queries.ts:31` states these "silently no-op … left no trace." Effort and model leave **nothing** in the JSONL. Permission changes *do* land in the JSONL as a `permission-mode` line, but the renderer drops it.

2. **Several JSONL kinds render nothing.** `StreamMessage.tsx:360-369` early-returns `null` for `last-prompt`, `permission-mode`, `ai-title`, `file-history-snapshot` (and `unknown`/`stream-event`/`rate-limit`/`lifecycle`). `queue-operation` also produces no card. The v5 redesign deliberately dropped these from `KIND_REGISTRY` as "dead weight." The user wants the opposite: **a reference to anything that ends up in the JSONL**, each one stylable in Settings so the user — not the code — decides what's noise.

## Decisions (locked with the user)

1. **Persistent transcript markers**, not ephemeral toasts. Feedback for a control change is a row in the chat feed that survives scrollback.
2. **Show everything in the JSONL as first-class, stylable registry kinds.** The user controls visibility/appearance per kind via Settings → Chats, rather than the code hardcoding what to hide.
3. **Effort/model markers are live-session only (in-memory).** OmniFex does not write into the CLI-owned JSONL file. Permission changes already persist (the CLI writes the `permission-mode` line), so permission history survives resume for free once rendered; effort/model markers do not survive resume. This asymmetry is accepted.
4. **Unified "control change" family.** Permission, effort, and model markers share one render path and one visual identity (a single `Settings`-style icon + one accent), differentiated only by their row text (`Permission → acceptEdits`, `Effort → high`, `Model → opus`). One thing to style, one render branch. (They remain *separate registry ids* so a user could still re-style one independently, but the seeded defaults are identical.)
5. **Default compact visibility:** control-change markers are visible in compact; passive bookkeeping kinds (`last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot`) are hidden in compact. All are user-overridable in Settings.

## Background (verified in code)

- `classifyJsonlLine` (`src/lib/jsonlClassifier.ts:27`) is the single ingress for both **resume** (`AgentSession.tsx:826`) and **live** lines (`AgentSession.tsx:922`), plus the Codex path (`:1359`). Rendering a JSONL kind therefore covers live and resume with no plumbing changes.
- `permission-mode` is genuine CLI output (present in `src/lib/__tests__/fixtures/jsonl-samples.ts:114` and the classifier test). Its `JsonlNode` variant carries **no `receivedAt`** — same for `last-prompt`, `ai-title`, `file-history-snapshot` (`src/types/jsonl.ts:202-205`). `queue-operation` does carry `receivedAt`.
- Compact grouping (`src/lib/compactGrouping.ts`) decides per-message visibility via `resolveWholeMessageKind` → `classifyStandaloneKind`. A kind that `classifyStandaloneKind` returns `null` for is swept into a hidden group regardless of its registry `hiddenInCompact` flag. So for the registry flag to be honored, `classifyStandaloneKind` must return an id for these kinds.

## Design

### Mechanism A — render the JSONL bookkeeping kinds

Stop dropping them; make each a first-class registry kind.

**A1. Registry entries** (in `src/lib/messageRenderingConfig.ts` `KIND_REGISTRY`). All resolve to the **system** category via `categoryOf` (their id heads aren't user/assistant/attachment). Icons are from the existing `ALLOWED_ICONS` allow-list.

| id | label | icon | presentation | accent | hiddenInCompact |
|---|---|---|---|---|---|
| `permission-mode` | Permission mode | `ShieldCheck` | `side-line` | `amber` | **false** (control marker) |
| `last-prompt` | Last-prompt bookmark | `Bookmark` | `side-line` | `muted` | true |
| `ai-title` | Session title | `Tag` | `side-line` | `muted` | true |
| `queue-operation` | Background task | `ListOrdered` | `side-line` | `info` | true |
| `file-history-snapshot` | File snapshot | `Clock` | `side-line` | `muted` | true |

**A2. Render branch** in `StreamMessage.tsx`. Remove these ids from the `return null` bookkeeping guard (`:360-369`) and render each through `MessageFrame` with `streamKind` set to the id and a one-line body:
- `permission-mode` → `Permission → {permissionMode}` (read `raw.permissionMode`)
- `last-prompt` → `Bookmarked prompt` (the prompt text is already shown as the user message; this is a pointer, so keep it terse)
- `ai-title` → `Session titled "{aiTitle}"`
- `queue-operation` → `Background: {operation}` (+ a short content preview when present)
- `file-history-snapshot` → `File snapshot` (+ messageId when present)

`stream-event`, `rate-limit`, `lifecycle`, and meta `unknown` stay dropped (they are live-overlay transport / non-JSONL artifacts, not transcript lines). `unknown` already has a registry entry and its own render path — unchanged.

**A3. Compact-grouping support.** Extend `classifyStandaloneKind` (`src/lib/messageKind.ts`) to return the matching id for `msg.kind` of `permission-mode`, `last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot`, so `compactGrouping` reads each kind's registry `hiddenInCompact` instead of sweeping them into hidden groups.

**A4. No-timestamp footer.** `MessageFrameCard`/`MessageFrameSideLine` footers must tolerate a node with no `receivedAt` (omit the timestamp chip rather than render `Invalid Date`). Verify the side-line variant simply has no footer today; if a card variant is ever chosen for these in Settings, the footer must guard `receivedAt == null`.

### Mechanism B — synthetic live markers for effort & model

Effort and model never reach the JSONL, so synthesize an in-memory node at the moment of change.

**B1. New `JsonlNode` variant** (`src/types/jsonl.ts`):
```ts
| { kind: 'control-change'; control: 'effort' | 'model' | 'permission'; value: string; sessionId: string; receivedAt: string }
```
`receivedAt` is stamped at synthesis (renderer clock) so these cards *can* show a timestamp. This variant is never produced by `classifyJsonlLine` — it is injected directly.

**B2. Registry entries** (unified family — same chrome, distinct ids so each stays independently re-stylable):

| id | label | icon | presentation | accent | hiddenInCompact |
|---|---|---|---|---|---|
| `control.effort` | Effort changed | `Settings` | `side-line` | `info` | false |
| `control.model` | Model changed | `Settings` | `side-line` | `info` | false |

Seeded defaults are identical (one icon `Settings`, one accent `info`), giving the unified look the user chose; the rows read differently only via body text. (`control.permission` registry entry is added with the same chrome only if B4 determines it's needed; otherwise the `permission-mode` kind from A is the permission marker — note that one keeps its own `ShieldCheck`/`amber` identity since it's a real JSONL kind, not part of the synthetic control family.)

**B3. Injection.** In `AgentSession.tsx`, where the ControlBar pickers' change handlers call `api.setEffort` / `api.setModel`: after the IPC call resolves successfully, build a `control-change` node (`control: 'effort'|'model'`, `value`, `sessionId`, `receivedAt = new Date().toISOString()`) and append it via the existing `ctx.appendMessage` path. On IPC failure, do not inject (the change didn't take). `StreamMessage` gets **one** branch: `message.kind === 'control-change'` → `MessageFrame` with `streamKind = control.${message.control}`, body built from a small label map (`Effort → {value}` / `Model → {value}` / `Permission → {value}`). A single render branch serves the whole family. `classifyStandaloneKind` returns `control.${control}` so compact grouping honors visibility.

**B4. Permission live-feedback — one observation decides the path.** During implementation, watch the live stream after a `set_permission_mode` control request:
- **If the CLI emits a `permission-mode` JSONL line live** → mechanism A already shows it instantly; do nothing extra. Permission's distinct identity is the `permission-mode` registry entry.
- **If it does NOT appear live** → also inject a `control-change` node with `control: 'permission'` at dropdown time (live-only), and add a `control.permission` registry entry (icon `Shield`, accent `amber`, visible in compact). The persisted `permission-mode` line still renders on resume.

To avoid a double row in the live session, permission is synthesized **only** in the not-emitted-live case. This is the single open item; it changes one conditional, not the architecture.

### Settings / stylability

Every new id is a normal `KIND_REGISTRY` entry, so it appears in the Settings → Chats tree under **System** and is fully editable (color/icon/presentation/visibility/compact-lock) with no extra UI work. Fixtures (`appearance/fixtures.ts` `KIND_FIXTURES`) gain a sample string per new id so the live preview renders.

### Coverage test

`src/lib/__tests__/messageKind.test.ts` `EMITTABLE_IDS` (the registry↔classifier lockstep guard) is extended with the new ids: `permission-mode`, `last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot`, `control.effort`, `control.model` (and `control.permission` iff B4 adds it). The "no registry id is dead weight" direction then passes because each is reachable via `classifyStandaloneKind` (A3/B3).

## Testing (TDD)

- **Classifier:** `classifyStandaloneKind` returns the correct id for each of the five bookkeeping `JsonlNode` kinds and for synthetic `control-change` nodes.
- **Registry/resolve:** each new id resolves to a complete style; `categoryOf` → `system`; control markers default `hiddenInCompact:false`, bookkeeping `true`.
- **Renderer:** `StreamMessage` renders a card for each new kind (no longer `null`); a `permission-mode` node shows `Permission → acceptEdits`; a node with no `receivedAt` renders without a timestamp and does not throw.
- **Compact grouping:** a control marker stays visible in compact; a `file-history-snapshot` collapses into a hidden group.
- **Injection:** changing effort/model appends a `control-change` node; an IPC failure appends nothing.
- **Coverage:** `EMITTABLE_IDS` ↔ `KIND_REGISTRY` lockstep holds.

## Verification gate

Cross-cutting renderer + types change (no Electron service logic beyond reading existing handlers):
- `npm run check`
- `npm run build`
- `npm test`
- `npm run rebuild:electron` (after vitest, before app restart)
- Manual smoke: change permission/effort/model in a live session and confirm markers appear; resume a session that changed permission and confirm the `permission-mode` line shows.

## Out of scope

- Writing synthetic effort/model lines into the CLI JSONL (explicitly declined — live-only).
- Rendering `stream-event` / `rate-limit` / `lifecycle` (live-overlay transport, not transcript lines).
- Changing the v5 resolution model, categories, or accent helpers.

## Files (anticipated; finalized in the plan)

**Modified**
- `src/lib/messageRenderingConfig.ts` — 5 (–7) new `KIND_REGISTRY` entries.
- `src/types/jsonl.ts` — `control-change` `JsonlNode` variant.
- `src/components/StreamMessage.tsx` — render branches for the bookkeeping kinds + `control-change`; remove them from the `return null` guard.
- `src/lib/messageKind.ts` — `classifyStandaloneKind` ids for the new kinds.
- `src/components/AgentSession.tsx` — synthesize + `appendMessage` on effort/model change.
- `src/components/settings-panels/appearance/fixtures.ts` — sample strings.
- `src/lib/__tests__/messageKind.test.ts` — extend `EMITTABLE_IDS`.

**Possibly touched (footer guard)**
- `src/components/StreamMessage/MessageFrameCard.tsx` / `MessageFrameSideLine.tsx` — tolerate missing `receivedAt`.

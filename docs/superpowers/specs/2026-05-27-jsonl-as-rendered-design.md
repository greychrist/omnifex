# Render JSONL as written; no synthesis, no mutation

**Status:** Approved (2026-05-27). Implementation plan to follow.

## Motivation

OmniFex's renderer today does two things to session data that this design removes:

1. **Synthesizes envelopes the CLI never wrote.** `src/lib/jsonlSynthesizer.ts` injects fake `synthesized-init` and `synthesized-result` nodes into the message stream so the UI has "session started" and "turn ended" affordances. The CLI does not persist `init` or `result` lines to the JSONL file in either TUI or engine mode, so without synthesis the UI was missing those affordances. The synthesizer also flushes a fake `error_during_execution` result whenever an assistant message ended without a terminal `stop_reason` — producing the misleading "Execution Failed" card investigated in the conversation that prompted this spec (78-minute duration, 0 turns, empty result body, on a session whose final assistant message simply truncated mid-stream).

2. **Mutates the raw CLI data in memory.** `src/lib/jsonlAdapter.ts` stamps `streamKind` and `receivedAt` fields onto the parsed CLI line objects (`raw.streamKind = …`, `raw.receivedAt = …`). The on-disk JSONL is untouched, but every downstream consumer sees an object that no longer matches what the CLI wrote. `receivedAt` is a rename of `r.timestamp` with a wall-clock fallback for missing values; for a real JSONL line where `timestamp` is always present, the wrapper field is byte-identical duplication.

Both behaviors were introduced by the 2026-05-24 "JSONL as source of truth" spec, which tried to unify SDK-iterator, JSONL-resume, and TUI rendering through a single pipeline. That unification is the right goal; synthesis was the wrong mechanism. JSONL is genuinely the source of truth — the CLI writes it in every mode — and the UI affordances the synthesizer was trying to deliver can be derived from JSONL content directly, without injecting fake envelopes or mutating real ones.

The result of this design: the renderer's `messages[]` contains only envelopes that the CLI actually emitted (to the JSONL file, or to engine-mode stream-json stdout). The "is this session running?" question is computed in a pure selector over `messages[]` plus the existing task/subagent stores. No fake cards, no field stamping, no FSM in the main process for conversation state.

## Goals

1. Delete `src/lib/jsonlSynthesizer.ts` and `src/lib/jsonlAdapter.ts`. Remove the `synthesized-init`, `synthesized-result`, and `real-result` variants from the `JsonlNode` union.
2. Eliminate every write to `raw.streamKind` and `raw.receivedAt` in the renderer pipeline. Where the renderer needs ergonomic access to `timestamp` or a node-kind discriminator, it reads them off the `JsonlNode` wrapper or off `raw.timestamp` directly.
3. Introduce `src/lib/sessionDerivedState.ts` with pure functions that compute `waitingOnClaude`, `conversationStatus`, `turnDuration`, `sessionStartedAt`, and related rollups from `JsonlNode[]` and the task / subagent stores. No mutation; no synthesis.
4. Move `conversationStatus` ownership from the main process to the renderer. Main process stops emitting it on `session-status:<tabId>`; the renderer derives it. `sessionStatus` stays main-process-owned (it's about the CLI process being up, which the renderer cannot derive).
5. Keep engine-mode CLI stream-json envelopes (`init`, `result`, `stream_event`, lifecycle) that don't appear in JSONL. They flow into `messages[]` with their own `kind`s. They do **not** participate in derivation; they're displayed because the CLI actually emitted them.
6. Update `docs/session-lifecycle.md` to reflect the new model: drop invariant #3 (main-process ownership of `conversationStatus`), replace the SDK-event-to-status table with a derivation-rules section pointing at `sessionDerivedState.ts`.

## Non-goals

- Changing the on-disk JSONL format or asking Anthropic to add events.
- Re-implementing TUI rendering or the embedded xterm.js.
- Detecting "stuck" sessions and showing UI banners for them. A turn with no terminal `stop_reason` keeps the spinner running until the user interrupts. No timeout heuristic.
- Re-introducing visual treatment polish for the engine-mode `init` / `result` envelopes in this spec. They land in `messages[]` with distinct kinds; the rendering decision (status bar vs thinking-icon style vs something else) is left for a follow-up.
- Migrating historical JSONL files. The CLI is the only writer; new renderer reads old files the same way it reads new ones.
- A `localStorage` flag-gated parallel pipeline. The user chose a single big-bang refactor (Approach A in brainstorming).

## User experience

After this lands, the user sees:

- **No fake completion cards.** The "Execution Complete" green card and the "Execution Failed" red card disappear. Instead, the assistant message that closes a turn (the one carrying a terminal `stop_reason`) renders with an inline completion metadata band: duration since the user's prompt, total token usage, cost estimate.
- **No fake session-start card.** The first JSONL line of a session renders as whatever kind it is (usually `queue-operation` bookkeeping or an attachment). If the user wants a visible "session started" indicator, that becomes either (a) chrome around the message list driven by `sessionStartedAt(messages)`, or (b) — out of scope here — distinct rendering of the engine-mode `cli-stream-init` envelope when one is present.
- **No misleading error on stuck sessions.** When the CLI dies mid-turn, the partial assistant message stays as-is; the spinner stays on; nothing is fabricated. The user interrupts manually.
- **Spinner behavior unchanged in steady state.** A live turn shows the spinner from the moment the user sends a prompt until the assistant message with a terminal `stop_reason` arrives. Same observable behavior as today for the normal case; just driven by derivation rather than by a fake `result` envelope.
- **Settings → Chats message types list shifts.** Synthesized kinds are removed; the catalog re-audits against real JSONL kinds.

## Architecture

### Data flow

```
                                  ┌────────────────────────────────┐
                                  │      messages: JsonlNode[]     │
                                  │      (renderer state)          │
                                  └────┬──────────────────────┬────┘
                                       │                      │
                ┌──────────────────────┴──┐                ┌──┴──────────────────────────┐
                │ classifyJsonlLine        │                │ classifyCliStreamEvent      │
                │ (pure, returns JsonlNode │                │ (pure, returns JsonlNode    │
                │  or null)                │                │  or null; engine mode only) │
                └──────────────────────┬──┘                └──┬──────────────────────────┘
                                       │                      │
                ┌──────────────────────┴──┐                ┌──┴──────────────────────────┐
                │ JSONL: tui-jsonl.ts +    │                │ Engine stream-json:         │
                │ jsonl-tail.ts forwarding │                │ runtime.ts parsing CLI      │
                │ on agent-output:<tabId>  │                │ stdout on agent-output:     │
                └──────────────────────┬──┘                └──┬──────────────────────────┘
                                       │                      │
                          ┌────────────┴──────────────────────┘
                          │
                          ▼
                  CLI binary (claude)
                  - writes JSONL to disk in both modes
                  - in engine mode, also emits stream-json on stdout

                  Derivation (selectors, pure, read-only):
                  ─────────────────────────────────────────
                    waitingOnClaude(messages) -> boolean
                    conversationStatus(messages, tasks, subagents) -> 'running' | 'idle'
                    turnDuration(messages, assistantIndex) -> number | null
                    sessionStartedAt(messages) -> string | null
```

### Components

**`src/types/jsonl.ts` (modified).** Remove the synthesized and real-result variants from the `JsonlNode` union. Add discrete kinds for engine-mode stream-json envelopes that don't appear in JSONL (e.g. `cli-stream-init`, `cli-stream-result`, plus the existing `stream-event`, `lifecycle`, `rate-limit`). Drop the `receivedAt` field from variants where it was a renamed copy of `raw.timestamp` — consumers read `node.raw.timestamp` directly. Keep `receivedAt` on engine-stream variants that legitimately need a wall-clock arrival time (e.g. `stream-event`, which has no source timestamp).

```ts
export type JsonlNode =
  | { kind: 'assistant'; raw: AssistantRaw; sessionId: string }
  | { kind: 'user'; raw: UserRaw; sessionId: string; userKind: 'prompt' | 'tool-result' }
  | { kind: 'attachment'; raw: AttachmentRaw; sessionId: string }
  | { kind: 'queue-operation'; raw: QueueOpRaw; sessionId: string }
  | { kind: 'last-prompt'; raw: LastPromptRaw; sessionId: string }
  | { kind: 'permission-mode'; raw: PermissionModeRaw; sessionId: string }
  | { kind: 'ai-title'; raw: AiTitleRaw; sessionId: string }
  | { kind: 'file-history-snapshot'; raw: FileSnapshotRaw }
  | { kind: 'system'; subtype: SystemSubtype; raw: SystemRaw; sessionId: string }
  | { kind: 'cli-stream-init'; raw: CliInitRaw; sessionId: string; receivedAt: string }
  | { kind: 'cli-stream-result'; raw: CliResultRaw; sessionId: string; receivedAt: string }
  | { kind: 'stream-event'; raw: StreamEventRaw; receivedAt: string }
  | { kind: 'rate-limit'; raw: RateLimitRaw; receivedAt: string }
  | { kind: 'lifecycle'; raw: LifecycleRaw; sessionId: string; receivedAt: string }
  | { kind: 'unknown'; raw: unknown; sessionId: string };
```

(`receivedAt` only on variants that have no `raw.timestamp` from the CLI. For everyone else, callers read `node.raw.timestamp`.)

**`src/lib/jsonlClassifier.ts` (modified).** Drop the `result` case (no `real-result`, no synth). Drop the `new Date().toISOString()` fallback for missing timestamps on file-loaded lines — if a real JSONL line is missing `timestamp`, classifier returns `null` (with a debug log) rather than masking the data bug. The wall-clock fallback is preserved only for engine-stream variants where it's the legitimate arrival time.

**`src/lib/cliStreamClassifier.ts` (new, or extend `jsonlClassifier.ts`).** Classifies engine-mode stream-json envelopes into `cli-stream-init`, `cli-stream-result`, `stream-event`, `rate-limit`, `lifecycle` nodes. Each carries `raw` verbatim and `receivedAt` set at IPC arrival.

**`src/lib/jsonlSynthesizer.ts` (deleted).** Along with `src/lib/__tests__/jsonlSynthesizer.test.ts` and `jsonlSynthesizer.skillBody.test.ts`.

**`src/lib/jsonlAdapter.ts` (deleted).** Along with its tests. The `ClaudeStreamMessage` adapter layer disappears. Renderer consumes `JsonlNode` directly.

**`src/lib/sessionDerivedState.ts` (new).** Pure functions over `JsonlNode[]` plus the task and subagent stores. No mutation, no side effects.

```ts
// True iff the conversation is "expecting more from Claude":
//   - no assistant has appeared since the most recent user prompt, OR
//   - the last assistant in the array has a null/missing stop_reason.
// Walks messages[] from the end; filters out isSidechain=true entries
// so a streaming subagent doesn't keep the main conversation 'running'.
export function waitingOnClaude(messages: JsonlNode[]): boolean;

// Canonical derived conversation status. Two values only.
// 'waiting_permission' from the old FSM collapses into 'running':
// while a permission request is open, the corresponding task/subagent
// entry keeps hasOpenTasks / hasOpenSubagents true.
export function conversationStatus(
  messages: JsonlNode[],
  tasks: TaskRow[],
  subagents: SubagentRow[],
): 'running' | 'idle';

// Duration in ms between the assistant at `assistantIndex` and the
// nearest preceding user.prompt (by raw.timestamp). Returns null if
// the assistant has no preceding prompt in the array (e.g. resumed
// session where the prompt was in an earlier batch).
export function turnDuration(messages: JsonlNode[], assistantIndex: number): number | null;

// ISO timestamp of the first message, or null if empty.
export function sessionStartedAt(messages: JsonlNode[]): string | null;
```

**`src/components/StreamMessage.tsx` (modified).** Switch on `node.kind` directly (no more `ClaudeStreamMessage.streamKind` plumbing). The assistant branch reads `node.raw.message.stop_reason`; if terminal, renders the inline completion metadata band (duration from selector, `usage` from `node.raw.message.usage`, cost computed locally). No separate completion card.

**`src/hooks/useSessionLifecycle.ts` (modified).** Subscription to `session-status:<tabId>` reads `sessionStatus` only. `conversationStatus` is obtained via a new derived hook (`useConversationStatus` or similar) that composes the messages array, task store, and subagent store and runs `conversationStatus()`. The eager `setSessionStatus('starting')` on user-initiated start is preserved (it's a renderer-side optimization for IPC latency, not an FSM bypass).

**`electron/services/sessions/lifecycle.ts`, `runtime.ts`, `events.ts` (modified).** Stop computing or emitting `conversationStatus` on `session-status:<tabId>`. Stop calling `deriveConversationStatus` in the main process. Keep emitting `sessionStatus` transitions (`starting → started → error / stopped`). The `canUseTool` path no longer flips a status field; permission requests must keep `conversationStatus` at `'running'` via the task/subagent stores (see risk #4 — verify or add the store update).

**`src/lib/messageKind.ts`, `messageRenderingConfig.ts`, `blockKind.ts` (modified).** Remove `synthesized-*` and `result.*` entries from the kind catalog. Add the new engine-stream kinds. Audit against real JSONL to surface any kinds previously missing because the catalog was organized around the synthesized abstraction.

**`src/components/settings-panels/appearance/*` (modified).** Re-audit the message-types filter list against the real `JsonlNode.kind` set. Drop dead entries. Migration of stored localStorage filter keys is best-effort: unknown keys are ignored on read, defaults apply.

**`docs/session-lifecycle.md` (rewritten).** Invariant #3 dropped. The SDK-event-to-status table replaced with a "derivation rules" section. The "the phone call" framing for `sessionStatus` stays valid and stays in the doc.

### IPC contract changes

- `session-status:<tabId>` payload becomes `{ sessionStatus: SessionStatus }`. The `conversationStatus` field is removed.
- `session_get_health` response drops `conversationStatus`. Now returns `{ alive, sessionId, sessionStatus }`.
- `agent-output:<tabId>` channel is unchanged — main process keeps forwarding parsed lines / envelopes as today. Classification moves entirely to the renderer.

## Edge cases

**Stuck turn (the 78-minute bug).** Last assistant has `stop_reason: null`, no further input. `waitingOnClaude → true`, `conversationStatus → 'running'`, spinner stays on. User interrupts via Stop button or tab close. No fake card.

**Lines missing `timestamp`.** Classifier returns `null`; debug log warns. The line never enters `messages[]`. Wall-clock fallback is reserved for engine-stream variants where it's the actual arrival time.

**Unknown JSONL line types.** Classifier returns `{ kind: 'unknown', raw }`. Renderer shows a minimal "unknown event" card (already exists in today's components). No mutation, no synthesis. New CLI versions adding line types don't break the pipeline.

**Multiple assistant entries per logical turn.** Real JSONL splits thinking and text into separate assistant lines that share `requestId` and `stop_reason` (verified in fixture `c0e34556-8703-4a95-9ee2-999180bc7cf1`). Derivation walks from the end and treats the most recent assistant as authoritative; sequential terminal-stop assistants resolve to `idle` correctly.

**Sidechains and subagent turns.** Subagent messages are marked `isSidechain: true` in JSONL. `waitingOnClaude` filters them out so a streaming subagent doesn't keep the main conversation `running`. Subagent activity is reflected through `hasOpenSubagents`, which reads the subagent store.

**Live vs resume mode.** Both go through `classifyJsonlLine` and land in `messages[]`. No live-vs-batch synthesizer split. Derivation is order-independent — fresh tail and batch load produce equivalent state.

**Engine-mode `init` / `result` envelopes.** Classified into `cli-stream-init` / `cli-stream-result`, stored in `messages[]` with `raw` intact, but ignored by `waitingOnClaude` and `conversationStatus`. TUI mode never emits these; engine mode emits them but they're display-only. Both modes agree on derivation because derivation only reads JSONL content.

**`waiting_permission` collapse.** Old FSM value gone. Design intent: while a permission request is open, the corresponding task or subagent entry stays non-`completed`, keeping `hasOpenTasks` / `hasOpenSubagents` true, keeping `conversationStatus` at `'running'`. The permission UI (banner, modal) continues to render off the same task/subagent signal. Implementation gap, if any, is covered by risk #4.

## Testing

**Unit tests:**

- `jsonlClassifier.test.ts` — drop synth assertions, drop wall-clock fallback assertion; add cases for any newly surfaced JSONL kinds.
- `cliStreamClassifier.test.ts` (new) — classify each engine-stream envelope shape; assert `raw` preservation.
- `sessionDerivedState.test.ts` (new) — table-driven over fixture `JsonlNode[]`:
  - empty → `idle`
  - user prompt only → `running`
  - assistant `stop_reason: end_turn` → `idle`
  - assistant `stop_reason: null` (78-minute fixture) → `running`
  - assistant terminal + open subagent → `running`
  - assistant terminal + open task → `running`
  - sidechain assistant streaming + main terminal → `idle`
  - multiple sequential terminal-stop assistants → `idle`
  - `turnDuration` correctness across user-prompt/assistant pairs
  - `sessionStartedAt` returns first message's `raw.timestamp` or `null`

**Component tests:**

- `StreamMessage.test.tsx` — assistant card with terminal `stop_reason` renders inline completion band; with null `stop_reason` does not. No synthesized-card fixtures.
- `MessageFrameCard.test.tsx`, `MessageFrame.test.tsx` — update fixtures that referenced synthesized kinds.

**Fixture-based end-to-end:**

- Load `c0e34556-8703-4a95-9ee2-999180bc7cf1.jsonl` from disk → classify → derive. Assert: no `synthesized-*` nodes; `conversationStatus === 'idle'` (final assistant has `end_turn`); no "Execution Failed" card in the rendered tree.
- Truncated fixture (real JSONL cut after a streaming assistant block) → assert `conversationStatus === 'running'`, spinner predicate true, no fake error card.

**Backend / IPC tests:**

- `ipc-handlers.test.ts`, `sessionEvents.test.ts` — update payload shape expectations (`session-status:<tabId>` drops `conversationStatus`, `session_get_health` drops `conversationStatus`). Add assertion that main process no longer emits derived status.

**Manual verification (in the running app):**

- Open a completed historical session → no completion card after final assistant; inline completion band visible on the closing assistant.
- Open the `c0e34556` session → no "Execution Failed" card; final partial assistant renders as normal.
- Start a fresh engine-mode session → CLI `init` envelope appears (with at-minimum a visible badge per the unfinished rendering decision); send prompt; see typewriter; assistant lands with terminal stop; spinner clears.
- Start a TUI-mode session → identical except no engine-stream envelopes and no typewriter.
- Interrupt a turn mid-stream → spinner stays running, no fake card; new turn after Stop behaves correctly.
- Settings → Chats reflects real kinds only.

**Coverage gate:** 80% lines on `sessionDerivedState.ts` and `jsonlClassifier.ts` per repo policy.

## Risks

1. **`conversationStatus` derivation drift from today's FSM.** The FSM and the derivation should produce identical sequences of `running`/`idle` for normal flows. The risk is an edge case where the FSM and the derivation disagree silently. Mitigation: fixture-based comparison test that runs the existing main-process FSM (still present until the IPC contract change lands) against the derivation on real session data; assert equivalence for all sequences. Remove after the FSM is deleted.

2. **Engine-mode `init`/`result` rendering decision deferred.** This spec lands the data plumbing but leaves the visual treatment open. Risk: those envelopes appear as raw "unknown" cards visually until the follow-up. Mitigation: classifier produces distinct kinds (`cli-stream-init`, `cli-stream-result`) so the catalog can target them; default rendering can fall back to a minimal kind-labeled card that's recognizable but unobtrusive.

3. **Catalog audit surprise.** The Settings → Chats list assumed certain kinds existed because of the synthesized abstraction. Removing synthesis may expose previously-hidden real kinds that need filter entries. Mitigation: enumerate `JsonlNode.kind` values reachable from Greg's existing JSONL files (sample at least the 126 personal ones referenced in the 2026-05-24 spec) and ensure each has a catalog entry before merge.

4. **Task / subagent store coverage for `waiting_permission`.** Collapsing `waiting_permission` into `running` works only if the permission request reliably creates a task or subagent entry whose status remains non-`completed` until resolution. Mitigation: trace today's permission flow through `electron/services/sessions/permissions.ts` and confirm the store update happens. If a gap exists, this spec includes adding that store update.

## Open questions deferred to the plan

- Whether `sessionDerivedState.ts` exposes a memoization layer (selectors recomputed only when inputs change) or relies on React's `useMemo` at consumer sites. Performance-sensitive choice; default is consumer-side memoization unless profiling shows otherwise.
- Exact rename or removal path for `messageKind.ts`'s old `result.*` and `synthesized-*` entries. localStorage migration is best-effort; a one-time read-and-translate at hook init is the simplest option.
- Whether `cliStreamClassifier.ts` lives as a separate file or extends `jsonlClassifier.ts`. Single file is simpler; two files keep the JSONL-only path strictly pure. Decide during plan writing.
- Whether the inline completion metadata band on the closing assistant is the same component on engine `cli-stream-result` envelopes (when present) or distinct. Tied to risk #2.

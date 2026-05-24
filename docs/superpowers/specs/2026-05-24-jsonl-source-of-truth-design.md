# JSONL as the single source of truth for session rendering

**Status:** Approved (2026-05-24). Implementation plan to follow.

## Motivation

OmniFex today renders sessions through two parallel data paths that don't match:

1. **SDK mode (live):** the renderer consumes the Claude Agent SDK iterator's event stream — `system/init`, `assistant`, `user`, `result`, `stream_event`, `rate_limit_event`, plus ~20 lifecycle events. The iterator synthesizes events the CLI doesn't itself emit; in particular `result` (the "Execution Complete" card) is iterator-only.

2. **Resume (history load):** `loadSessionHistory` reads the JSONL file and runs `synthesizeResultMessages` to manufacture result cards from `stop_reason`. JSONL on disk doesn't contain `result`, `stream_event`, `system/init`, `rate_limit_event`, or most lifecycle events.

3. **TUI mode (the Phase 1 addition):** the JSONL listener was wired to forward parsed lines onto the same `claude-output:` channel the SDK iterator uses, on the assumption that JSONL had the same shapes. It doesn't. Result: no init, no result cards, no in-progress tracking, broken session-id capture, broken mode-toggle gate.

The fix isn't to keep patching the TUI path — it's to make JSONL the single source of truth across all three modes. The renderer reads from JSONL via a unified pipeline; the SDK iterator becomes a thin overlay layer (Option B from brainstorming) that contributes only token partials, rate-limit events, and lifecycle UI (SubagentBar, hook progress, status badges). Resume already uses JSONL; making live use the same path collapses two pipelines into one and removes a whole class of mode-asymmetry bugs.

Inventory of Greg's 126 personal JSONL files surfaced 15 distinct on-disk node types. The SDK iterator's `SDKMessage` union has ~30 variants; the delta is what the iterator synthesizes (`result`, `system/init`, `stream_event`, `rate_limit_event`, lifecycle).

## Goals

1. One classifier — `classifyJsonlLine(raw)` — for both live tail and history load.
2. One synthesis layer that manufactures `init`, `result`, and unterminated-turn results from JSONL conversation content. Runs identically in live and batch modes.
3. The renderer's `messages` array is populated exclusively from classified+synthesized JSONL nodes. SDK iterator events that duplicate JSONL content are dropped.
4. SDK iterator stays attached in SDK mode to feed three overlay channels: token-level partials (`stream_event` → `appendInflightDelta` for typewriter), rate-limit info, and live lifecycle (task_*, hook_*, status). Overlay channels do **not** touch `messages[]`.
5. TUI mode operates with no SDK iterator. It gets the same JSONL rendering as SDK mode minus the overlays — a deliberate, accepted UX trade-off.
6. The "Hard filters" list in Settings → Chats becomes node-type aware. JSONL nodes and overlay events are visually grouped and labeled.

## Non-goals

- Replacing the CLI's TUI rendering with React (the embedded xterm.js stays).
- Changing the on-disk JSONL format or asking Anthropic to add events.
- Reimplementing the SubagentBar/hook progress UI on a JSONL basis. These features stay SDK-only and degrade gracefully in TUI mode.
- Adding new visual treatments. The cards rendered for each node `kind` are today's cards.
- Token-level streaming in TUI mode. Already accepted as a Phase 1 trade-off.
- Automatic SDK→TUI fallback on metering rejection. Manual mode switch only.

## User experience

After this lands, the user sees three things change:

- **TUI mode is functionally complete.** Completion cards appear after every turn. The mode toggle activates as soon as the session has a sessionId. Timestamps appear on every rendered card. The in-progress spinner reacts during a turn.
- **SDK mode is visually unchanged.** Typewriter streaming still works. SubagentBar, hook progress UI, status badges still update live. Rate-limit notifications still fire.
- **Settings → Chats restructures.** The four hard-filter toggles become a longer, node-keyed list grouped into "JSONL nodes" (always present) and "Live overlay (SDK mode only)" sections.

## Architecture

### Data flow

```
                                       ┌────────────────────────────────┐
                                       │      messages: JsonlNode[]     │
                                       │      (renderer state)          │
                                       └──────────────▲─────────────────┘
                                                      │
                            ┌─────────────────────────┴─────────────────┐
                            │                                           │
                ┌───────────┴─────────────┐                ┌────────────┴─────────────┐
                │ classifyJsonlLine +     │                │ classifyJsonlLine +      │
                │ jsonlSynthesizer        │                │ jsonlSynthesizer         │
                │ (live tail mode)        │                │ (batch / history load)   │
                └───────────▲─────────────┘                └────────────▲─────────────┘
                            │                                           │
                ┌───────────┴─────────────┐                ┌────────────┴─────────────┐
                │ jsonl-tail.ts           │                │ loadSessionHistory()     │
                │ filter: 'all'           │                │ (reads .jsonl on disk)   │
                └───────────▲─────────────┘                └──────────────────────────┘
                            │
                            └── JSONL file on disk (CLI writes it, both modes)


   SDK mode adds an OVERLAY (does NOT touch messages[]):

                ┌───────────────────────────────┐
                │ SDK iterator                  │
                │ (stream_event, rate_limit,    │
                │  lifecycle events only —      │
                │  assistant/user/result/init   │
                │  dropped)                     │
                └───────────────────────────────┘
                             │       │       │
                             ▼       ▼       ▼
                       partials  rate-limit  lifecycle
                       buffer    service     UI (SubagentBar,
                       (typewriter)          hook progress,
                                             status)
```

### Components

**`src/types/jsonl.ts` (new).** Discriminated-union `JsonlNode` type. One `kind` per visually meaningful category. Each variant carries `raw` (the parsed JSONL object) and a small set of extracted fields (`sessionId`, `timestamp` mapped to `receivedAt`, etc.) for ergonomic access. Synthesized variants (`synthesized-init`, `synthesized-result`) carry their computed fields directly with no `raw`.

```ts
export type JsonlNode =
  | { kind: 'assistant'; raw: AssistantRaw; sessionId: string; receivedAt: string }
  | { kind: 'user'; raw: UserRaw; sessionId: string; receivedAt: string; userKind: 'prompt' | 'tool-result' }
  | { kind: 'attachment'; raw: AttachmentRaw; sessionId: string; receivedAt: string }
  | { kind: 'queue-operation'; raw: QueueOpRaw; sessionId: string; receivedAt: string }
  | { kind: 'last-prompt'; raw: LastPromptRaw; sessionId: string }
  | { kind: 'permission-mode'; raw: PermissionModeRaw; sessionId: string }
  | { kind: 'ai-title'; raw: AiTitleRaw; sessionId: string }
  | { kind: 'file-history-snapshot'; raw: FileSnapshotRaw }
  | { kind: 'system'; subtype: SystemSubtype; raw: SystemRaw; sessionId: string; receivedAt: string }
  | { kind: 'synthesized-init'; sessionId: string; cwd: string; receivedAt: string }
  | { kind: 'synthesized-result'; sessionId: string; isError: boolean; subtype: string; body: string; durationMs: number; usage: UsageShape; totalCostUsd: number; stopReason: string | null; receivedAt: string }
  | { kind: 'stream-event'; uuid: string; deltaText: string }       // overlay only
  | { kind: 'rate-limit'; info: RateLimitInfo }                      // overlay only
  | { kind: 'lifecycle'; eventType: LifecycleKind; raw: unknown };   // overlay only

export type SystemSubtype =
  | 'stop_hook_summary' | 'local_command' | 'api_error'
  | 'turn_duration' | 'away_summary' | 'compact_boundary' | 'informational';

export type LifecycleKind =
  | 'task_started' | 'task_updated' | 'task_progress' | 'task_notification'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'status' | 'permission_denied' | 'plugin_install' | 'tool_progress'
  | 'auth_status' | 'session_state_changed' | 'notification'
  | 'files_persisted' | 'tool_use_summary' | 'memory_recall'
  | 'elicitation_complete' | 'prompt_suggestion' | 'mirror_error'
  | 'api_retry' | 'local_command_output';
```

**`src/lib/jsonlClassifier.ts` (new).** Single pure function:

```ts
export function classifyJsonlLine(raw: unknown): JsonlNode | null;
```

Returns `null` for shapes we explicitly drop (malformed lines, future unknown types). Hardens against the variability we found in real data — e.g. `permission-mode` lacks `timestamp`, `last-prompt` lacks `userType`. The classifier extracts what's there and provides safe defaults for absent fields.

**`src/lib/jsonlSynthesizer.ts` (new).** Two functions:

```ts
// Streaming: feed nodes in, get nodes (+ optional synthesized) out
export function createSynthesizer(): {
  push(node: JsonlNode): JsonlNode[];   // returns input plus any synthesized
  flush(): JsonlNode[];                 // emit synth-stop for unterminated turns
};

// Batch: equivalent over an array (replaces synthesizeResultMessages)
export function synthesizeBatch(nodes: JsonlNode[]): JsonlNode[];
```

State machine inside `createSynthesizer`:

- On first `assistant`, `user`, or `system` with a `sessionId`: emit `synthesized-init` (once per session) carrying that sessionId + cwd.
- On `user` with `userKind: 'prompt'`: record turn start timestamp.
- On `assistant` with `message.stop_reason ∈ TERMINAL_STOP_REASONS`: emit the input node, then emit a `synthesized-result` carrying duration, usage, cost, subtype (`'success'` for `end_turn`/`stop_sequence`, `'error_during_execution'` for max_tokens/refusal/model_context_window_exceeded).
- `flush()`: if there's a dangling last-assistant with no terminal stop_reason, emit a `synthesized-result` with `isError: true`, `subtype: 'error_during_execution'`. Matches today's `synthesizeResultMessages` behavior on cut sessions.

`synthesizeBatch` wraps the streaming version. The existing `synthesizeResultMessages` gets reimplemented in terms of `synthesizeBatch` so resume sessions go through the same path.

**`electron/services/sessions/tui-jsonl.ts` (modified).** Today's listener becomes the live-tail wiring. Each forwarded line gets passed through `classifyJsonlLine` on the renderer side (not in main); main keeps forwarding raw JSONL lines via `claude-output:` so the IPC contract doesn't change. The renderer-side handler converts to `JsonlNode` and pushes through the synthesizer.

Actually — we move classification to renderer-side. Main forwards raw lines on `claude-output:<tabId>` (already does for SDK mode; TUI mode joins it). The renderer's `handleStreamMessage` is replaced with a `handleJsonlLine` that calls the classifier+synthesizer.

**`src/hooks/useSessionLifecycle.ts` (modified).** The `attachStreamListeners` subscription to `claude-output:` calls the new `handleJsonlLine` instead of `handleStreamMessage`. SDK iterator events that we still want as overlay (stream_event, rate_limit_event, task_*, hook_*, status) get a discriminator check: they go through a separate handler `handleOverlayEvent` and never touch `messages[]`.

**`src/components/StreamMessage.tsx` (modified).** Today's component switches on `message.type` and `message.subtype`. Refactored to switch on `JsonlNode.kind`. The actual JSX per branch is largely preserved — we're changing the discriminator, not the rendering. The existing content-extraction helpers (`getMessageContent`, `isAssistantMessage`) operate on the `raw` field where applicable.

**`src/lib/synthesizeResults.ts` (replaced).** Becomes a thin wrapper around `synthesizeBatch` for backward compatibility with any callers, then deleted in Phase 2.3.

**`electron/services/sessions/runtime.ts` and `events.ts` (cleaned).** The SDK iterator handler in main process can stop emitting `assistant`/`user`/`system/init`/`result` on `claude-output:` since the renderer would just drop them. Instead, those SDK events are filtered out at the iterator boundary. Stream events, lifecycle events, and rate-limit events continue to flow on dedicated channels (`claude-stream` for partials, `claude-subagent` for task lifecycle — these channels already exist).

Actually, simpler: keep the SDK iterator forwarding as today, and the renderer's `handleStreamMessage` drops the duplicates. Less main-process churn, and the iterator firehose stays observable in debug tools. Picking the latter.

**`src/components/settings-panels/AppearanceSettings.tsx` (modified).** Two filter groups:

```
JSONL nodes
  ☐ Drop bookkeeping (last-prompt, permission-mode, ai-title, file-history-snapshot)
  ☐ Drop hook summaries (system/stop_hook_summary)
  ☐ Drop empty/tool-only user messages
  ☐ Drop closure carriers (queue-operation, queued_command attachments)
  ☐ Drop system informational (system/away_summary, system/local_command, system/informational)

Live overlay (SDK mode only)
  ☐ Hide partial token streaming
  ☐ Hide subagent task lifecycle
  ☐ Hide hook lifecycle
  ☐ Hide rate-limit notices
```

Settings keys map 1:1 to filterable `JsonlNode.kind`s. Existing keys (`dropMeta`, `dropTaskLifecycle`, `dropEmptyUser`, `dropHookLifecycle`) migrate on first read to the new shape:
- `dropMeta` → `dropBookkeeping`
- `dropTaskLifecycle` → `hideSubagentLifecycle`
- `dropEmptyUser` → `dropEmptyUser` (unchanged)
- `dropHookLifecycle` → `hideHookLifecycle`

## Migration sequencing

Incremental, flag-gated:

1. **Phase 2.1.a** — Land `src/types/jsonl.ts`, `src/lib/jsonlClassifier.ts`, `src/lib/jsonlSynthesizer.ts`. Unit-tested in isolation. No renderer changes.
2. **Phase 2.1.b** — Add the new ingestion path alongside the existing one, gated by `localStorage` flag `omnifex:jsonl-pipeline` (default off). Greg flips it on in his dev session for validation.
3. **Phase 2.1.c** — After a session or two without regressions, switch the default to on.
4. **Phase 2.1.d** — Remove the old `handleStreamMessage` SDK-message path. `reduceSessionStreamMessage` retires.
5. **Phase 2.2** — Settings UI restructure once the JSONL pipeline is the only path.
6. **Phase 2.3** — Cleanup: delete `synthesizeResults.ts` (folded into the synthesizer), delete dead reducer code, memory updates.

The flag gives a clean A/B comparison on real sessions before commitment. Big-bang would ship faster but blind.

## Testing

- **Classifier**: golden-file tests with samples from Greg's 126 real JSONL files. Each `JsonlNode.kind` gets a representative input. Lines that don't classify (returning `null`) are documented separately.
- **Synthesizer**: unit tests for `synth-init` (first node with sessionId), `synth-result` for each terminal stop_reason, `synth-stop` for unterminated turn.
- **End-to-end (renderer)**: fixture session JSONL → classifier → synthesizer → render. Result: same set of message cards as today's `loadSessionHistory + synthesizeResultMessages` produces. Run as a snapshot test.
- **Backward compatibility**: existing `loadSessionHistory` tests pass without modification because the wrapped synthesizer produces equivalent output.
- **Manual**: with `omnifex:jsonl-pipeline` flag on, both SDK and TUI mode sessions render correctly. Mode toggle responds. Notifications fire. Status badges flip.

Coverage target: 80% lines on new files. The classifier and synthesizer are pure functions and trivially testable.

## Risks

1. **Card visual regressions.** Today's `StreamMessage` switches on `type`/`subtype`. Refactoring to switch on `JsonlNode.kind` keeps the JSX but changes the discriminator. Risk: a specific card type renders differently because the new classifier categorizes its input slightly differently. Mitigation: snapshot test against today's rendering on Greg's sessions before switching the default.

2. **SDK iterator events we silently drop.** The renderer ignores `assistant`/`user`/`system/init`/`result` from the iterator. If we miss a case where the iterator emits something JSONL doesn't have (e.g. SDK adds a new synthetic event variant), we'd silently drop content. Mitigation: log unrecognized iterator types at debug level; review periodically.

3. **Synthesizer drift from real JSONL.** Greg's 126 files cover his usage patterns but not all of Anthropic's CLI features (Windows, plugins, agents). Mitigation: the classifier returns `null` for unknown shapes (safe drop), not `throw`; we add to the type union over time.

4. **Phase 2.1.b flag complexity.** Running two pipelines in parallel during validation means twice the IPC traffic and two paths to `messages[]`. Mitigation: the flag is renderer-side only; main process is unchanged. Pipelines don't share state.

## Open questions deferred to the plan

- Exact migration strategy for `localStorage`-stored filter keys (in-place rewrite vs. read-and-translate-on-fly).
- Whether the streaming synthesizer's `flush()` should be invoked on tab close, session interrupt, or both.
- How to handle `system/compact_boundary` — it appears in both JSONL and the SDK iterator with subtly different shapes. Probably trust the JSONL version since the iterator's is derived.

These are mechanics resolved during plan writing.

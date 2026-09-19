# Session Context Ledger

**Status:** implemented 2026-09-18. 6,066 tests pass; `check` and `build` clean.
**Scope:** renderer-only. No IPC channel, no service, no schema change.

## The question this answers

"What shaped this session, and when did it arrive?" — with a second reading of
the same list: "and which of those is still in effect right now?"

Today OmniFex answers neither. `ClaudeMemoriesDropdown` and `ClaudeFileEditor`
exist in the tree but are mounted nowhere — only self-references — so there is
no way in the app to see the instruction files governing a session. This is a
net-new surface, not a replacement for a working one.

## Why the data is trustworthy

The CLI emits what it actually loaded, as `attachment` records. This is ground
truth, not a disk walk that guesses at what the CLI probably read. The
distinction is the whole reason for the design: `findClaudeMdFiles`
(`electron/services/claude.ts:1070`) walks the project for files literally
named `CLAUDE.md`, which silently misses `CLAUDE.local.md` (always loaded by
the CLI) and `AGENTS.md` (loaded as of 2.1.277, behind a gate), and can
disagree with what the session actually has in context.

Reading the ledger off the attachment stream makes both of those correct for
free: when the CLI loads a file, it says so, whatever the file is named.

Shapes verified against real transcripts in both config dirs:

```jsonc
{"type":"instructions","files":[{"path":"…/CLAUDE.md","type":"User","content":"…"}]}
{"type":"nested_memory","path":"…/src/CLAUDE.md","content":{"path":"…","type":"Project","content":"…"}}
{"type":"mcp_instructions_delta","addedNames":[…],"addedBlocks":[…],"removedNames":[…]}
{"type":"agent_listing_delta","addedTypes":[…],"removedTypes":[…],"addedLines":[…]}
{"type":"deferred_tools_delta","addedNames":[…],"removedNames":[…],"readdedNames":[…]}
{"type":"skill_listing","content":"- skill-name: description…"}
```

Scopes are `User | Project | Local | Managed` — **plus `AutoMem`**, the
auto-memory `MEMORY.md`, which appears 93 times on disk and is absent from the
CLI's own four-value scope validator. A closed allow-list of the first four was
written and then dropped `AutoMem` the moment it met real transcripts, so the
scope is passed through as an open string. The UI styles what it recognises;
dropping an unfamiliar scope loses information, showing it costs nothing.

### Coverage, and its one cliff

338 of 339 session files since 2026-09-09 carry an `instructions` attachment.
Across all history it is 339 of 976, because the CLI only began emitting it
around **2026-09-08**. The gap is entirely historical.

This is a product requirement, not a caveat: a session older than that gets an
explicit "this session predates instruction tracking" empty state, never an
empty list. An empty list would read as "nothing influenced this session",
which is false.

## Data model

One pure function, `src/lib/contextLedger.ts`:

```ts
foldContextLedger(records: JsonlNode[]): ContextLedger
```

```ts
export type ContextEntryKind =
  | 'instruction-file' | 'nested-memory' | 'mcp-server'
  | 'agent' | 'skills' | 'deferred-tool';

export interface LedgerEntry {
  id: string;            // stable identity: `${kind}:${label}`
  kind: ContextEntryKind;
  label: string;         // path, server name, agent name
  scope?: ContextScope;  // open string — see the scope note above
  content?: string;      // present for the types that carry it
  at: string;            // arrival timestamp, from the record
  live: boolean;         // still in effect at the end of the fold
  endedAt?: string;      // when it stopped being live
}

export interface ContextLedger {
  entries: LedgerEntry[];   // arrival order
  liveCount: number;
  tracked: boolean;         // false when the session predates the feature
}
```

`entries` is the audit. `live` is the overlay. One array, read two ways — not
two views to keep in sync.

### Three fold rules

Each matches an emission semantic the CLI actually uses. They are not
interchangeable and picking the wrong one produces a plausible-looking wrong
answer, which is why they are enumerated rather than generalised.

| Rule | Types | Behaviour |
|---|---|---|
| **Snapshot** | `instructions`, `skill_listing` | A later record supersedes the earlier. Superseded entries stay in the timeline with `live: false` and an `endedAt`. |
| **Delta** | `mcp_instructions_delta`, `agent_listing_delta`, `deferred_tools_delta` | Apply `added*` / `removed*` / `readdedNames`. Each add and each remove is its own timeline event. |
| **Additive** | `nested_memory` | Append; stays live. The CLI's `loadedNestedMemoryPaths` guarantees it is not re-loaded, so a second record for the same path is a no-op. |

`readdedNames` is why liveness is a fold and not a set-difference: a name can
go out and come back, and the timeline must show both transitions.

### Purity

No `Date.now()`, no IO, no module state. Timestamps come from the records.
Folding the same records twice yields a deep-equal ledger — the property tested
hardest, the same way `merge.ts` is.

## Noise control

In scope are the six kinds above. Explicitly **out**, because they are
per-turn bookkeeping rather than things that shape the session:

`total_tokens_reminder` (20,969 occurrences on disk), `task_reminder`,
`batching_reminder_sent`, `prompt_snapshot`, `date`, `date_change`,
`environment`, `model`, `session_context`, `command_permissions`,
`queued_command`, `auto_mode`, `edited_text_file`, `file`, `hook_success`,
`remote_session_change`, `compact_file_reference`, `deferred_tools_record`.

`hook_additional_context` is deliberately **out of v1** despite being a real
context injection: it carries the injected text but no stable identity to key
an entry on, so it cannot express liveness honestly. Revisit with a real
identity, not a synthesised one.

## UI

### Panel

`src/components/ContextLedgerPanel.tsx`, opened from an affordance in the
session header assembly. Grouped by kind; each row shows label, scope badge,
arrival time, and live / superseded state. Selecting a row reveals its content
read-only.

Read-only is a decision, not an omission. "Review" was the ask, and read-only
keeps this clear of the editing question entirely — which is why
`ClaudeFileEditor` is deleted rather than revived.

### Inline marker

`StreamMessage.tsx` returned `null` for every attachment; the in-scope kinds
now render there as a `side-line`, consistent with the existing bookkeeping
vocabulary (`permission-mode`, `queue-operation`, …).

The marker's text comes from `summariseContextAttachment`, a tested pure
function, rather than inline in that 1,700-line component. It reports counts,
never content: a transcript row inlining a 27,000-character CLAUDE.md would
bury the conversation. It returns null for every out-of-scope subtype, which
is the overwhelming majority of the channel.

Registry ids follow the established `attachment.<subtype>` convention from
`messageKind.ts:184`, with entries added to `KIND_REGISTRY`. `resolveKind`
already falls back gracefully, so each kind becomes independently restylable
like every other one.

### Performance

The fold is memoised on `messages` in `AgentSession`, never run per message
render. This repo's standing failure mode is "one click re-rendered every
session in the app", and a fold over every message is exactly that shape.

It is the same `useMemo(… , [messages])` shape as the four folds already
beside it (`notificationStats`, `taskEntries`, `mcpServerErrors`,
`usageLimitWait`), so it adds a pass of the same order rather than a new kind
of cost — and its first check rejects non-attachments, which is nearly every
message. Still unmeasured in a running app: confirm with
`__omnifexProfile.on()` in a packaged build before calling it settled.

## Removals

Deleting the dead components makes `findClaudeMdFiles` unreachable, so it goes
in the same change rather than as a follow-up:

- `src/components/ClaudeMemoriesDropdown.tsx`
- `src/components/ClaudeFileEditor.tsx`
- `findClaudeMdFiles` — the service function, its interface member, the
  `find_claude_md_files` IPC channel, the handler, and the `api.ts` wrapper.

`readClaudeMdFile` / `saveClaudeMdFile` **stay**: `ProjectSettings.tsx` uses
them for `.gitignore` editing, which is unrelated to this feature.

`ClaudeMdFile` goes too, from both `claude.ts` and `api.ts` — nothing else
referenced it.

The `claude-file` tab type is deliberately **kept**. It looks like adjacent
dead code, but it has its own creation path (`useTabState.ts:198`) and
persistence + restore handling (`tabPersistence.ts:175`), so this change does
not make it unreachable and a user could have one saved. Removing it is a
separate decision about the tab system.

`ipc-channel-contract.test.ts` pins the channel list in both directions, so
removing the channel without removing the handler (or the reverse) fails the
suite — the removal is self-checking. Three other guardrails also fired and
were satisfied rather than suppressed: the required-channel list in
`ipc-handlers.test.ts`, `messageKind.test.ts`'s "no registry id is dead
weight" check (the six new ids are genuinely emittable, so its stale
"`attachment.*` is always dynamic" comment was corrected), and
`appearanceFixtures.test.ts`, which requires preview text for every registry
kind.

One registry icon differs from the panel's: `deferred-tool` uses `Package` in
`KIND_REGISTRY` because `Wrench` is not in `ALLOWED_ICONS`, the list bounding
what a user can restyle a kind to. The panel imports `Wrench` from lucide
directly, which that list does not constrain.

## Testing

- `src/lib/__tests__/contextLedger.test.ts` — the fold, against fixtures taken
  from real transcript records: each rule in isolation, the re-add path, the
  supersede path, idempotency, and the untracked-session case.
- Channel-contract test covers the IPC removal.
- `npm run check`, `npm test`, `npm run build` — cross-cutting change, so all
  three.

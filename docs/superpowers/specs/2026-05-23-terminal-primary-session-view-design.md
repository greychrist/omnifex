# Terminal-primary session view (Phase 1)

**Status:** Approved (2026-05-23). Implementation plan to follow.

## Motivation

Anthropic is introducing a monthly credit cap on programmatic Claude Code access (including the SDK's `query()` and the CLI's `-p` / stream-json modes) starting in roughly three weeks (June 2026). Greg's expected usage exhausts the credit in ~2 weeks of normal work. After that, OmniFex needs to keep functioning without programmatic API usage.

The Claude Code CLI's interactive TUI (PTY, no programmatic flags) is the only known surface that isn't billed against that credit. OmniFex already has a partial TUI mode — an opt-in fallback you can toggle into — built on `node-pty`, xterm.js, and a mode switch in `electron/services/sessions/lifecycle.ts`. We're going to promote that path from "fallback toggle" to "first-class session mode," and surround it with enough OmniFex-native chrome that the user experience stays familiar.

Greg has confirmed:
- Manual mode toggle is fine; no auto-fallback on metering rejection
- Terminal view is primary; the rich formatted panel is the add-on
- Permissions prompts, slash commands, and any other interactive CLI state stay inside the terminal (the user reads and responds in the terminal directly)
- Build it, see how it feels, iterate

## Goal

Make TUI mode usable as the primary session view by Phase 1's end:
1. Open a new session directly in TUI mode without first instantiating the SDK
2. Display a 50/50 layout: xterm.js (primary, interactive) + rich `MessagePanel` (rendered from JSONL)
3. Fire the existing OS notification + dock badge on turn completion, driven from JSONL
4. Theme the terminal to match OmniFex visually

## Non-goals (deferred)

- ANSI screen-scraping of stdout
- Replacing terminal rendering with React components (Flavor 4 from brainstorming)
- Synchronized scrolling between terminal and panel
- Gutter / decoration markers tying terminal lines to message kinds (Flavor 2)
- Auto-fallback from SDK to TUI mode when metering rejection lands
- Mid-session structured permission UI in TUI mode (permissions stay in the terminal)
- Programmatic input adapter (paste mode, multi-line, attachments — user types directly into the terminal)

## User experience

- A new session can start in either SDK mode (default) or TUI mode (chosen explicitly).
- In SDK mode, today's UI is unchanged.
- In TUI mode, `ClaudeCodeSession` renders a 50/50 horizontal split:
  - Left: `TerminalView` (existing component, themed)
  - Right: new `MessagePanel` showing message cards parsed from the session JSONL
- The user types into the terminal. Permission prompts, slash commands, and any TUI interactions happen in the terminal.
- The panel updates as the CLI writes to JSONL. Messages render as simple cards: user prompt, assistant text, tool use (name + input + output collapsed by default), errors.
- OS notification fires when the JSONL stream sees a `result` line, identical body/title formatting to today's SDK-driven notifications.
- The existing manual mode toggle (`setMode('tui'|'sdk')`) continues to work for switching an active session.

## Architecture changes

### Backend (`electron/services/sessions/`)

1. **Cold-start TUI path.** New entry point (likely `lifecycle.ts`'s `start()` accepting a `mode: SessionMode` param, or a sibling `startTui()`):
   - Spawn `claude` in a PTY with no `--resume` flag
   - Tail JSONL for the project, watch for the first new `<uuid>.jsonl` file appearing in the configDir's `projects/<encoded-path>/` directory, OR scan the existing JSONLs for `system:init` lines newer than session start
   - Assign the sessionId from that init line to the handle
   - Emit `session-mode:<tabId>` with `{ mode: 'tui' }` so the renderer renders the TUI layout immediately

2. **JSONL tail — all-messages mode.** `createJsonlTail` today filters to `isClosureCarrier` only. Extend it:
   - Add a `filter` option: `'closure-carriers'` (default, today's behavior) or `'all'` (forward every parsed line)
   - In TUI mode the runtime starts the tail with `filter: 'all'` and the renderer subscribes to a dedicated channel (e.g. `session-jsonl:<tabId>`) for panel rendering
   - The existing `claude-output-extra:<tabId>` channel keeps working for SDK-mode closure carriers

3. **Notification helper extraction.** Pull the `result`-handler block from `runtime.ts:155-180` (which builds title, fires `claude-notification`, calls `notificationHooks.showNotification`, `incrementUnread`) into a helper exported from `events.ts` or a new `notifications.ts`. Call it from:
   - `runtime.ts` (SDK iterator) — today's call site
   - The new JSONL-tail handler in TUI mode — for each parsed `result` line

4. **Session handle in TUI-only mode.** The handle still exists in `sessions` map but `handle.query` and `handle.inputChannel` will be no-ops in cold-start TUI. Either:
   - Make those fields nullable (cleaner long-term, more churn now), OR
   - Initialize them as closed/dead placeholders (less invasive)

   We'll pick the less invasive path for Phase 1 and revisit if the type pollution gets ugly.

### Renderer (`src/`)

1. **`ClaudeCodeSession.tsx` layout switch.** Read `session-mode:<tabId>` events; when mode is `'tui'`, render `<TuiSessionLayout tabId={...} />` instead of today's view. SDK mode keeps today's view.

2. **`TuiSessionLayout`** — new component with two children, 50/50 horizontal split (resizable later, fixed for Phase 1):
   - `<TerminalView tabId={...} />` (existing)
   - `<MessagePanel tabId={...} />` (new)

3. **`MessagePanel`** — new component. Subscribes to `session-jsonl:<tabId>`. Maintains a local list of parsed message records. Renders simple cards keyed by message type:
   - `user` — markdown of text content
   - `assistant` — markdown of text content
   - `tool_use` — collapsed card showing tool name, click to expand input
   - `tool_result` — collapsed card with output, attached to the matching tool_use card
   - `system:init`, `result`, etc. — small status pills (not full cards)

   Reuses existing markdown rendering from the SDK-mode message components where possible. No streaming token-level rendering — messages appear when JSONL flushes.

4. **`TerminalView` theme update.** Adopt OmniFex's palette (read from CSS vars or theme context), match the app's monospace font ramp, transparent background. Load `@xterm/addon-web-links` for clickable URLs.

5. **API surface.** New `api.startTui(...)` wrapper (or an extension of the existing `api.start`) and a typed listener for `session-jsonl:<tabId>`. Both go through `src/lib/api.ts` and the preload allow-list.

### Preload (`electron/preload.ts`)

- Add `session-jsonl:` to the event-channel allow-list prefix.
- Add any new invoke channel (`start-tui`, etc.) to the invoke allow-list.

## Data flow (TUI mode)

```
User types in xterm.js
    │
    ▼
api.tuiWrite(tabId, data)  ──▶  PTY stdin
                                    │
                                    ▼
                            claude CLI (interactive)
                            │              │
                            ▼              ▼
                        PTY stdout    JSONL file (~/.claude/projects/.../<sid>.jsonl)
                            │              │
                            ▼              ▼
                  session-tui-data:N   jsonl-tail (filter: 'all')
                            │              │
                            ▼              ▼
                       TerminalView    session-jsonl:N
                                           │
                                           ├──▶ MessagePanel (renders cards)
                                           └──▶ notificationDispatcher (on result)
                                                       │
                                                       ▼
                                              showNotification / dock badge
```

## Testing

Following the repo's TDD rule:

- **Cold-start TUI** — unit test in `electron/__tests__/sessions-tui-coldstart.test.ts` (new): given a temp configDir and a fake `claude` binary, verify a PTY is spawned, sessionId is resolved from the first JSONL `system:init` line, `session-mode` event is emitted.
- **JSONL tail — all-mode** — extend `electron/__tests__/jsonl-tail.test.ts`: append a sequence of mixed line types, verify all are forwarded when `filter: 'all'`, only carriers when `filter: 'closure-carriers'`.
- **Notification helper** — unit test the extracted helper: given a `result`-shaped object, verifies title/body and that the supplied hooks are invoked.
- **Mode switch** — extend `electron/__tests__/tui.test.ts`: starting in TUI mode (not switching into it from SDK) works, sessionId is captured.
- **Renderer** — minimal smoke test for `MessagePanel` parsing JSONL records into card definitions.

Coverage target: 80% lines on the new backend code.

Manual verification:
1. Start TUI session, type a prompt in the terminal
2. Confirm message card appears in `MessagePanel` after CLI flushes JSONL
3. Confirm OS notification fires on turn completion
4. Test permission prompt: visible in terminal, type "y", see tool execute
5. Test mode toggle: switch SDK → TUI mid-session, confirm UI swaps to 50/50 view

## Risks

1. **The load-bearing assumption.** "PTY-spawned interactive CLI doesn't burn programmatic credit." Worth testing on a throwaway account immediately when metering goes live. If wrong, this entire spec is moot and we need to escalate.
2. **JSONL flush latency.** Messages appear in chunks, not character-by-character. May feel sluggish vs. SDK mode. Mitigation: it's a known and accepted tradeoff per Greg.
3. **Permission prompts in terminal.** Today the rich permissions modal is a major OmniFex feature. In TUI mode users will type "y"/"n" into the terminal. May feel like a UX regression. Mitigation: 50/50 view keeps terminal visible; iterate on this in a later phase.
4. **Cold-start sessionId resolution.** Racing JSONL file creation vs. our tail. Mitigation: poll-until-exists pattern (the tail already does this for the ENOENT case).

## Open questions for the plan

- Should `MessagePanel` show only messages from the current session, or also pre-existing history loaded from JSONL on session resume?
- Where exactly to put the notification-dispatch helper (`events.ts`, new `notifications.ts`, or part of the runtime module)?
- Whether `start()` takes a `mode` param or there's a sibling `startTui()` — TBD during plan writing.

These are resolved in the implementation plan, not here.

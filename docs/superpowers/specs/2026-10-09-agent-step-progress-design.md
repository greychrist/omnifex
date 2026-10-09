# Agent step progress — design

Date: 2026-10-09. Status: approved for build (Greg delegated the design
decisions: "figure it out without me, and build it").

## Why

The agents popover (v0.4.231) shows each agent's state, time, context and
cost, but not how far through its work it is. Nothing in the CLI reports
that: the task tools are switched off on current models and were never
offered to subagents (see `project_todo_tools_gate_2_1_294`). The
savvy-progress mod gets real `4/6` bars only because the model calls a tool
of the mod's.

The 2026-10-09 spike (`omnifex-probe`, CLI 2.1.295) proved the same works
for OmniFex:

- One mod in the parent CLI sees every subagent's events; subagents are
  loops in the same process, tagged `agentId`.
- `agent.spawn` can append an instruction to every subagent's prompt, and a
  tool registered with `$.tool.register({ isDeferred: false })` is offered
  to subagents. All three test agents (Haiku/Sonnet, general-purpose and
  Explore) called it with sensible `done/total/note`.
- The calls need no channel back to the app: they arrive as tool_use blocks
  in the forwarded subagent frames, keyed by `parent_tool_use_id`, and in
  the main stream for the main session.

## What ships

1. **A bundled mod, `omnifex`**, in `omnifex-mod/` at the repo root.
   - Registers `progress` → `mcp__omnifex__progress({ done, total, note? })`,
     up front (`isDeferred: false`). Its answer is a fixed
     `Progress recorded.`; nothing runs.
   - `tool.check` on that tool answers `allow`, so it never raises a
     permission prompt in any mode.
   - `agent.spawn` appends a two-sentence instruction to every subagent's
     prompt.
   - `prompt.compose` appends one `session`-scoped section to the main
     session's system prompt, only when the tool is offered: report progress
     for requests with three or more distinct steps, skip it for quick
     answers.
   - Every hook passes its event on; a failing hook falls through to the
     engine's own behaviour. Tested with `claude plugin test omnifex-mod`.

2. **Launch wiring.** Every interactive Claude session is spawned with
   `--plugin-dir <installed mod>`.
   - The CLI writes `.claude-plugin/types/` and a `tsconfig.json` into any
     mod directory it loads, so the directory must be writable and must not
     be the signed app bundle or the repo checkout. The app installs a copy
     to `<stateDir>/mod/omnifex/` (`~/.omnifex`, or `~/.omnifex-dev` for a
     dev instance; `defaultStateDir()`), rewriting a file only when its
     content differs, via temp file + rename (main and the daemon may both
     install).
   - Source: `omnifex-mod/` beside `dist-web/` — `<repo>/omnifex-mod` in
     dev, `Contents/Resources/omnifex-mod` packaged (`extraResource`),
     resolved from the bundle dir exactly as `webroot.ts` resolves
     `dist-web`. Works in the daemon (no `electron` import).
   - Setting `sessions.progressMod.enabled`, on unless `'false'`, read at
     each spawn. Settings → the same panel as Recap idle sessions gets a
     switch: "Agent step progress". Applies to sessions started after the
     change.
   - Behaviour lives in one shared module, `electron/services/bundled-mod.ts`;
     main.ts and daemon.ts each pass the same one-line closure as a new
     `createSessionsService` parameter, `pluginDirs: () => string[]`.
     The sessions layer threads it into `AgentStartParams.pluginDirs` and
     `handle.startParams`, so a stream-death restart keeps the mod.
   - Any failure (no source, unwritable state dir) returns `[]`: the session
     starts without the mod. Never blocks a spawn.
   - Probe sessions (`models.ts`, `commands-catalog.ts`) do not get it.

3. **Renderer: per-agent step bars.**
   - `src/lib/stepProgress.ts` (pure):
     - `parseProgressInput(input)` → `{ done, total, note? } | null` (finite
       numbers, `total > 0`; `done` clamped to `[0, total]`).
     - `latestSubagentProgress(messages)` → `Map<toolUseId, StepProgress>`
       from forwarded assistant frames' `mcp__omnifex__progress` tool_use
       blocks, keyed by `parent_tool_use_id`, last call wins.
     - `latestMainProgress(messages)` → the main session's last call since
       the last real prompt (`userKind === 'prompt'`), or null.
   - `Subagent` gains `stepProgress?: StepProgress`, set in `AgentSession`
     alongside the other live merges (`applySubagentMeta` stays as is).
   - `SubagentRow`: while running with progress, the bar is determinate —
     width `done/total` in the agent's colour — and a step line reads
     `4/6 · Read session-cost.ts`. Without progress it keeps the
     indeterminate sweep. Done/failed/abandoned bars are unchanged.

4. **Renderer: main-session progress.**
   - The turn readout in `ChatStatusBar` appends `· 2/5` while a turn runs
     and the main session has reported; the title attribute carries the
     note.
   - A main-session `mcp__omnifex__progress` call renders as a compact
     one-line `ProgressWidget` ("Progress 2/5 — note"), not the generic MCP
     JSON card.

## Decided against

- **Reading progress back from `agent-<id>.jsonl` on reload.** Forwarded
  frames are not persisted, so a reloaded *running* agent shows the sweep
  until its next call. Completed agents show a full green bar either way, so
  the reload path buys almost nothing. Revisit if running agents across a
  reload turn out to matter.
- **`$.ui.status` as the transport.** One line per mod, each replacing the
  last: it cannot hold several agents.
- **An HTTP or WebSocket route from mod to daemon.** Unnecessary: the tool
  call is already in the stream.
- **Reviving `extraSpawnArgs`** (see "Found along the way").

## Risks

- **Models may not call it.** Opus on the main session is untested; the
  instruction is deliberately conservative. No call means today's UI.
- **Totals are estimates** and can move (3/4 → 3/7). The bar shows the
  latest; no smoothing.
- **Work account:** an org with `allowManagedModsOnly` stops the mod; the
  session runs as today.
- **CLI churn:** mods are early access. The mod uses five events and one
  `$` call; `claude plugin test` and `validate` catch drift.
- **Cost:** one small tool call per reported step.

## Found along the way (not fixed here)

`createSessionsService`'s `extraSpawnArgs` parameter — the Brain's
spawn-time `--mcp-config` injection, wired in both main.ts and daemon.ts —
has not been read since the TUI removal (df48e7fa). The Brain still works
through the persistent `.claude.json` registration. Reviving it risks two
`omnifex-brain` registrations per session, so it is left for a deliberate
decision.

## Testing

- `claude plugin test omnifex-mod` (6 tests) and `claude plugin validate`.
- `electron/__tests__/bundled-mod.test.ts`: source resolution (dev and
  packaged layouts), install (fresh, unchanged, changed), setting off,
  failure → `[]`.
- `claude-cli-engine.test.ts`: `--plugin-dir` per entry.
- Sessions test: `pluginDirs` reaches `engine.start` and the restart.
- `src/lib/__tests__/stepProgress.test.ts`, `BackgroundWorkRows.test.tsx`
  (determinate bar + step line), `ChatStatusBar.test.tsx`,
  `StreamMessage` widget routing.
- Manual (Greg, morning): start a fresh session in the packaged app, ask
  for 2–3 multi-step background agents, watch the bars fill.

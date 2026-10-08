# Subagent run stats — design

2026-10-08. Inspired by the `savvy-progress` mod
(github.com/JohnnyVizz/claude-kit, `plugins/savvy-progress`), which shows a
progress bar plus a panel of subagents with model, context, cost and time.

## Goal

In the status bar's `agents` popover, each subagent row shows how long it has
run and what its tokens cost, live, line by line, plus an "X/Y done" count of
agents. No change to what the model is asked to do.

## Decisions

- **Progress counts agents, not tasks.** The mod's "Tasks 2/4" comes from two
  MCP tools (`progress`, `step`) its companion skill tells the model to call.
  The CLI's own task tools are gated off on current models (2.1.294: only an
  env var or naming them in the launch tool list opts in; the remote flag is
  gone). Both cost model tokens and depend on compliance. Agents finished /
  dispatched is known for free. Step progress inside an agent is out of scope.
- **Stats come from the cost watcher, not forwarded frames.**
  `session-cost.ts` already re-reads every subagent transcript (any depth, so
  workflow agents too) within a second of a change, deduped by request and
  priced by `computeMessageCost` — the same path the Cost Report uses. It
  summed them into one `subagentUsd`; it now also keeps them per file. The
  forwarded `--forward-subagent-text` frames were the other candidate: live,
  but gone on reload, and they would need their own dedup.
- **Rows join files by agent id.** `agent-<id>.jsonl`'s `<id>` is the agent
  id, which is the row's `taskId` for Agent tasks (subagentEvents.ts already
  relies on this). After a reload a foreground row may lack `taskId`; the
  disk meta's `agentId` fills it in `applySubagentMeta`.
- **The watcher runs for every account.** It used to start only for
  `has_cost` accounts (it fed the account widget's dollar figure, which stays
  cost-account-only). Subscription accounts get notional API-rate cost, shown
  `≈$`.
- **No turn popover.** Its value — totals and X/Y — fits the agents popover
  header, and the rows would otherwise exist twice.

## Data

`SessionCostSnapshot.bySubagent: Record<agentId, SubagentCost>`:

- `usd`, `estimated` — summed over the agent's deduped requests.
- `contextTokens` — the latest request's input + cache read + cache write +
  output: what the agent's context holds now.
- `model` — the latest request's model, for the context window.

Mirrored in `src/lib/api.ts`.

## UI

Collapsed row, line 2 (replacing the truncated activity text, which the
expanded area already shows in full):

`model · effort · N tools        ctx 4% · 38k  ≈$0.05  0:26`

then a thin state bar: a sweep in the row's palette colour while running, full
green when done, red when failed. It first filled to context %, which on a
1M-window model sat at 2–3% for the whole run and read as a stuck progress bar
(revised 2026-10-08). Rows with no transcript (background shell tasks) show
time only in the stats.

- Time ticks every second while running (`now − startedAt`, never below the
  CLI's last reported `durationMs`); final `finalDurationMs` once done.
- Context % = `contextTokens / resolveContextWindow(model)`; omitted when the
  window is unknown.

Popover header: `2/4 done · ≈$0.25` (sum of row costs).
Readout: `agents 2/4` while running, `4 done` when not.

## Testing

- `computeSessionCost` per-agent split (core, pure).
- `subagentRunStats` helper (pure): join, elapsed, context %.
- Row and popover rendering in the existing BackgroundWork tests.
- `useAccountUsage` keeps `sessionCost` null for non-cost accounts while the
  live snapshot still flows.

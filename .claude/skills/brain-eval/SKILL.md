---
name: brain-eval
description: Use when Greg asks whether the Brain is worth it, wants its value/usefulness/cost reviewed or re-measured, or wants this run compared with earlier ones.
argument-hint: "[--since YYYY-MM-DD --until YYYY-MM-DD]"
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/*)
---

# Brain value eval

One repeatable run answers "is the Brain worth what it costs?" and is stored
so the next run can be compared with it. Definitions live in
`electron/services/brain/value-eval.ts` (tested); I/O in `scripts/brain-eval.ts`.

## Where runs live

`~/Library/Application Support/OmniFex/brain-evals/<since>_<until>_<created>/`
(`$OMNIFEX_USER_DATA_DIR/brain-evals/`): `metrics.json`, `report.md`,
`cases-<Account>.json`, `verdicts-<Account>.json`.

- **Never in the repo.** It is public, and cases quote real transcripts from
  both accounts.
- **Never in /tmp.** The 2026-09-11 judge pass lost its verdicts there.

## Procedure

1. **Measure** (default window: the last 30 full days):
   ```bash
   bash ${CLAUDE_SKILL_DIR}/scripts/brain-eval.sh measure $ARGUMENTS
   ```
   This prints the run dir. Keep windows month-aligned, or 30 days, so runs
   stay comparable.
2. **Judge.** Spawn one fresh `general-purpose` agent per account, in
   parallel. Point each at `${CLAUDE_SKILL_DIR}/judge-rubric.md`, the run dir,
   and its account; tell it not to call the omnifex-brain tools, and that
   `~/.claude-work/` is read-only. Do not judge the cases yourself, and do not
   give the agents your expectations: an anchored judge is how this number
   gets inflated.
3. **Record:**
   ```bash
   bash ${CLAUDE_SKILL_DIR}/scripts/brain-eval.sh record "<runDir>"
   ```
4. **Compare:**
   ```bash
   bash ${CLAUDE_SKILL_DIR}/scripts/brain-eval.sh compare
   ```
5. Report the headline: monthly $, helped rate, $ per helped search, what kind
   of value helped (continuity vs code-knowledge), and misled count, each
   against the previous judged run.

## Reading it

- **$ per helped search** is the decision number. It is window spend divided
  by (searches × sampled helped rate).
- **Substantive invocation rate** (sessions with ≥20 tool uses) is the one
  that matters. Trivial sessions rarely warrant a search.
- **`code-knowledge` helps are weak value.** `rg` would have found them.
  The 2026-09 pass found every help was `continuity`.
- **Misled 0 means "no visible harm".** A stale note that misled without
  being corrected leaves no trace.
- **Retrieval recall** stays `—` until ≥10 reformulation chains exist. That is
  by design, not breakage.
- **Spend** comes from `session_cost_daily` (`internal_kind` `brain-index` /
  `brain-curation`). `ledger` is `brain_spend` over the same window, a
  cross-check. A large gap between them is a bug worth chasing.
- **Backfilled runs** show today's vault size and replay against today's index.
  Sessions, searches, spend and verdicts are all historical.
- The judge samples at most 40 searches per account (`--judge-cap`), chosen by
  a hash of the tool-use id. The same window gives the same sample.

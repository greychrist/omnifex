---
name: verify
description: Use when running OmniFex's full verification gate — before a commit, before claiming a change is done, or when Greg says "verify", "run the gate", "run the checks".
argument-hint: "[--quick]"
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/*)
---

# Verify

Run the gate, from the repo root, as one command:

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/verify.sh $ARGUMENTS
```

- Default: `npm run check` → `npm run build` → `npm run test:coverage` →
  `npm run coverage:areas`, stopping at the first failure.
- `--quick`: `npm run check` → `npm test`. Fine during implementation; use the
  default before claiming full verification.
- Either way the script finishes with `npm run rebuild:electron` whenever
  vitest ran — tests leave `better-sqlite3` on the Node ABI and Greg's next
  `npm start` would crash without it.
- Every gate's full output is kept under `/tmp/omnifex-verify/<timestamp>/`.
  Read the log to find a failure; **never re-run to see it again** — re-running
  resamples a flake instead of replaying it. `account-identity.test.ts` is a
  known load-sensitive flake; check that log before calling it a regression.

## Report

- Each gate: PASS or FAIL, with the failing output for a FAIL.
- Coverage: the `All files` line and the per-area breakdown. Target is 80%
  lines repo-wide; flag any touched module below it. The per-area numbers
  matter more than the blend, which hides which population is short.
- If a gate cannot run (missing tooling), say exactly which and why. Node +
  npm are the only requirements.

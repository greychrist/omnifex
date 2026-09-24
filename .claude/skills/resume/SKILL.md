---
name: resume
description: Use when Greg asks where we were, what's next, what was in progress, or to resume, pick up, or recover work in the OmniFex repo — including at the start of a session that continues an earlier one.
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/*)
---

# Resume

Repo state as of this invocation:

```
!`bash ${CLAUDE_SKILL_DIR}/scripts/state.sh`
```

1. If the branch or the recent commits name a feature, skim the matching plan
   or spec under `docs/superpowers/plans/` / `docs/superpowers/specs/` and the
   auto-memory index for that thread. Read nothing broader unless the state
   above is insufficient.
2. If the working tree is dirty, `git diff` the changed files to see what was
   mid-flight.
3. Answer in this shape:
   - **Last completed:** the most recent landed step (commit or pushed release).
   - **In progress:** what the dirty files / unmerged branch are doing.
   - **Next:** the likely next step, as one action.
   - **Open:** blockers or decisions waiting on Greg, if any.

At most one clarifying question, and only if two threads are genuinely active.

---
name: which-model
description: Use when Greg asks which model a skill actually ran on, or wants to test whether a skill's `model:` frontmatter override took effect ("/which-model", "is the skill model working", "did that run on Fable").
model: fable
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/*)
---

# Which model ran this skill?

This skill pins `model: fable`. Prove from the transcript whether that took.

Do not answer from your own sense of which model you are: the CLI injects a
"You are powered by…" note naming the skill's model even when the request
went to a different one (CLI 2.1.326, Skill-tool invocation).

1. Run, as your first and only tool call:

   ```bash
   bash ${CLAUDE_SKILL_DIR}/scripts/report.sh
   ```

2. Reply with the script's output verbatim in a code block, then one line:
   `Self-report: <model id your system context names>` — so the gap, if any,
   is visible next to the ground truth.

`served` is what the API says answered; it is the only field that proves the
model. `HONORED` is expected when Greg types `/which-model`; `IGNORED` is the
known upstream bug when you started this skill through the Skill tool.

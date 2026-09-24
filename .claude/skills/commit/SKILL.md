---
name: commit
description: Use when Greg asks to commit, or to commit and push, in the OmniFex repo. He does not want to approve the message first.
argument-hint: "[push]"
---

# Commit

Verify, decide, commit, push — one pass, no approval step. Greg reads the
message in `git log` if he cares.

1. `bash .claude/skills/verify/scripts/verify.sh`. A FAIL stops here: report it,
   do not fix-and-commit in the same breath.
2. `git status --porcelain` and `git diff` to see what is actually there.
3. Stage only the files that belong to this change. Leave unrelated
   working-tree edits alone unless Greg said to include them.
4. Commit with a conventional prefix the log already uses (`fix:`, `feat:`,
   `chore:`, `docs:`, `refactor:`), subject in the imperative, body only when
   the *why* is not obvious from the diff. No attribution lines; settings
   already blank them, and none go in the body either.
5. Push when Greg said "push" or `$ARGUMENTS` says so; otherwise stop after the
   commit and say it is unpushed.

## Report

- Verify result (PASS/FAIL per gate).
- The commit hash and subject.
- Pushed or not.

## Don't

- Don't show the message and wait — that is the friction he removed.
- Don't commit `package.json` version bumps here; `omnifex-release` owns those.
- Don't `git add -A` when the tree has unrelated changes.

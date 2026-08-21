# Commit - Use this command only when the user explicitly asks to create a commit.

## Workflow

1. Run `/verify` first.
2. Inspect the diff and summarize the user-visible change.
3. Draft a concise commit message that matches the actual work.
4. Never commit automatically.
5. Present the proposed commit message for approval.
6. After approval:
   - stage only the relevant files
   - create the commit
   - never add Claude attribution lines

## Rules

- If verification fails, stop and report the blocker.
- If the worktree contains unrelated changes, do not include them unless the user explicitly asks.
- Report the exact verification commands and pass/fail result before asking for commit approval.

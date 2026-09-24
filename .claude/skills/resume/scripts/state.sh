#!/bin/bash
# Repo state for the resume skill. Runs as the `!` injection, so it must always exit 0.
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo"; exit 0; }
cd "$ROOT" || exit 0
echo "branch: $(git branch --show-current)"
echo "--- status (uncommitted)"
git status --short | head -40
echo "--- diff --stat"
git diff --stat | tail -3
echo "--- last 10 commits"
git log --oneline --decorate -n 10
echo "--- unpushed"
git fetch -q origin 2>/dev/null
echo "$(git rev-list --count @{upstream}..HEAD 2>/dev/null || echo '?') commit(s) ahead of upstream"
exit 0

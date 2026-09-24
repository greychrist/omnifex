#!/bin/bash
# Release preflight. Prints the facts the runbook needs and never exits
# non-zero: it runs as the skill's `!` injection, and a failing injected
# command aborts the whole skill invocation. Failures are reported in the
# text instead — read the STATUS lines.
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || { echo "STATUS: not inside a git repo"; exit 0; }
cd "$ROOT" || exit 0

cur=$(node -p "require('./package.json').version" 2>/dev/null)
IFS=. read -r a b c <<<"$cur"
next="$a.$b.$((c + 1))"
branch=$(git branch --show-current)
prev_tag=$(git describe --tags --abbrev=0 2>/dev/null)

echo "current version: $cur"
echo "next patch:      $next"
echo "branch:          $branch"

if git fetch -q origin 2>/tmp/release-preflight-fetch.err; then
  echo "fetch:           ok"
else
  echo "STATUS: git fetch origin FAILED — $(tr '\n' ' ' </tmp/release-preflight-fetch.err)"
fi

dirty=$(git status --porcelain | wc -l | tr -d ' ')
unpushed=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')
echo "uncommitted:     $dirty file(s)"
echo "unpushed:        $unpushed commit(s) ahead of origin/main"
[ "$branch" = "main" ] || echo "STATUS: branch is '$branch', not main — stop and ask"

if git show-ref -q --tags "v$next" || git ls-remote --tags origin "refs/tags/v$next" 2>/dev/null | grep -q .; then
  echo "STATUS: tag v$next already exists — pick the next number and tell Greg"
else
  echo "tag v$next:      free"
fi

echo "last tag:        ${prev_tag:-none}"
if [ -n "$prev_tag" ]; then
  echo "commits since $prev_tag:"
  git log "$prev_tag..HEAD" --oneline | sed 's/^/  /'
fi

if gh auth status >/dev/null 2>&1; then
  echo "gh auth:         ok"
else
  echo "STATUS: gh auth FAILED — run gh auth login"
fi

if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  echo "signing cert:    ok ($(security find-identity -v -p codesigning | grep -o '"Developer ID Application[^"]*"'))"
else
  echo "STATUS: no 'Developer ID Application' identity in keychain — see reference/signing.md"
fi

if xcrun notarytool history --keychain-profile omnifex-notary >/tmp/release-preflight-notary.txt 2>&1; then
  echo "notary profile:  ok (last: $(sed -n 's/^ *status: //p' /tmp/release-preflight-notary.txt | head -1))"
else
  echo "STATUS: notarytool profile 'omnifex-notary' FAILED — $(head -1 /tmp/release-preflight-notary.txt)"
fi
exit 0

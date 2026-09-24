#!/bin/bash
# Confirm the release is what every running OmniFex will now see.
# The updater polls GET /repos/greychrist/omnifex/releases/latest, so that is
# the endpoint checked — not `gh release view` (which has no isLatest field).
#   bash publish-check.sh 0.4.191
set -uo pipefail
V=${1:-}
[ -n "$V" ] || { echo "usage: publish-check.sh <version>" >&2; exit 2; }
REPO=greychrist/omnifex
latest=$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>&1) || { echo "FAIL  releases/latest: $latest"; exit 1; }
assets=$(gh api "repos/$REPO/releases/tags/v$V" --jq '.assets[].name' 2>&1) || { echo "FAIL  release v$V not found: $assets"; exit 1; }
fail=0
[ "$latest" = "v$V" ] && echo "PASS  releases/latest → $latest" || { echo "FAIL  releases/latest is $latest, expected v$V"; fail=1; }
for want in "OmniFex-$V-arm64.dmg" "OmniFex-darwin-arm64-$V.zip"; do
  grep -qx "$want" <<<"$assets" && echo "PASS  asset $want" || { echo "FAIL  asset missing: $want"; fail=1; }
done
echo "URL   https://github.com/$REPO/releases/tag/v$V"
exit $fail

#!/bin/bash
# Extract one CHANGELOG section into /tmp/release-notes-<version>.md.
# Flag-based loop on purpose: BSD awk's `/start/,/end/` range tests the end
# pattern on the start line, so every release before 2026-05-17 had an empty
# body.
set -euo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"
V=${1:-}
[ -n "$V" ] || { echo "usage: release-notes.sh <version>" >&2; exit 2; }
OUT=/tmp/release-notes-$V.md
awk -v ver="$V" '
  $0 ~ "^## \\[" ver "\\]" { in_range=1; print; next }
  in_range && /^## \[/ { exit }
  in_range
' CHANGELOG.md >"$OUT"
headers=$(grep -c '^## \[' "$OUT" || true)
[ "$headers" = 1 ] || { echo "expected exactly one '## [' header in $OUT, found $headers" >&2; exit 1; }
grep -q '^### ' "$OUT" || { echo "no '### ' section under [$V] in CHANGELOG.md" >&2; exit 1; }
echo "$OUT ($(wc -l <"$OUT" | tr -d ' ') lines)"
cat "$OUT"

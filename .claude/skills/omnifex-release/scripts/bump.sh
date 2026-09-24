#!/bin/bash
# Bump package.json and insert the CHANGELOG entry from stdin.
#   bash bump.sh 0.4.191 < /tmp/changelog-0.4.191.md
# stdin holds the entry BODY only (### Added / ### Changed / ... sections);
# the `## [0.4.191] — YYYY-MM-DD` header is added here. Nothing is committed.
set -euo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"

V=${1:-}
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: bump.sh <major.minor.patch> < changelog-body.md" >&2; exit 2; }
if git show-ref -q --tags "v$V" || git ls-remote --tags origin "refs/tags/v$V" | grep -q .; then
  echo "tag v$V already exists" >&2; exit 1
fi
[ -t 0 ] && { echo "changelog body must be piped on stdin" >&2; exit 2; }
BODY=$(mktemp /tmp/changelog-body.XXXXXX)
trap 'rm -f "$BODY"' EXIT
cat >"$BODY"
[ -s "$BODY" ] || { echo "changelog body is empty" >&2; exit 1; }
grep -q '^### ' "$BODY" || { echo "changelog body has no '### ' section" >&2; exit 1; }

node - "$V" "$BODY" <<'JS'
const fs = require('fs');
const [v, bodyPath] = process.argv.slice(2);

// package.json: only the top-level "version" line, formatting untouched.
const pkg = fs.readFileSync('package.json', 'utf8');
const bumped = pkg.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${v}$2`);
if (bumped === pkg) { console.error('package.json: version line not found'); process.exit(1); }
fs.writeFileSync('package.json', bumped);

// CHANGELOG: new section above the first existing `## [` header.
const today = new Date().toISOString().slice(0, 10);
const header = `## [${v}] — ${today}`;
const body = fs.readFileSync(bodyPath, 'utf8').trim();
const log = fs.readFileSync('CHANGELOG.md', 'utf8');
const at = log.search(/^## \[/m);
const entry = `${header}\n\n${body}\n\n`;
const out = at === -1 ? `${log.trimEnd()}\n\n${entry}` : log.slice(0, at) + entry + log.slice(at);
fs.writeFileSync('CHANGELOG.md', out);
console.log(`package.json → ${v}`);
console.log(`CHANGELOG.md → ${header}`);
JS
git --no-pager diff --stat -- package.json CHANGELOG.md

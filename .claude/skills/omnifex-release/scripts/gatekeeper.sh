#!/bin/bash
# The Gatekeeper gate. Exits non-zero unless EVERY check passes; an artifact
# that fails here must not be uploaded.
#   bash gatekeeper.sh 0.4.191
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"
V=${1:-}
[ -n "$V" ] || { echo "usage: gatekeeper.sh <version>" >&2; exit 2; }
TEAM=37YG3HV4BV
APP=out/OmniFex-darwin-arm64/OmniFex.app
DMG=out/make/OmniFex-$V-arm64.dmg
ZIP=out/make/zip/darwin/arm64/OmniFex-darwin-arm64-$V.zip
fail=0
check() { # check <label> <expected-regex> <command...>
  local label=$1 want=$2; shift 2
  local out; out=$("$@" 2>&1)
  if grep -qE "$want" <<<"$out"; then echo "PASS  $label"; else echo "FAIL  $label"; echo "$out" | sed 's/^/      /'; fail=1; fi
}
for f in "$APP" "$DMG" "$ZIP"; do [ -e "$f" ] || { echo "FAIL  missing artifact: $f"; fail=1; }; done
[ $fail = 0 ] || exit 1

check "app codesign --verify --deep --strict" '^$' codesign --verify --deep --strict "$APP"
check "app TeamIdentifier=$TEAM"              "TeamIdentifier=$TEAM" codesign -dv --verbose=2 "$APP"
check "app hardened runtime flag"             'flags=0x10000\(runtime\)' codesign -dv --verbose=2 "$APP"
check "app spctl: Notarized Developer ID"     'source=Notarized Developer ID' spctl -a -vvv -t exec "$APP"
check "app stapler validate"                  'The validate action worked' xcrun stapler validate "$APP"
check "dmg spctl: Notarized Developer ID"     'source=Notarized Developer ID' spctl -a -vvv -t open --context context:primary-signature "$DMG"
check "dmg stapler validate"                  'The validate action worked' xcrun stapler validate "$DMG"

echo
ls -lh "$DMG" "$ZIP" | awk '{print "      " $5 "  " $9}'
if [ $fail = 0 ]; then echo "GATEKEEPER: all checks passed — signed, notarized, stapled"; else echo "GATEKEEPER: FAILED — do not upload"; exit 1; fi

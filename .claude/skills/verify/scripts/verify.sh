#!/bin/bash
# OmniFex verification gate. Stops at the first failing gate and keeps every
# log so a failure is replayed from disk instead of re-run (re-running
# resamples flakes).
#   bash verify.sh          # check → build → test:coverage → test:swift → coverage:areas
#   bash verify.sh --quick  # check → test → test:swift
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"
LOGDIR=/tmp/omnifex-verify/$(date +%Y%m%d-%H%M%S)
mkdir -p "$LOGDIR"
status=0

# One Node major everywhere: the native modules are built for it, and the app
# bundles it. A different node here fails ~286 jsdom tests and every native
# require, which reads as a mass regression and is not one.
want=$(cat .nvmrc 2>/dev/null)
have=$(node -p 'process.versions.node.split(".")[0]')
if [ -n "$want" ] && [ "$have" != "$want" ]; then
  echo "FAIL  node $have, but .nvmrc says $want — run: nvm use"
  exit 1
fi

gate() { # gate <name> <npm script>
  local name=$1 script=$2
  local log="$LOGDIR/$name.log"  # separate line: one `local` expands $name before assigning it
  echo "== npm run $script"
  if npm run "$script" >"$log" 2>&1; then
    echo "PASS  npm run $script"
  else
    echo "FAIL  npm run $script  (log: $log)"
    tail -n 40 "$log" | sed 's/^/      /'
    status=1
    return 1
  fi
}

gate check check || exit 1
if [ "${1:-}" = "--quick" ]; then
  gate test test && gate swift test:swift
else
  gate build build && gate coverage test:coverage && gate swift test:swift
fi
rc=$status

if [ $rc = 0 ] && [ "${1:-}" != "--quick" ]; then
  echo "== coverage summary"
  grep -E '^All files' "$LOGDIR/coverage.log" | sed 's/^/      /'
  echo "== npm run coverage:areas"
  npm run coverage:areas 2>&1 | tail -n 30 | sed 's/^/      /'
fi

echo "logs: $LOGDIR"
exit $rc

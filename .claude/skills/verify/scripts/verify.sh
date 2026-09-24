#!/bin/bash
# OmniFex verification gate. Stops at the first failing gate, always leaves
# the native modules on the Electron ABI afterwards, and keeps every log so a
# failure is replayed from disk instead of re-run (re-running resamples flakes).
#   bash verify.sh          # check → build → test:coverage → coverage:areas
#   bash verify.sh --quick  # check → test
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"
LOGDIR=/tmp/omnifex-verify/$(date +%Y%m%d-%H%M%S)
mkdir -p "$LOGDIR"
ran_tests=0
status=0

gate() { # gate <name> <npm script>
  local name=$1 script=$2 log="$LOGDIR/$name.log"
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
  ran_tests=1
  gate test test
else
  gate build build && { ran_tests=1; gate coverage test:coverage; }
fi
rc=$status

if [ $rc = 0 ] && [ "${1:-}" != "--quick" ]; then
  echo "== coverage summary"
  grep -E '^All files' "$LOGDIR/coverage.log" | sed 's/^/      /'
  echo "== npm run coverage:areas"
  npm run coverage:areas 2>&1 | tail -n 30 | sed 's/^/      /'
fi

if [ $ran_tests = 1 ]; then
  echo "== npm run rebuild:electron (vitest left native modules on the Node ABI)"
  if npm run rebuild:electron >"$LOGDIR/rebuild.log" 2>&1; then
    echo "PASS  rebuild:electron"
  else
    echo "FAIL  rebuild:electron — the app will crash on next npm start (log: $LOGDIR/rebuild.log)"
    tail -n 10 "$LOGDIR/rebuild.log" | sed 's/^/      /'
    rc=1
  fi
fi
echo "logs: $LOGDIR"
exit $rc

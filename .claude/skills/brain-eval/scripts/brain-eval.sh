#!/usr/bin/env bash
# Thin wrapper: run scripts/brain-eval.ts from the repo root with the TS resolver hook.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
exec node --no-warnings --experimental-strip-types --import ./scripts/lib/register-ts.mjs \
  scripts/brain-eval.ts "$@"

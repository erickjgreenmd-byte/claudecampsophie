#!/usr/bin/env bash
# Pre-commit gate for the lead session and agents (lesson L-004): every step must pass and no step is
# piped through a filter that would hide its exit status.
#
#   scripts/verify.sh                         # whole repository (what CI runs)
#   scripts/verify.sh --only api,web,db        # only these workspace dirs (while others are mid-edit)
#   scripts/verify.sh --no-tests               # static checks only
#   scripts/verify.sh --no-artifacts           # skip building and secret-scanning release artifacts
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_TESTS=1
RUN_ARTIFACTS=1
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-tests) RUN_TESTS=0 ;;
    --no-artifacts) RUN_ARTIFACTS=0 ;;
    --only) ONLY="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

dir_for() {
  case "$1" in
    db) echo supabase ;;
    api | web | mobile) echo "apps/$1" ;;
    *) echo "packages/$1" ;;
  esac
}

echo "▶ secrets"; node scripts/scan-secrets.mjs
if [ -z "$ONLY" ]; then
  echo "▶ format"; pnpm -s format:check
  echo "▶ lint"; pnpm -s lint
  echo "▶ typecheck"; pnpm -s typecheck
  if [ "$RUN_TESTS" = 1 ]; then
    echo "▶ tests"; pnpm -s test
    # Same audit as CI: every package ran at least its floor of tests, none failed or skipped.
    echo "▶ gate audit"; node scripts/assert-test-count.mjs
  fi
  echo "▶ finance"; pnpm -s finance:check
  if [ "$RUN_ARTIFACTS" = 1 ]; then
    # Same release builds, scan and negative control as CI (AC_SECURITY_04); nothing is deployed.
    echo "▶ release artifacts"; bash scripts/scan-release-artifacts.sh
  fi
else
  IFS=',' read -r -a names <<< "$ONLY"
  dirs=()
  for n in "${names[@]}"; do dirs+=("$(dir_for "$n")"); done
  echo "▶ format (${dirs[*]})"; npx prettier --check "${dirs[@]}"
  echo "▶ lint (${dirs[*]})"; npx eslint "${dirs[@]}" --max-warnings=0
  for d in "${dirs[@]}"; do
    name=$(node -p "require('./$d/package.json').name")
    echo "▶ typecheck $name"; pnpm -s --filter "$name" run typecheck
    if [ "$RUN_TESTS" = 1 ]; then echo "▶ test $name"; pnpm -s --filter "$name" run test; fi
  done
fi
echo "✓ verify passed"

#!/usr/bin/env bash
# Stop: the agent may not finish while `npm run verify` is red. Runs only
# when this branch changed something (committed or not) against origin/dev.
set -uo pipefail
input=$(cat)
# A second stop after this hook already blocked once: let it through, so a
# check that cannot pass never traps the agent in a loop.
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root" || exit 0
base=$(git merge-base HEAD origin/dev 2>/dev/null || git rev-parse HEAD)
if git diff --quiet "$base" -- && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi
if ! out=$(npm run --silent verify 2>&1); then
  {
    echo "npm run verify is red, so the task is not done:"
    echo "$out" | tail -60
    echo
    echo "Fix the failures (without weakening rules or baselines), then finish."
  } >&2
  exit 2
fi
exit 0

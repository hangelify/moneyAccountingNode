#!/usr/bin/env bash
# PreToolUse (Bash): commands that destroy data, rewrite history, skip the
# commit checks or grow a baseline.
set -uo pipefail
cmd=$(jq -r '.tool_input.command // empty')
block() {
  echo "Blocked: $1" >&2
  exit 2
}
grep -qE '(^|[^[:alnum:]_-])(schema:(update|drop|fresh))' <<<"$cmd" && block "mikro-orm schema:* changes the database outside migrations; write a migration."
if grep -qE 'migration:fresh' <<<"$cmd" && [ -z "${CI:-}" ]; then
  block "migration:fresh drops the whole database; only CI runs it."
fi
grep -qE 'git[[:space:]]+push.*(--force|[[:space:]]-f([[:space:]]|$)|--force-with-lease)' <<<"$cmd" && block "force push rewrites shared history."
grep -qE -- '--no-verify' <<<"$cmd" && block "--no-verify skips the commit checks; fix what they report."
grep -qE -- '--suppress-(all|rule)' <<<"$cmd" && block "growing eslint-suppressions.json hides new violations; fix them."
grep -qE -- '--baseline([[:space:]=]|$)' <<<"$cmd" && ! grep -qE -- 'shrink-only' <<<"$cmd" && block "only npm run arch:baseline (shrink-only) may touch the dependency-cruiser baseline."
exit 0

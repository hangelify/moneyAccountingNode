#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit): lint the edited TypeScript file at once,
# while the change is fresh. Exit 2 hands the errors back to the agent.
set -uo pipefail
input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
case "$file" in
  *.ts) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
case "$(realpath "$file")" in
  "$root"/src/*|"$root"/test/*|"$root"/scripts/*) ;;
  *) exit 0 ;;
esac
cd "$root" || exit 0
if ! out=$(npx eslint --max-warnings 0 "$file" 2>&1); then
  {
    echo "ESLint failed for $file:"
    echo "$out"
    echo
    echo "Fix the code. Do not add eslint-disable, edit eslint.config.mjs or eslint-suppressions.json to silence it."
  } >&2
  exit 2
fi
exit 0

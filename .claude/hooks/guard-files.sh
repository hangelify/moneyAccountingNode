#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): checks and their baselines are the
# owner's to change, and applied migrations are immutable. New text may not
# switch checks off inline.
set -uo pipefail
input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")
[ -n "$file" ] || exit 0
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
rel=$(realpath -m --relative-to="$root" "$file")

block() {
  echo "Blocked: $1" >&2
  echo "Ask the owner if this really has to change; otherwise fix the code instead." >&2
  exit 2
}

case "$rel" in
  eslint.config.*|eslint-suppressions.json|.dependency-cruiser.cjs|.dependency-cruiser-known-violations.json|\
  .jscpd.json|knip.json|.squawk.toml|tsconfig*.json|.claude/settings.json|.claude/hooks/*|.husky/*|.github/*|AGENTS.md)
    block "$rel configures the code checks (see README, Code Checks)." ;;
esac
case "$rel" in
  src/migrations/Migration*.ts)
    # Applied = already on the base branch. A migration this branch added may
    # still be fixed (CI's migrations:lint treats it as new too).
    base=${GUARD_BASE:-$(git -C "$root" merge-base HEAD origin/dev 2>/dev/null || echo HEAD)}
    if git -C "$root" cat-file -e "$base:$rel" 2>/dev/null; then
      block "$rel is already on the base branch; add a new migration instead."
    fi ;;
esac

# Inline suppressions matter in code only (docs may name them).
case "$rel" in
  *.ts|*.js|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

# Text the edit adds: Write content, Edit new_string, MultiEdit new_strings.
new=$(jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)] | map(select(. != null)) | join("\n")' <<<"$input")
old=$(jq -r '[.tool_input.old_string, (.tool_input.edits // [] | .[].old_string)] | map(select(. != null)) | join("\n")' <<<"$input")
# A Write replaces the whole file: compare with what is there now.
if [ "$(jq -r '.tool_name // empty' <<<"$input")" = "Write" ] && [ -f "$file" ]; then
  old=$(cat "$file")
fi
pattern='eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|\bas any\b'
count() { grep -oE "$pattern" <<<"$1" | wc -l; }
if [ "$(count "$new")" -gt "$(count "$old")" ]; then
  block "the edit adds $(grep -oE "$pattern" <<<"$new" | sort -u | paste -sd, -). Fix the type or the code the rule points at."
fi
exit 0

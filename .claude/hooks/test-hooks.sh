#!/usr/bin/env bash
# Regression tests for the guard hooks: bash .claude/hooks/test-hooks.sh
set -uo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$dir" rev-parse --show-toplevel)
fail=0

expect() { # expect <exit> <hook> <name> <json>
  local want=$1 hook=$2 name=$3 json=$4 got
  printf '%s' "$json" | "$dir/$hook" >/dev/null 2>&1
  got=$?
  if [ "$got" != "$want" ]; then
    echo "FAIL $hook: $name (exit $got, want $want)"
    fail=1
  fi
}
bash_cmd() { jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'; }
edit() { jq -nc --arg f "$root/$1" --arg o "$2" --arg n "$3" '{tool_name:"Edit",tool_input:{file_path:$f,old_string:$o,new_string:$n}}'; }
write() { jq -nc --arg f "$root/$1" --arg c "$2" '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}'; }

# guard-bash: blocked
expect 2 guard-bash.sh 'schema:update'       "$(bash_cmd 'npx mikro-orm schema:update --run')"
expect 2 guard-bash.sh 'npm schema:drop'     "$(bash_cmd 'npm run schema:drop')"
expect 2 guard-bash.sh 'migration:fresh'     "$(bash_cmd 'npm run migration:fresh')"
expect 2 guard-bash.sh 'mikro-orm fresh'     "$(bash_cmd 'DB_NAME=x npx mikro-orm migration:fresh')"
expect 2 guard-bash.sh 'push -f'             "$(bash_cmd 'git push -f origin dev')"
expect 2 guard-bash.sh 'push --force'        "$(bash_cmd 'git push --force-with-lease origin dev')"
expect 2 guard-bash.sh 'push +refspec'       "$(bash_cmd 'git push origin +dev')"
expect 2 guard-bash.sh 'commit --no-verify'  "$(bash_cmd 'git commit --no-verify -m x')"
expect 2 guard-bash.sh 'commit -n'           "$(bash_cmd 'git commit -n -m x')"
expect 2 guard-bash.sh 'commit -nm'          "$(bash_cmd 'git commit -nm x')"
expect 2 guard-bash.sh 'HUSKY=0'             "$(bash_cmd 'HUSKY=0 git commit -m x')"
expect 2 guard-bash.sh 'suppress-all'        "$(bash_cmd 'npx eslint src --suppress-all')"
expect 2 guard-bash.sh 'arch baseline grow'  "$(bash_cmd 'npx depcruise src --baseline .dependency-cruiser-known-violations.json')"
# guard-bash: allowed
expect 0 guard-bash.sh 'grep for text'       "$(bash_cmd 'grep -rn schema:update README.md')"
expect 0 guard-bash.sh 'commit msg mentions' "$(bash_cmd 'git commit -m "docs: CI runs migration:fresh, never --no-verify"')"
expect 0 guard-bash.sh 'heredoc msg'         "$(bash_cmd $'git commit -F - <<\'MSG\'\nnever git push --force\nMSG')"
expect 0 guard-bash.sh 'push then rm -f'     "$(bash_cmd 'git push origin dev && rm -f tmp.log')"
expect 0 guard-bash.sh 'plain push'          "$(bash_cmd 'git push -u origin chore/x')"
expect 0 guard-bash.sh 'arch:baseline'       "$(bash_cmd 'npm run arch:baseline')"
expect 0 guard-bash.sh 'lint:prune'          "$(bash_cmd 'npm run lint:prune')"
expect 0 guard-bash.sh 'migration:drift'     "$(bash_cmd 'npm run migration:drift')"

# guard-files: blocked
expect 2 guard-files.sh 'as any in .ts'      "$(edit src/a.ts 'const a = 1;' 'const a = x as any;')"
expect 2 guard-files.sh 'eslint-disable .ts' "$(write src/new.ts $'// eslint-disable-next-line\nfoo();')"
expect 2 guard-files.sh 'eslint config'      "$(edit eslint.config.mjs a b)"
expect 2 guard-files.sh 'suppressions'       "$(edit eslint-suppressions.json a b)"
expect 2 guard-files.sh 'hook script'        "$(edit .claude/hooks/guard-bash.sh a b)"
expect 2 guard-files.sh 'claude settings'    "$(edit .claude/settings.json a b)"
expect 2 guard-files.sh 'migration on dev'   "$(edit src/migrations/Migration20251222153703_CreateUserTable.ts a b)"
# guard-files: allowed
expect 0 guard-files.sh 'clean edit'         "$(edit src/a.ts a b)"
expect 0 guard-files.sh 'keeps existing any' "$(edit src/a.ts 'y as any; a' 'y as any; b')"
expect 0 guard-files.sh 'README mentions'    "$(edit README.md a 'Never add eslint-disable or as any.')"
expect 0 guard-files.sh 'launch.json'        "$(write .claude/launch.json '{}')"
# A migration this branch added (absent on the base) may still be fixed.
GUARD_BASE=fa578d4~1 expect 0 guard-files.sh 'branch-added migration' "$(edit src/migrations/Migration20261109150000_AddBillClientBatch.ts a b)"
GUARD_BASE=fa578d4 expect 2 guard-files.sh 'migration on base' "$(edit src/migrations/Migration20261109150000_AddBillClientBatch.ts a b)"
expect 0 guard-files.sh 'rewrite keeps disables' "$(write src/modules/auth/auth.module.spec.ts "$(cat "$root/src/modules/auth/auth.module.spec.ts")")"
expect 0 guard-files.sh 'new migration'      "$(write src/migrations/Migration20991231000000_New.ts x)"

[ "$fail" = 0 ] && echo "hooks: all cases pass"
exit "$fail"

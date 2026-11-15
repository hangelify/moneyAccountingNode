# Sourced by hooks that run Node tools. Hooks inherit the PATH of whoever
# started Claude Code, which may hold another Node: on Node < 24 Jest cannot
# require() the ESM-only packages and verify fails with dozens of misleading
# test errors. Put the major version from .nvmrc first on PATH instead.
#
# use_project_node <repo root>: 0 = the right Node is on PATH;
# 1 = none installed (message on stderr, nothing was run).
use_project_node() {
  local root=$1 want have dir candidates
  want=$(tr -d ' v\r\n' <"$root/.nvmrc" 2>/dev/null)
  want=${want%%.*}
  [ -n "$want" ] || return 0
  have=$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')
  [ "$have" = "$want" ] && return 0
  shopt -s nullglob
  candidates=("${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$want".*)
  shopt -u nullglob
  # Newest patch first.
  for dir in $(printf '%s\n' "${candidates[@]}" | sort -V -r); do
    if [ -x "$dir/bin/node" ]; then
      PATH="$dir/bin:$PATH"
      export PATH
      return 0
    fi
  done
  echo "Node $want is required (.nvmrc), but node on PATH is ${have:-missing}." >&2
  echo "Install it (nvm install $want) or start Claude Code with Node $want on PATH;" >&2
  echo "this is the environment, not the code: do not change code or checks for it." >&2
  return 1
}

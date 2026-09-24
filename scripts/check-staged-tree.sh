#!/usr/bin/env bash
# Typechecks exactly what is staged (the git index), not the working tree (BUG-034, lesson L-008).
# A commit that imports an untracked file, or depends on an unstaged edit, fails here even though the
# working tree compiles.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pl-index.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
git -C "$root" checkout-index --all --prefix="$tmp/"

# Mirror each node_modules directory with symlinks. Third-party entries point at the installed
# packages; workspace links (@pencillift/*) point at the INDEX copy, never the working tree.
mirror_modules() {
  local real="$1" copy="$2" entry name target sub
  mkdir -p "$copy"
  for entry in "$real"/* "$real"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="${entry##*/}"
    if [ -d "$entry" ] && [ ! -L "$entry" ] && [[ "$name" == @* ]]; then
      mkdir -p "$copy/$name"
      for sub in "$entry"/*; do
        target="$(readlink -f "$sub")"
        if [[ "$target" == "$root"/* && "$target" != */node_modules/* ]]; then
          ln -s "$tmp/${target#"$root"/}" "$copy/$name/${sub##*/}"
        else
          ln -s "$target" "$copy/$name/${sub##*/}"
        fi
      done
    else
      ln -s "$(readlink -f "$entry")" "$copy/$name"
    fi
  done
}

mirror_modules "$root/node_modules" "$tmp/node_modules"
for dir in "$root"/apps/* "$root"/packages/* "$root"/supabase; do
  rel="${dir#"$root"/}"
  if [ -d "$dir/node_modules" ] && [ -d "$tmp/$rel" ]; then
    mirror_modules "$dir/node_modules" "$tmp/$rel/node_modules"
  fi
done
cd "$tmp"
pnpm -r --workspace-concurrency=4 run typecheck

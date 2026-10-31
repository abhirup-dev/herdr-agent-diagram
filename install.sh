#!/bin/sh
# herdr-draw bootstrap: gets the package, then hands over to `herdr-draw install` (which asks what to set up).
#   curl -fsSL https://raw.githubusercontent.com/abhirup-dev/herdr-canvas-mod/main/install.sh | sh
#   ... | sh -s -- -y --agents claude,pi --machines vpsme      (no questions, for agents and scripts)
# From a clone, `./install.sh` installs that checkout instead of cloning.
# While the repo is private, curl can't fetch this file: clone it (git clone <repo>) and run ./install.sh.
# Env: HERDR_DRAW_REPO (git URL), HERDR_DRAW_HOME (where the clone lives, default ~/.local/share/herdr-draw).
set -eu
repo="${HERDR_DRAW_REPO:-https://github.com/abhirup-dev/herdr-canvas-mod.git}"
dir="${HERDR_DRAW_HOME:-$HOME/.local/share/herdr-draw}"

say() { printf 'herdr-draw: %s\n' "$*"; }

bun="$(command -v bun || true)"
[ -n "$bun" ] || { [ -x "$HOME/.bun/bin/bun" ] && bun="$HOME/.bun/bin/bun"; } || true
if [ -z "$bun" ]; then
  say "needs bun (https://bun.sh). Installing it with: curl -fsSL https://bun.sh/install | bash"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  bun="$HOME/.bun/bin/bun"
fi

here="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/package.json" ] && grep -q '"name": "herdr-draw"' "$here/package.json"; then
  dir="$here"
  say "installing this checkout ($dir)"
elif [ -d "$dir/.git" ]; then
  say "updating $dir"
  git -C "$dir" pull --ff-only --quiet
else
  say "cloning $repo into $dir"
  mkdir -p "$(dirname "$dir")"
  git clone --quiet --depth 1 "$repo" "$dir"
fi

cd "$dir"
[ "$dir" = "$here" ] && "$bun" install --frozen-lockfile --silent || "$bun" install --production --frozen-lockfile --silent
# Questions need the terminal: under `curl | sh` stdin is this script.
if [ -t 1 ] && [ -r /dev/tty ]; then exec "$bun" cli/herdr-draw.mjs install "$@" </dev/tty; fi
exec "$bun" cli/herdr-draw.mjs install "$@"

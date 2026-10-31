#!/bin/sh
# Local install for the POC: CLI on PATH, mods into the Herdr app home.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$HOME/.local/bin" "$app/mods"
ln -sf "$here/bin/herdr-diagram.mjs" "$HOME/.local/bin/herdr-diagram"
for m in diagram-pane diagram-popup; do
  mkdir -p "$app/mods/$m"
  cp "$here/mods/$m"/* "$app/mods/$m/"
done
for d in "$HOME/.claude/skills" "$HOME/.pi/agent/skills"; do
  mkdir -p "$d" && ln -sfn "$here/skills/herdr-diagram" "$d/herdr-diagram"
done
echo "installed: ~/.local/bin/herdr-diagram, $app/mods/{diagram-pane,diagram-popup}, skill in ~/.claude/skills and ~/.pi/agent/skills"
echo "layout: add the header to a cloned layout, see README"

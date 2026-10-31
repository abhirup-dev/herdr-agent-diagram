#!/bin/sh
# Local install for the POC: CLI on PATH, mods into the Herdr app home.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$HOME/.local/bin" "$app/mods"
ln -sf "$here/bin/herdr-diagram.mjs" "$HOME/.local/bin/herdr-diagram"
ln -sf "$here/bin/herdr-canvas.mjs" "$HOME/.local/bin/herdr-canvas"
for m in diagram-pane diagram-popup; do
  mkdir -p "$app/mods/$m"
  cp "$here/mods/$m"/* "$app/mods/$m/"
done
(cd "$here" && bun run build:mod >/dev/null) && mkdir -p "$app/mods/excal-canvas" && cp -R "$here/dist/mods/excal-canvas/." "$app/mods/excal-canvas/"
for d in "$HOME/.claude/skills" "$HOME/.pi/agent/skills"; do
  mkdir -p "$d" && ln -sfn "$here/skills/herdr-diagram" "$d/herdr-diagram"
  ln -sfn "$here/skills/herdr-canvas" "$d/herdr-canvas"
done
echo "installed: ~/.local/bin/{herdr-diagram,herdr-canvas}, $app/mods/{diagram-pane,diagram-popup,excal-canvas}, skill in ~/.claude/skills and ~/.pi/agent/skills"
echo "layout: add the header to a cloned layout, see README"

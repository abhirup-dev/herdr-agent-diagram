#!/usr/bin/env node
// herdr-draw: one CLI for the visuals an agent shows in the Herdr desktop app.
// A thin router: each group lives in bin/lib/.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { HELP as CANVAS_HELP, canvas, open } from "./lib/canvas.mjs";
import { HELP as MERMAID_HELP, mermaid } from "./lib/mermaid.mjs";

export const HELP = `herdr-draw: pinned Mermaid diagrams and a live Excalidraw canvas for the Herdr terminal you run in.

usage: herdr-draw <group> <command> [options]

  mermaid ...   pin read-only Mermaid diagrams (herdr-draw mermaid help)
  canvas ...    the live, editable Excalidraw canvas (herdr-draw canvas help)
  open          show the view for this terminal (for now: canvas open)
  help          this text

${MERMAID_HELP}
${CANVAS_HELP}`;

// argv (without node and script) -> the function to run, or null for an unknown command.
export function route(argv) {
  const [group, ...rest] = argv;
  if (group === undefined || group === "help" || group === "--help" || group === "-h")
    return () => process.stdout.write(HELP);
  if (group === "mermaid") return () => mermaid(rest);
  if (group === "canvas") return (env) => canvas(rest, env);
  if (group === "open" && !rest.length) return (env) => open(env);
  return null;
}

// Only run as a CLI; tests import route.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const run = route(process.argv.slice(2));
  if (!run) {
    process.stderr.write(`herdr-draw: unknown command ${process.argv.slice(2).join(" ")}\n\n${HELP}`);
    process.exit(2);
  }
  await run(process.env);
}

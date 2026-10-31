#!/usr/bin/env node
// herdr-draw: one CLI for the visuals an agent shows in the Herdr desktop app.
// A thin router: each group lives in cli/lib/.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { logger } from "../src/log/log.mjs";
import { bridgeEndpoint, HELP as CANVAS_HELP, canvas, open } from "./lib/canvas.mjs";
import { HELP as INSTALL_HELP, setup, version } from "./lib/install.mjs";
import { HELP as LOGS_HELP, logs } from "./lib/logs.mjs";
import { HELP as MERMAID_HELP, mermaid } from "./lib/mermaid.mjs";

export const HELP = `herdr-draw: pinned Mermaid diagrams and a live Excalidraw canvas for the Herdr terminal you run in.

usage: herdr-draw <group> <command> [options]

  mermaid ...   pin read-only Mermaid diagrams (herdr-draw mermaid help)
  canvas ...    the live, editable Excalidraw canvas (herdr-draw canvas help)
  open          show the view for this terminal (for now: canvas open)
  install       set up this machine and, if you choose, your other machines (herdr-draw install help)
  uninstall     remove it (and from synced machines)
  doctor        check the setup here and on synced machines
  logs          recent log lines from every part, here or on a machine (herdr-draw logs help)
  --version     print the version
  help          this text

${MERMAID_HELP}
${CANVAS_HELP}
${INSTALL_HELP}
${LOGS_HELP}`;

// argv (without node and script) -> the function to run, or null for an unknown command.
export function route(argv) {
  const [group, ...rest] = argv;
  if (group === undefined || group === "help" || group === "--help" || group === "-h")
    return () => process.stdout.write(HELP);
  if (group === "mermaid") return () => mermaid(rest);
  if (group === "canvas") return (env) => canvas(rest, env);
  if (group === "open" && !rest.length) return (env) => open(env);
  if (group === "install" || group === "uninstall" || group === "doctor") return (env) => setup(group, rest, env);
  if (group === "--version" || group === "-V") return version;
  if (group === "logs") return (env) => logs(rest, env);
  // Internal: the main machine runs this here over hc to reach this machine's boards.
  if (group === "bridge" && rest[0] === "endpoint") return (env) => bridgeEndpoint(env);
  return null;
}

// Only run as a CLI; tests import route.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const run = route(process.argv.slice(2));
  if (!run) {
    process.stderr.write(`herdr-draw: unknown command ${process.argv.slice(2).join(" ")}\n\n${HELP}`);
    process.exit(2);
  }
  // One line per invocation (start, end, exit code), so a problem can be lined up with the sidecar's log.
  const log = logger("cli");
  const t = Date.now();
  const argv = process.argv.slice(2).join(" ");
  log(`run: herdr-draw ${argv} (terminal ${process.env.HC_TERMINAL_ID ?? "-"}, cwd ${process.cwd()})`);
  process.on("exit", (code) =>
    log(`done: herdr-draw ${argv.slice(0, 80)} -> exit ${process.exitCode ?? code} in ${Date.now() - t} ms`),
  );
  await run(process.env);
}

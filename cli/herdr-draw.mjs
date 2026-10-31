#!/usr/bin/env node
// herdr-draw: one CLI for the visuals an agent shows in the Herdr desktop app.
// A thin router: each group lives in cli/lib/.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { cac } from "cac";
import { logger } from "../src/log/log.mjs";
import { parse } from "./lib/args.mjs";
import { bridgeEndpoint, canvas } from "./lib/canvas.mjs";
import { setup, version } from "./lib/install.mjs";
import { logs } from "./lib/logs.mjs";
import { mermaid } from "./lib/mermaid.mjs";

export const HELP = `herdr-draw: pinned Mermaid diagrams and a live Excalidraw canvas for the Herdr terminal you run in.

usage: herdr-draw <group> <command> [options]
       herdr-draw help [group [command]]

  mermaid ...       pin read-only Mermaid diagrams (herdr-draw mermaid help)
  canvas ...        the live, editable Excalidraw canvas (herdr-draw canvas help)
  open              show the view for this terminal (for now: canvas open)
  install           set up this machine and, if you choose, your other machines (herdr-draw install help)
  uninstall         remove it (and from synced machines)
  doctor            check the setup here and on synced machines
  logs              recent log lines from every part, here or on a machine (herdr-draw logs help)
  bridge endpoint   internal: the main machine runs this here over hc to reach this machine's boards
  help, -h, --help  this overview; details per group: herdr-draw <group> help (or -h, --help after any command)
  -V, --version     print the version

exit codes: 0 ok, 1 error, 2 usage (unknown command, option or argument), 3 board unreachable (canvas board commands)

environment:
  HC_TERMINAL_ID        the terminal you run in (set by herdr-core): it picks your pins and your canvas board
  HERDR_APP_HOME        the Herdr app's home, where pins and mods live (default ~/.config/herdr-app)
  CANVAS_SIDECAR_PORT   the canvas sidecar's port (default 3077)
  HERDR_DRAW_BUN        the bun that runs the sidecar and board commands (default: this bun, ~/.bun/bin/bun, PATH)
  HERDR_DRAW_DEBUG      0 turns debug log lines off (on by default)
  HERDR_DRAW_LOGS       log folder (default $XDG_STATE_HOME/herdr-draw/logs)
  HERDR_DRAW_BOARDS     where boards are saved (default $XDG_STATE_HOME/herdr-draw/boards)
  XDG_STATE_HOME        base of the two above (default ~/.local/state)
  for install.sh (the curl | sh bootstrap):
  HERDR_DRAW_REPO       the git URL to clone
  HERDR_DRAW_HOME       where the clone lives (default ~/.local/share/herdr-draw)
`;

/** The overview only: each group's details are behind `herdr-draw <group> help`. */
const help = () => process.stdout.write(HELP);

/** The groups (see lib/args.mjs: each parses its own argv) and the global options. */
export function program() {
  const cli = cac("herdr-draw");
  cli.option("-h, --help", "help").option("-V, --version", "version");
  for (const g of ["mermaid", "canvas", "open", "install", "uninstall", "doctor", "logs", "bridge", "help"])
    cli.command(g).allowUnknownOptions();
  return cli;
}

// argv (without node and script) -> the function to run, or null for an unknown command.
export function route(argv) {
  const [group, ...rest] = argv;
  // Only the first word: the rest is the group's to parse.
  const { cmd, options } = parse(program(), argv.slice(0, 1));
  if (!cmd) {
    if (options.version) return version;
    return group === undefined || options.help ? help : null;
  }
  if (cmd === "help" && rest.length && rest[0] !== "help") return route([rest[0], "--help", ...rest.slice(1)]);
  return {
    mermaid: () => mermaid(rest),
    canvas: (env) => canvas(rest, env),
    open: (env) => canvas(["open", ...rest], env),
    install: (env) => setup(cmd, rest, env),
    uninstall: (env) => setup(cmd, rest, env),
    doctor: (env) => setup(cmd, rest, env),
    logs: (env) => logs(rest, env),
    // Internal: the main machine runs this here over hc to reach this machine's boards.
    bridge: rest.length === 1 && rest[0] === "endpoint" ? (env) => bridgeEndpoint(env) : null,
    help,
  }[cmd];
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
  try {
    await run(process.env);
  } catch (e) {
    // cac's usage errors (unknown option, missing or extra argument): exit 2 like an unknown command.
    if (e?.name !== "CACError") throw e;
    process.stderr.write(`herdr-draw ${process.argv[2]}: ${e.message} (see herdr-draw ${process.argv[2]} --help)\n`);
    process.exitCode = 2;
  }
}

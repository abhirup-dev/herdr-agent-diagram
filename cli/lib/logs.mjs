// herdr-draw logs: the last lines of every component's log (cli, sidecar, endpoint, install, mods), merged by time,
// here or on a synced machine. Files: src/log/log.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cac } from "cac";
import { logDir } from "../../src/log/log.mjs";
import { parse } from "./args.mjs";

export const HELP = `herdr-draw logs: recent log lines from every part of herdr-draw, merged by time.

usage: herdr-draw logs [component] [-n lines] [--machine name] [--path]

  component         cli, sidecar, endpoint, install, mod (all mods), mod-excal-canvas, ... (default: all)
  -n LINES          lines per component (default 100)
  --machine NAME    read them on a synced machine instead (over hc)
  --path            only print where the logs are
  help, -h, --help  this text

Logs live in $HERDR_DRAW_LOGS (default \${XDG_STATE_HOME:-~/.local/state}/herdr-draw/logs) and, for the mods,
$HERDR_APP_HOME/data/herdr-draw/logs. HERDR_DRAW_DEBUG=0 turns debug lines off.
`;

/** The logs group's options (see args.mjs). */
export function program() {
  const cli = cac("herdr-draw logs");
  cli.option("-h, --help", "help");
  cli
    .command("[component]")
    .option("-n <lines>", "lines per component")
    .option("--machine <name>", "a synced machine")
    .option("--path", "only the log folders");
  return cli;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const { args, options } = parse(program(), argv);
  return {
    component: args[0] ?? null,
    n: Number(options.n) || 100,
    machine: options.machine ?? null,
    path: Boolean(options.path),
    help: Boolean(options.help) || args[0] === "help",
  };
}

/** Last `n` lines of each matching log file in `dir`, merged and sorted by their ISO timestamp. */
export function collect(dirs, n, component) {
  const files = dirs.flatMap((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".log") && (!component || f.startsWith(component)))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  });
  const lines = files.flatMap((f) => fs.readFileSync(f, "utf8").trimEnd().split("\n").slice(-n));
  return lines.filter(Boolean).sort();
}

/** Mods can only write under the Herdr app home, so their logs live there. */
const modLogDir = (env) =>
  path.join(env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app"), "data/herdr-draw/logs");

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
export function logs(argv, env) {
  const o = parseArgs(argv);
  if (o.help) return process.stdout.write(HELP);
  if (o.machine) {
    const args = ["logs", ...(o.component ? [o.component] : []), "-n", String(o.n), ...(o.path ? ["--path"] : [])];
    const r = spawnSync(
      "hc",
      ["exec", "--on", o.machine, "--timeout", "30", "sh", "-c", `"$HOME/.local/bin/herdr-draw" ${args.join(" ")}`],
      {
        stdio: "inherit",
      },
    );
    process.exitCode = r.status ?? 1;
    return;
  }
  const dir = logDir(env);
  if (o.path) return console.log(`${dir}\n${modLogDir(env)}`);
  const lines = collect([dir, modLogDir(env)], o.n, o.component);
  console.log(lines.length ? lines.join("\n") : `no logs yet in ${dir}`);
}

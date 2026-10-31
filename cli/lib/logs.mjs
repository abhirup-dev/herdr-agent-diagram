// herdr-draw logs: the last lines of every component's log (cli, sidecar, endpoint, install, mods), merged by time,
// here or on a synced machine. Files: src/log/log.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logDir } from "../../src/log/log.mjs";

export const HELP = `herdr-draw logs: recent log lines from every part of herdr-draw, merged by time.

usage: herdr-draw logs [component] [-n lines] [--machine name] [--path]

  component   cli, sidecar, endpoint, install, mod (all mods), mod-excal-canvas, ... (default: all)
  -n          lines per component (default 100)
  --machine   read them on a synced machine instead (over hc)
  --path      only print where the logs are
`;

/** @param {string[]} argv */
function parse(argv) {
  /** @type {{ n: number, machine: string | null, component: string | null, path: boolean }} */
  const o = { n: 100, machine: null, component: null, path: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n") o.n = Number(argv[++i]) || o.n;
    else if (a === "--machine") o.machine = argv[++i] ?? null;
    else if (a === "--path") o.path = true;
    else o.component = a ?? null;
  }
  return o;
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
  if (argv[0] === "help" || argv[0] === "--help") return process.stdout.write(HELP);
  const o = parse(argv);
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

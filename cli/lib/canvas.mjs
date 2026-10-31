// herdr-draw canvas: the live Excalidraw canvas as a pane to the right of this agent's terminal.
// One piece: the herdr-draw sidecar (bun src/sidecar/main.ts on $CANVAS_SIDECAR_PORT). It owns every board on this
// machine: board REST at /b/<board>/api (board = this terminal's id), and the excal-canvas mod's websocket.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logDir, logger } from "../../src/log/log.mjs";

const log = logger("cli");
const REPO = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "../..");
const SIDECAR_SERVICE = "herdr-draw-sidecar";

export const HELP = `herdr-draw canvas: the live Excalidraw canvas, as a native pane beside this terminal.

usage: herdr-draw canvas <command>

  open        show the canvas beside this terminal (starts what it needs); each run adds a pane
  start       only start the sidecar
  status      JSON health of the sidecar and its boards
  <other>     a command on this terminal's board: add, apply, update, delete, get, query, describe,
              screenshot, export, import, snapshot, arrange, clear
`;

const port = (env) => Number(env.CANVAS_SIDECAR_PORT ?? 3077);
/** This terminal's board: its terminal id when path-safe (src/canvas/protocol.ts isLocalBoardId), else "default". */
const boardId = (env) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(env.HC_TERMINAL_ID ?? "") ? env.HC_TERMINAL_ID : "default";
const urls = (env) => {
  const sidecar = `http://127.0.0.1:${port(env)}`;
  return { sidecar, board: `${sidecar}/b/${boardId(env)}` };
};

const die = (msg) => {
  process.stderr.write(`herdr-draw canvas: ${msg}\n`);
  process.exit(1);
};
const reachable = (url) =>
  fetch(url).then(
    () => true,
    () => false,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, what) {
  for (let i = 0; i < 40; i++) {
    if (await reachable(url)) return;
    await sleep(250);
  }
  die(`${what} did not come up (${url})`);
}

/** True when the herdr-draw sidecar (not an older canvas sidecar or anything else) answers on the port. */
const sidecarUp = (env) =>
  fetch(`${urls(env).sidecar}/health`)
    .then((r) => r.json())
    .then(
      (j) => j?.service === SIDECAR_SERVICE,
      () => false,
    );

/**
 * A bun that runs: HERDR_DRAW_BUN, this process when it is bun, then the usual install places, then PATH. Each is
 * tried with --version, since a version-manager shim on PATH can fail (mise without a trust record).
 */
function bunBin(env) {
  const candidates = [
    env.HERDR_DRAW_BUN,
    process.versions.bun ? process.execPath : undefined,
    path.join(os.homedir(), ".bun/bin/bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    "bun",
  ];
  const ok = candidates.find((c) => c && spawnSync(c, ["--version"], { stdio: "ignore", env }).status === 0);
  if (!ok) die("bun not found: install it (https://bun.sh) or set HERDR_DRAW_BUN");
  return ok;
}

// Every board command other than open/start/status: the board CLI (src/board/cli.ts) against this terminal's board.
// Like the upstream CLI it starts the sidecar first (except for `stop`, a no-op on the shared sidecar).
export async function boardCli(argv, env) {
  if (argv[0] !== "stop") await ensureBackend(env);
  const r = spawnSync(bunBin(env), [path.join(REPO, "src/board/cli.ts"), ...argv], {
    stdio: "inherit",
    env: { ...env, EXPRESS_SERVER_URL: urls(env).board },
  });
  if (r.error) die(r.error.message);
  return r.status ?? 1;
}

// Starts the sidecar if it is down. Something else holding the port is an error, not "up".
export async function ensureBackend(env) {
  if (await sidecarUp(env)) return;
  log(`sidecar on :${port(env)} is down: starting it`);
  const { sidecar } = urls(env);
  if (await reachable(sidecar))
    die(`port ${port(env)} is taken by something other than ${SIDECAR_SERVICE} (an older canvas sidecar?)`);
  // The sidecar logs to its own file (src/log); this one only catches what it prints before that works.
  const out = path.join(logDir(env), `sidecar-${port(env)}.out`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, "a");
  spawn(bunBin(env), [path.join(REPO, "src/sidecar/main.ts")], {
    cwd: REPO,
    env: { ...env, CANVAS_SIDECAR_PORT: String(port(env)) },
    detached: true,
    stdio: ["ignore", fd, fd],
  }).unref();
  await waitFor(`${sidecar}/health`, `herdr-draw sidecar (log: ${path.join(logDir(env), "sidecar.log")})`);
  log("sidecar is up");
}

export async function status(env) {
  const { sidecar, board } = urls(env);
  const health = await fetch(`${sidecar}/health`)
    .then((r) => r.json())
    .catch(() => null);
  const up = health?.service === SIDECAR_SERVICE;
  return {
    sidecar: { url: sidecar, up, pid: up ? health.pid : null },
    board: { id: boardId(env), url: board },
    boards: up ? health.boards : [],
  };
}

/** True where the Herdr app runs. Elsewhere (a machine the app reaches over hc) the app opens views for us. */
export const appHere = (env) => spawnSync("sh", ["-c", "command -v herdr-app"], { stdio: "ignore", env }).status === 0;

/**
 * Asks the Herdr app on the person's main machine to act for this terminal: an hc label on it, which that machine's
 * sidecar follows (`hc events`). The value changes on every call so each one is an event.
 */
export function signal(env, what) {
  const terminal = env.HC_TERMINAL_ID;
  if (!terminal) return false;
  const r = spawnSync("hc", ["label", terminal, `herdr-draw.${what}=${Date.now()}`], { encoding: "utf8", env });
  log(`signal ${what} on ${terminal}: ${r.status === 0 ? "sent" : `failed (${r.status}) ${String(r.stderr).trim()}`}`);
  return r.status === 0;
}

/** On another machine: start this machine's sidecar and ask the app to open the canvas beside this terminal. */
async function openRemote(env) {
  await ensureBackend(env);
  if (!signal(env, "canvas")) die("could not reach the Herdr app (no $HC_TERMINAL_ID, or hc failed)");
  console.log(`asked the Herdr app to open the canvas beside ${env.HC_TERMINAL_ID}: ${urls(env).board}`);
}

/** The remote end of a bridge (src/bridge/endpoint.ts), run by the main machine over hc; starts the sidecar first. */
export async function bridgeEndpoint(env) {
  await ensureBackend(env);
  const bun = bunBin(env);
  log("bridge endpoint starting");
  const r = spawnSync(bun, [path.join(REPO, "src/bridge/endpoint.ts")], {
    stdio: "inherit",
    env: {
      ...env,
      CANVAS_SIDECAR_PORT: String(port(env)),
      // The endpoint restarts the sidecar with this if it dies while boards are followed.
      HERDR_DRAW_ENSURE: JSON.stringify([bun, path.join(REPO, "cli/herdr-draw.mjs"), "canvas", "start"]),
    },
  });
  log(`bridge endpoint exited (${r.status})`);
  process.exitCode = r.status ?? 1;
}

export async function open(env) {
  if (!appHere(env)) return openRemote(env);
  await ensureBackend(env);
  // Split this agent's pane, not whichever pane has focus. shortcut: splits every time (mod panes are not
  // listed by `herdr-app ls`, so an open canvas can't be detected); run it once per session.
  const terminal = env.HC_TERMINAL_ID;
  const ls = JSON.parse(execFileSync("herdr-app", ["ls"], { encoding: "utf8", env }));
  const pane = ls.spaces
    .flatMap((s) => s.tabs)
    .flatMap((t) => t.terminals)
    .find((t) => t.terminal === terminal)?.pane;
  const props = { board: boardId(env), port: port(env) };
  const args = { direction: "right", mod: "excal-canvas", props, ...(pane ? { pane } : {}) };
  // Marks this terminal as drawing: the diagram-pane header then shows a canvas badge that reopens the pane.
  if (terminal) {
    const dir = path.join(
      env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app"),
      "data/herdr-agent-diagram",
      terminal,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "canvas.json"), JSON.stringify({ opened: new Date().toISOString() }));
  }
  log(`open: pane.split ${JSON.stringify(args)}`);
  execFileSync("herdr-app", ["do", "pane.split", JSON.stringify(args)], { stdio: "inherit", env });
  console.log(`canvas open${pane ? ` beside ${terminal}` : " beside the focused pane"}: ${urls(env).board}`);
}

export async function canvas(argv, env) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help") return process.stdout.write(HELP);
  if (cmd === "open") return open(env).catch((e) => die(e.message));
  if (cmd === "start") return ensureBackend(env).catch((e) => die(e.message));
  if (cmd === "status") return console.log(JSON.stringify(await status(env), null, 2));
  process.exitCode = await boardCli([cmd, ...rest], env);
}

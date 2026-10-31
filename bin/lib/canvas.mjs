// herdr-draw canvas: the live Excalidraw canvas as a pane to the right of this agent's terminal.
// One piece: the herdr-draw sidecar (bun src/sidecar/main.ts on $CANVAS_SIDECAR_PORT). It owns every board on this
// machine: board REST at /b/<board>/api (board = this terminal's id), and the excal-canvas mod's websocket.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
export function boardCli(argv, env) {
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
  const { sidecar } = urls(env);
  if (await reachable(sidecar))
    die(`port ${port(env)} is taken by something other than ${SIDECAR_SERVICE} (an older canvas sidecar?)`);
  const log = path.join(os.tmpdir(), `herdr-draw-sidecar-${port(env)}.log`);
  const fd = fs.openSync(log, "a");
  spawn(bunBin(env), [path.join(REPO, "src/sidecar/main.ts")], {
    cwd: REPO,
    env: { ...env, CANVAS_SIDECAR_PORT: String(port(env)) },
    detached: true,
    stdio: ["ignore", fd, fd],
  }).unref();
  await waitFor(`${sidecar}/health`, `herdr-draw sidecar (log: ${log})`);
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

export async function open(env) {
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
  execFileSync("herdr-app", ["do", "pane.split", JSON.stringify(args)], { stdio: "inherit", env });
  console.log(`canvas open${pane ? ` beside ${terminal}` : " beside the focused pane"}: ${urls(env).board}`);
}

export async function canvas(argv, env) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help") return process.stdout.write(HELP);
  if (cmd === "open") return open(env).catch((e) => die(e.message));
  if (cmd === "start") return ensureBackend(env).catch((e) => die(e.message));
  if (cmd === "status") return console.log(JSON.stringify(await status(env), null, 2));
  process.exitCode = boardCli([cmd, ...rest], env);
}

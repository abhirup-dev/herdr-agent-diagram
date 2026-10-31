// herdr-draw canvas: the live Excalidraw canvas as a pane to the right of this agent's terminal.
// Pieces: the canvas server (mcp-excalidraw-server, REST on $EXPRESS_SERVER_URL) and the canvas sidecar
// (bun src/sidecar/main.ts on $CANVAS_SIDECAR_PORT, which feeds the excal-canvas mod and answers screenshots).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "../..");
// shortcut: assumes the dependency is installed under this package (not hoisted); resolve it properly once we publish.
const SERVER_BIN = path.join(REPO, "node_modules/.bin/mcp-excalidraw-server");

export const HELP = `herdr-draw canvas: the live Excalidraw canvas, as a native pane beside this terminal.

usage: herdr-draw canvas <command>

  open        show the canvas beside this terminal (starts what it needs); each run adds a pane
  start       only start the canvas server and sidecar
  status      JSON health of the server, the sidecar and the board
  <other>     passed to the board CLI (mcp-excalidraw-server), e.g. describe, screenshot
`;

const urls = (env) => ({
  server: (env.EXPRESS_SERVER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, ""),
  sidecar: `http://127.0.0.1:${env.CANVAS_SIDECAR_PORT ?? 3077}`,
});

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

// Every board command other than open/start/status goes through here (agent B swaps the body for the board CLI).
export function boardCli(argv, env) {
  const r = spawnSync(SERVER_BIN, argv, { stdio: "inherit", env: { ...env, EXPRESS_SERVER_URL: urls(env).server } });
  if (r.error) die(r.error.message);
  return r.status ?? 1;
}

// Starts whatever of the canvas server and the sidecar is down.
export async function ensureBackend(env) {
  const { server, sidecar } = urls(env);
  if (!(await reachable(`${server}/api/elements`))) {
    // `start` takes its port from EXPRESS_SERVER_URL
    execFileSync(SERVER_BIN, ["start"], {
      env: { ...env, EXPRESS_SERVER_URL: server },
      stdio: ["ignore", "ignore", "inherit"],
    });
    await waitFor(`${server}/api/elements`, "canvas server");
  }
  if (!(await reachable(sidecar))) {
    const log = path.join(os.tmpdir(), `herdr-draw-sidecar-${new URL(sidecar).port}.log`);
    const fd = fs.openSync(log, "a");
    spawn("bun", [path.join(REPO, "src/sidecar/main.ts")], {
      cwd: REPO,
      env: { ...env, EXPRESS_SERVER_URL: server },
      detached: true,
      stdio: ["ignore", fd, fd],
    }).unref();
    await waitFor(sidecar, `canvas sidecar (log: ${log})`);
  }
}

export async function status(env) {
  const { server, sidecar } = urls(env);
  const elements = await fetch(`${server}/api/elements`)
    .then((r) => r.json())
    .then((j) => j.count)
    .catch(() => undefined);
  return {
    server: { url: server, up: elements !== undefined },
    sidecar: { url: sidecar, up: await reachable(sidecar) },
    board: elements === undefined ? null : { elements },
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
  const args = { direction: "right", mod: "excal-canvas", ...(pane ? { pane } : {}) };
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
  console.log(`canvas open${pane ? ` beside ${terminal}` : " beside the focused pane"}: ${urls(env).server}`);
}

export async function canvas(argv, env) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help") return process.stdout.write(HELP);
  if (cmd === "open") return open(env).catch((e) => die(e.message));
  if (cmd === "start") return ensureBackend(env).catch((e) => die(e.message));
  if (cmd === "status") return console.log(JSON.stringify(await status(env), null, 2));
  process.exitCode = boardCli([cmd, ...rest], env);
}

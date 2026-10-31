#!/usr/bin/env node
// herdr-canvas open: show the live Excalidraw canvas in a pane to the right of this agent's terminal.
// Makes sure the pieces run first: the canvas server (the excalidraw skill's own `mcp-excalidraw-server start`)
// and the canvas sidecar (bun src/sidecar/main.ts, which feeds the excal-canvas mod and answers screenshots).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "..");
const SERVER = (process.env.EXPRESS_SERVER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SIDECAR = `http://127.0.0.1:${process.env.CANVAS_SIDECAR_PORT ?? 3077}`;
const LOG = path.join(os.tmpdir(), "herdr-canvas-sidecar.log");

const die = (msg) => {
  process.stderr.write(`herdr-canvas: ${msg}\n`);
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

async function start() {
  if (!(await reachable(`${SERVER}/api/elements`))) {
    execFileSync("npx", ["-y", "mcp-excalidraw-server", "start"], { stdio: ["ignore", "ignore", "inherit"] });
    await waitFor(`${SERVER}/api/elements`, "canvas server");
  }
  if (!(await reachable(SIDECAR))) {
    const log = fs.openSync(LOG, "a");
    spawn("bun", [path.join(REPO, "src/sidecar/main.ts")], {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
    await waitFor(SIDECAR, `canvas sidecar (log: ${LOG})`);
  }
}

async function open() {
  await start();
  // Split this agent's pane, not whichever pane has focus. shortcut: splits every time (mod panes are not
  // listed by `herdr-app ls`, so an open canvas can't be detected); run it once per session.
  const terminal = process.env.HC_TERMINAL_ID;
  const tabs = JSON.parse(execFileSync("herdr-app", ["ls"], { encoding: "utf8" })).spaces.flatMap((s) => s.tabs);
  const pane = tabs.flatMap((t) => t.terminals).find((t) => t.terminal === terminal)?.pane;
  const args = { direction: "right", mod: "excal-canvas", ...(pane ? { pane } : {}) };
  // Marks this terminal as drawing: the diagram-pane header then shows a canvas badge that reopens the pane.
  if (terminal) {
    const dir = path.join(
      process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app"),
      "data/herdr-agent-diagram",
      terminal,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "canvas.json"), JSON.stringify({ opened: new Date().toISOString() }));
  }
  execFileSync("herdr-app", ["do", "pane.split", JSON.stringify(args)], { stdio: "inherit" });
  console.log(`canvas open${pane ? ` beside ${terminal}` : " beside the focused pane"}: ${SERVER}`);
}

const cmd = process.argv[2];
if (cmd === "open") open().catch((e) => die(e.message));
else if (cmd === "start") start().catch((e) => die(e.message));
else {
  console.log(`usage: herdr-canvas open    show the live Excalidraw canvas beside this terminal (starts what it needs)
       herdr-canvas start   only start the canvas server and sidecar`);
  process.exit(cmd && cmd !== "help" ? 2 : 0);
}

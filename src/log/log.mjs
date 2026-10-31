// herdr-draw's logs: one file per component per machine, so a problem can be traced across the CLI, the sidecar,
// the bridge and the other machine (`herdr-draw logs`, `herdr-draw logs --machine vpsme`).
//   $HERDR_DRAW_LOGS, default ${XDG_STATE_HOME:-~/.local/state}/herdr-draw/logs/<component>.log
// Debug lines are on by default while herdr-draw is young; HERDR_DRAW_DEBUG=0 turns them off.
// Plain JS (with JSDoc types) so the Node/Bun CLI and the Bun sidecar share it. The mods log on their own: their
// runtime has no fs append (src/canvas-mod/log.ts, mods/*).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Debug logging, on unless HERDR_DRAW_DEBUG=0. shortcut: on by default for now; flip the default once stable. */
export const DEBUG = process.env.HERDR_DRAW_DEBUG !== "0";
const MAX_BYTES = 5 << 20;

export const logDir = (env = process.env) =>
  env.HERDR_DRAW_LOGS ?? path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "herdr-draw", "logs");

/**
 * @typedef {((msg: string) => void) & { debug: (msg: string) => void, file: string }} Logger
 */

/** @type {Map<string, Logger>} */
const loggers = new Map();

/**
 * A component's logger: `log(msg)` always writes, `log.debug(msg)` only when DEBUG. Never throws.
 * @param {string} component
 * @returns {Logger}
 */
export function logger(component) {
  const existing = loggers.get(component);
  if (existing) return existing;
  const file = path.join(logDir(), `${component}.log`);
  const prefix = `${os.hostname().split(".")[0]} ${component}[${process.pid}]`;
  let ready = false;
  /** @param {string} level @param {string} msg */
  const write = (level, msg) => {
    try {
      if (!ready) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Rotate once per process: the previous file is kept as .1.
        if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) fs.renameSync(file, `${file}.1`);
        ready = true;
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${prefix} ${level} ${msg}\n`);
    } catch {
      // logging must never break the program
    }
  };
  const log = /** @type {Logger} */ ((msg) => write("info ", msg));
  log.debug = (msg) => {
    if (DEBUG) write("debug", msg);
  };
  log.file = file;
  loggers.set(component, log);
  return log;
}

/** Short, single-line form of a value for a log line. @param {unknown} v @param {number} [max] */
export const brief = (v, max = 300) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
};

// Mermaid pins across machines. `herdr-draw mermaid` keeps a terminal's pins in
//   <app home>/data/herdr-agent-diagram/<terminal>/state.json  (+ the SVG files it names, relative to the app home)
// which the diagram-pane and diagram-popup mods read. On another machine there is no app to read them, so:
//   - that machine's sidecar serves them to a subscriber as pin messages (servePins), and
//   - the main machine's sidecar writes what it receives into its own app home under <machine>/<terminal>
//     (PinMirror), where the mods find them for that remote terminal's pane.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pin, PinMessage } from "../bridge/protocol.ts";
import { brief, logger } from "../log/log.mjs";

const log = logger("sidecar");

const DATA = "data/herdr-agent-diagram";
export const appHome = () => process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app");

interface StoredPin {
  id: string;
  title: string;
  mmd: string;
  rev: number;
  svg: string;
  type?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}
interface State {
  rev: number;
  next: number;
  tabs: { name: string; pins: StoredPin[] }[];
}

const readState = (dir: string): State | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as State;
  } catch {
    return null;
  }
};

/** A terminal's pins as messages' Pin objects, SVG inlined. */
export function readPins(home: string, terminal: string): Pin[] {
  const state = readState(path.join(home, DATA, terminal));
  if (!state) return [];
  return state.tabs.flatMap((t) =>
    t.pins.flatMap((p): Pin[] => {
      let svg: string;
      try {
        svg = fs.readFileSync(path.join(home, p.svg), "utf8");
      } catch {
        return [];
      }
      const { id, title, mmd: source, rev, type, width, height } = p;
      return [{ id, title, svg, source, updated: Date.now(), tab: t.name, rev, type, width, height }];
    }),
  );
}

/**
 * Sends the terminal's pins now and again whenever its pin folder changes, until the returned stop is called.
 * shortcut: always sends the whole list (`pins`), not per-pin updates; fine for a handful of diagrams.
 */
export function servePins(home: string, terminal: string, send: (m: PinMessage) => void): () => void {
  const dir = path.join(home, DATA, terminal);
  fs.mkdirSync(dir, { recursive: true });
  let last = "";
  const push = () => {
    const pins = readPins(home, terminal);
    const key = JSON.stringify(pins.map((p) => [p.id, p.rev, p.tab, p.title]));
    if (key === last) return;
    last = key;
    log.debug(`pins: serving ${terminal}: ${pins.length} pin(s) ${brief(pins.map((p) => `${p.id}@${p.rev}`))}`);
    send({ type: "pins", pins });
  };
  push();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(dir, () => {
    clearTimeout(timer);
    timer = setTimeout(push, 100);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

/** Writes one remote terminal's pins into this app home, in the layout `herdr-draw mermaid` uses locally. */
export class PinMirror {
  readonly #pins = new Map<string, Pin>();
  #rev = 0;

  constructor(
    private readonly home: string,
    /** Machine-qualified terminal, "vpsme/t1f": the folder the mods read for that pane. */
    private readonly terminal: string,
  ) {}

  apply(m: PinMessage): void {
    if (m.type === "pins") {
      this.#pins.clear();
      for (const p of m.pins) this.#pins.set(p.id, p);
    } else if (m.type === "pin") this.#pins.set(m.pin.id, m.pin);
    else this.#pins.delete(m.id);
    this.#write();
  }

  #write(): void {
    const rel = path.posix.join(DATA, this.terminal);
    const dir = path.join(this.home, rel);
    fs.mkdirSync(dir, { recursive: true });
    const tabs: State["tabs"] = [];
    for (const p of this.#pins.values()) {
      const rev = p.rev ?? 1;
      const svg = path.posix.join(rel, `${p.id}-r${rev}.svg`);
      fs.writeFileSync(path.join(this.home, svg), p.svg);
      const name = p.tab ?? "Diagrams";
      let tab = tabs.find((t) => t.name === name);
      if (!tab) {
        tab = { name, pins: [] };
        tabs.push(tab);
      }
      tab.pins.push({
        id: p.id,
        title: p.title,
        mmd: p.source,
        rev,
        svg,
        type: p.type,
        width: p.width,
        height: p.height,
      });
    }
    const state: State = {
      rev: ++this.#rev + Math.max(0, ...[...this.#pins.values()].map((p) => p.rev ?? 0)),
      next: 1,
      tabs,
    };
    const tmp = path.join(dir, ".state.json.tmp");
    log.debug(`pins: mirrored ${this.terminal}: ${this.#pins.size} pin(s) in ${tabs.length} tab(s) -> ${rel}`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, path.join(dir, "state.json"));
    for (const f of fs.readdirSync(dir))
      if (f.endsWith(".svg") && !tabs.some((t) => t.pins.some((p) => p.svg.endsWith(`/${f}`))))
        fs.rmSync(path.join(dir, f));
  }
}

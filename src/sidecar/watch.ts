// On the main machine (the one running the Herdr app): follows terminals on the machines `herdr-draw install`
// synced, through `hc events`. An agent there labels its own terminal (cli/lib/canvas.mjs signal):
//   herdr-draw.canvas=<time>  open the canvas beside that terminal here
//   herdr-draw.pins=<time>    it pinned Mermaid diagrams: mirror them here (kept followed from then on)
// The relay dials a machine only when one of these first needs it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readLines } from "../bridge/ndjson.ts";
import type { BoardServerMessage, PinMessage } from "../bridge/protocol.ts";
import { brief, logger } from "../log/log.mjs";
import { appHome, PinMirror } from "./pins.ts";
import type { Relay } from "./relay.ts";

const debug = logger("sidecar").debug;

type Log = (msg: string) => void;
type Labels = Readonly<Record<string, string>>;
type HcLine = {
  terminals?: { address: string; labels?: Labels }[];
  params?: { type?: string; terminal?: string; data?: { labels?: Labels } };
};

/** Machines `herdr-draw install` synced, from its state file in the app home; none: nothing to follow. */
export function syncedMachines(home = appHome()): string[] {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, "data/herdr-draw/install.json"), "utf8"));
    return Object.keys(s.machines ?? {});
  } catch {
    return [];
  }
}

const PIN_TYPES = new Set(["pins", "pin", "unpin"]);

export class RemoteWatch {
  readonly #canvas = new Map<string, string>();
  readonly #mirrors = new Map<string, PinMirror>();
  readonly #machines: Set<string>;

  constructor(
    machines: readonly string[],
    private readonly relay: Relay,
    private readonly port: number,
    private readonly log: Log,
    private readonly home = appHome(),
  ) {
    this.#machines = new Set(machines);
  }

  #ours(address: string | undefined): address is string {
    const machine = address?.split("/")[0];
    return Boolean(address?.includes("/") && machine && this.#machines.has(machine));
  }

  /** One `hc events` line: the first is a snapshot of every terminal, then events. */
  onLine(raw: string): void {
    let line: HcLine;
    try {
      line = JSON.parse(raw) as HcLine;
    } catch {
      return;
    }
    for (const t of line.terminals ?? []) if (this.#ours(t.address)) this.#labels(t.address, t.labels ?? {}, true);
    const p = line.params;
    if (line.terminals) debug(`watch: hc events snapshot, ${line.terminals.length} terminal(s)`);
    if (p?.type === "labels" && this.#ours(p.terminal)) {
      const ours = Object.entries(p.data?.labels ?? {}).filter(([k]) => k.startsWith("herdr-draw."));
      debug(`watch: labels on ${p.terminal}: ${brief(Object.fromEntries(ours))}`);
      this.#labels(p.terminal, p.data?.labels ?? {}, false);
    }
  }

  #labels(address: string, labels: Labels, snapshot: boolean): void {
    if (labels["herdr-draw.pins"] !== undefined) this.followPins(address);
    const canvas = labels["herdr-draw.canvas"];
    if (canvas === undefined || this.#canvas.get(address) === canvas) return;
    this.#canvas.set(address, canvas);
    this.#marker(address);
    // A snapshot only records what was asked before this sidecar started: reopening it would be a surprise.
    if (!snapshot) this.openCanvas(address);
  }

  /** The diagram-pane header shows a canvas badge for terminals with this marker. */
  #marker(address: string): void {
    const dir = path.join(this.home, "data/herdr-agent-diagram", address);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "canvas.json"), JSON.stringify({ opened: new Date().toISOString() }));
  }

  followPins(address: string): void {
    if (this.#mirrors.has(address)) return;
    const mirror = new PinMirror(this.home, address);
    this.#mirrors.set(address, mirror);
    this.log(`following ${address} pins`);
    this.relay.subscribe(
      {
        send: (text) => {
          const msg = (JSON.parse(text) as { msg: BoardServerMessage }).msg;
          if (PIN_TYPES.has(msg.type)) mirror.apply(msg as PinMessage);
        },
      },
      address,
    );
  }

  openCanvas(address: string): void {
    try {
      const ls = JSON.parse(execFileSync("herdr-app", ["ls"], { encoding: "utf8" })) as {
        spaces: { tabs: { terminals: { terminal: string; pane: string }[] }[] }[];
      };
      const pane = ls.spaces
        .flatMap((s) => s.tabs)
        .flatMap((t) => t.terminals)
        .find((t) => t.terminal === address)?.pane;
      if (!pane) {
        this.log(`canvas for ${address}: no pane shows it here`);
        return;
      }
      const args = { pane, direction: "right", mod: "excal-canvas", props: { board: address, port: this.port } };
      execFileSync("herdr-app", ["do", "pane.split", JSON.stringify(args)], { stdio: "ignore" });
      this.log(`opened the canvas beside ${address}`);
    } catch (e) {
      this.log(`canvas for ${address} failed: ${String(e)}`);
    }
  }

  /** Follows `hc events` until the sidecar exits; restarts it if it ends. */
  start(): void {
    const run = () => {
      const proc = Bun.spawn(["hc", "events", "--json"], { stdout: "pipe", stderr: "ignore" });
      void (async () => {
        for await (const line of readLines(proc.stdout)) this.onLine(line);
      })();
      void proc.exited.then((code) => {
        this.log(`watch: hc events ended (exit ${code}), restarting in 2 s`);
        setTimeout(run, 2000);
      });
    };
    run();
    this.log(`following machines: ${[...this.#machines].join(", ")}`);
  }
}

// Boards on other machines (ids like "vpsme/t1f"): the sidecar relays them through one Bridge per machine
// (src/bridge), opened on the first subscribe and kept while anyone follows a board there. The remote end is
// `herdr-draw bridge endpoint`, which `herdr-draw install --machines` put on that machine.
import { hostname } from "node:os";
import { Bridge, hcLinkArgv, spawnPty } from "../bridge/bridge.ts";
import type { BoardServerMessage } from "../bridge/protocol.ts";
import { type ClientMessage, frame, splitBoard } from "../canvas/protocol.ts";
import { logger } from "../log/log.mjs";
import type { Viewer } from "./boards.ts";

const log = logger("sidecar");

/** Runs on the other machine; its own herdr-draw starts that machine's sidecar if needed. */
const REMOTE_LINE = '"$HOME/.local/bin/herdr-draw" bridge endpoint';

/**
 * One endpoint per local core: two relays sharing one would mix their input (src/bridge/README.md).
 * hc names allow 1-32 of a-z 0-9 - _ . only.
 */
const linkName = () =>
  `herdr-draw-${hostname()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")}`.slice(0, 32);

export type MakeBridge = (machine: string) => Bridge;
const defaultBridge: MakeBridge = (machine) =>
  new Bridge({
    machine,
    argv: hcLinkArgv(machine, linkName(), REMOTE_LINE),
    spawn: spawnPty,
    log: (msg) => log(`bridge ${machine}: ${msg}`),
  });

export class Relay {
  readonly #bridges = new Map<string, Bridge>();
  readonly #subs = new Map<Viewer, Map<string, () => void>>();

  constructor(private readonly makeBridge: MakeBridge = defaultBridge) {}

  #bridge(id: string): [Bridge, string] {
    const { machine, local: board } = splitBoard(id);
    if (machine === null) throw new Error(`not a remote board: ${id}`);
    let b = this.#bridges.get(machine);
    if (!b) {
      log(`relay: first use of ${machine}, making its bridge`);
      b = this.makeBridge(machine);
      this.#bridges.set(machine, b);
    }
    return [b, board];
  }

  /** Frames for `id` go to the viewer under the qualified id, as for a local board. Idempotent per viewer. */
  subscribe(v: Viewer, id: string): void {
    const subs = this.#subs.get(v) ?? new Map<string, () => void>();
    this.#subs.set(v, subs);
    if (subs.has(id)) return;
    log.debug(`relay: subscribe ${id}`);
    const [bridge, board] = this.#bridge(id);
    subs.set(
      id,
      bridge.subscribe(board, (m: BoardServerMessage) => {
        if (m.type !== "preview")
          log.debug(`relay: ${id} -> ${m.type}${m.type === "status" ? ` ${m.upstream} ${m.detail ?? ""}` : ""}`);
        v.send(frame(id, m));
      }),
    );
  }

  /** One board, or every board of the viewer (its socket closed). The Bridge closes its link after the last. */
  unsubscribe(v: Viewer, id?: string): void {
    const subs = this.#subs.get(v);
    if (!subs) return;
    for (const [key, off] of subs)
      if (id === undefined || key === id) {
        log.debug(`relay: unsubscribe ${key}`);
        off();
        subs.delete(key);
      }
    if (!subs.size) this.#subs.delete(v);
  }

  send(id: string, msg: ClientMessage): void {
    if (msg.type !== "preview") log.debug(`relay: ${id} <- ${msg.type}`);
    const [bridge, board] = this.#bridge(id);
    bridge.send(board, msg);
  }

  close(): void {
    for (const b of this.#bridges.values()) b.close();
    this.#bridges.clear();
    this.#subs.clear();
  }
}

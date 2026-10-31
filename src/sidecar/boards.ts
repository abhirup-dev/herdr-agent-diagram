// Every board this sidecar owns: its elements (the board store), the converted scene the mods see, its undo
// history, and the mod sockets subscribed to it. Boards are created on first use (REST or subscribe) and live
// in memory for the life of the process. The SDK conversion is injected, so this is unit-tested without it.
import type { BoardInfo, Boards } from "../board/http.ts";
import { Board } from "../board/store.ts";
import { type ClientMessage, frame, type ServerMessage, splitBoard } from "../canvas/protocol.ts";
import type { CanvasElement } from "../canvas/types.ts";
import { logger } from "../log/log.mjs";
import { diff, type RawElement } from "./diff.ts";
import { Writer } from "./writer.ts";

const debug = logger("sidecar").debug;

/** Writes a board to disk after it changes (src/sidecar/save.ts). */
export interface Saver {
  schedule(board: string, elements: () => readonly object[]): void;
}

/** Boards on other machines (src/sidecar/relay.ts). */
export interface Remote {
  subscribe(v: Viewer, id: string): void;
  unsubscribe(v: Viewer, id?: string): void;
  send(id: string, msg: Exclude<ClientMessage, { type: "preview" | "subscribe" | "unsubscribe" }>): void;
}

/** A mod socket (or a relay's); it receives board frames as JSON text. */
export interface Viewer {
  send(data: string): void;
}

/** Raw board elements -> what the mod draws. */
export type Convert = (raw: readonly RawElement[]) => Promise<CanvasElement[]>;

type Log = (msg: string) => void;

class Live {
  readonly store = new Board(() => {
    void this.reconvert();
    this.saver?.schedule(this.id, () => [...this.store.elements.values()]);
  });
  readonly viewers = new Set<Viewer>();
  readonly writer: Writer;
  prepared = new Map<string, CanvasElement>();
  rev = 0;
  private converting: Promise<void> | null = null;
  private dirty = false;

  constructor(
    readonly id: string,
    private readonly convert: Convert,
    private readonly log: Log,
    private readonly saver?: Saver,
  ) {
    const s = this.store;
    this.writer = new Writer(
      {
        create: async (el) => s.create(el),
        update: async (id, fields) => s.update(id, fields),
        remove: async (id) => s.remove(id),
        get: async (id) => s.elements.get(id) ?? null,
      },
      {
        raw: () => s.elements as Map<string, RawElement>,
        prepared: (id) => this.prepared.get(id) as Readonly<Record<string, unknown>> | undefined,
      },
      (canUndo, canRedo) => this.broadcast({ type: "history", canUndo, canRedo }),
    );
  }

  broadcast(m: ServerMessage): void {
    const data = frame(this.id, m);
    for (const v of this.viewers) v.send(data);
  }

  /** What a newly subscribed mod needs: status, the whole scene, the history buttons. */
  hello(v: Viewer): void {
    const send = (m: ServerMessage) => v.send(frame(this.id, m));
    send({ type: "status", upstream: "connected" });
    send({ type: "scene", rev: this.rev, elements: [...this.prepared.values()] });
    send({ type: "history", canUndo: this.writer.canUndo, canRedo: this.writer.canRedo });
  }

  /** Converts raw -> prepared and broadcasts the difference. One conversion at a time; the latest state wins. */
  reconvert(): Promise<void> {
    this.dirty = true;
    this.converting ??= this.loop().finally(() => {
      this.converting = null;
    });
    return this.converting;
  }

  private async loop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const t0 = performance.now();
      try {
        const next = await this.convert([...this.store.elements.values()]);
        const patch = diff(this.prepared, next);
        this.prepared = new Map(next.map((e) => [e.id, e]));
        if (!patch.upsert.length && !patch.remove.length) continue;
        this.rev++;
        this.broadcast({ type: "patch", rev: this.rev, upsert: patch.upsert, remove: patch.remove });
        const ms = (performance.now() - t0).toFixed(1);
        this.log(`${this.id} rev ${this.rev}: ${patch.upsert.length} up, ${patch.remove.length} removed (${ms} ms)`);
      } catch (e) {
        this.log(`${this.id} conversion failed: ${String(e)}`);
      }
    }
  }
}

export class Registry implements Boards {
  private readonly live = new Map<string, Live>();
  private readonly subscribed = new Map<Viewer, Set<Live>>();

  constructor(
    private readonly convert: Convert,
    private readonly log: Log = () => {},
    private readonly relay?: Remote,
    private readonly saver?: Saver,
  ) {}

  get(id: string): Live {
    let b = this.live.get(id);
    if (!b) {
      b = new Live(id, this.convert, this.log, this.saver);
      this.live.set(id, b);
      this.log(`board ${id} created`);
    }
    return b;
  }

  board(id: string): Board {
    return this.get(id).store;
  }

  info(id: string): BoardInfo {
    const b = this.get(id);
    return { id, elements: b.store.elements.size, viewers: b.viewers.size };
  }

  list(): BoardInfo[] {
    return [...this.live.keys()].map((id) => this.info(id));
  }

  /** Sends a socket the board's full state, then its changes. A socket may follow several boards (a relay does). */
  subscribe(v: Viewer, id: string): void {
    const { machine } = splitBoard(id);
    debug(
      `board ${id}: subscribe${machine !== null ? (this.relay ? " (remote, via relay)" : " (remote, no relay)") : ""}`,
    );
    if (machine !== null) {
      if (this.relay) {
        this.relay.subscribe(v, id);
        return;
      }
      const m: ServerMessage = { type: "status", upstream: "disconnected", detail: `no relay to ${machine}` };
      v.send(frame(id, m));
      return;
    }
    const b = this.get(id);
    b.viewers.add(v);
    this.subscribed.set(v, (this.subscribed.get(v) ?? new Set()).add(b));
    b.hello(v);
  }

  /** Stops one board's frames to the socket, or all of them (the socket closed). */
  unsubscribe(v: Viewer, id?: string): void {
    debug(`board ${id ?? "*"}: unsubscribe`);
    if (id === undefined || splitBoard(id).machine !== null) this.relay?.unsubscribe(v, id);
    for (const b of this.subscribed.get(v) ?? []) {
      if (id !== undefined && b.id !== id) continue;
      b.viewers.delete(v);
      this.subscribed.get(v)?.delete(b);
    }
    if (!this.subscribed.get(v)?.size) this.subscribed.delete(v);
  }

  /** Edits from a mod. `preview` is answered by the caller (it needs the paint generator). */
  onClient(v: Viewer, board: string, m: Exclude<ClientMessage, { type: "preview" }>): Promise<void> {
    if (m.type === "subscribe") return Promise.resolve(this.subscribe(v, board));
    if (m.type === "unsubscribe") return Promise.resolve(this.unsubscribe(v, board));
    if (splitBoard(board).machine !== null) return Promise.resolve(this.relay?.send(board, m));
    const { writer } = this.get(board);
    if (m.type === "ops") return writer.apply(m.ops);
    return m.type === "undo" ? writer.undo() : writer.redo();
  }
}

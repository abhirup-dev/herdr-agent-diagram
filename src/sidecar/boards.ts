// Every board this sidecar owns: its elements (the board store), the converted scene the mods see, its undo
// history, and the mod sockets subscribed to it. Boards are created on first use (REST or subscribe) and live
// in memory for the life of the process. The SDK conversion is injected, so this is unit-tested without it.
import type { BoardInfo, Boards } from "../board/http.ts";
import { Board } from "../board/store.ts";
import { type ClientMessage, DEFAULT_BOARD, type ServerMessage, splitBoard } from "../canvas/protocol.ts";
import type { CanvasElement } from "../canvas/types.ts";
import { diff, type RawElement } from "./diff.ts";
import { Writer } from "./writer.ts";

/** A mod socket. */
export interface Viewer {
  send(data: string): void;
}

/** Raw board elements -> what the mod draws. */
export type Convert = (raw: readonly RawElement[]) => Promise<CanvasElement[]>;

type Log = (msg: string) => void;

class Live {
  readonly store = new Board(() => void this.reconvert());
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
      (canUndo, canRedo) => this.broadcast({ type: "history", board: this.id, canUndo, canRedo }),
    );
  }

  broadcast(m: ServerMessage): void {
    const data = JSON.stringify(m);
    for (const v of this.viewers) v.send(data);
  }

  /** What a newly subscribed mod needs: status, the whole scene, the history buttons. */
  hello(v: Viewer): void {
    const b = this.id;
    v.send(JSON.stringify({ type: "status", board: b, upstream: "connected" } satisfies ServerMessage));
    v.send(JSON.stringify({ type: "scene", board: b, rev: this.rev, elements: [...this.prepared.values()] }));
    const { canUndo, canRedo } = this.writer;
    v.send(JSON.stringify({ type: "history", board: b, canUndo, canRedo } satisfies ServerMessage));
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
        this.broadcast({ type: "patch", board: this.id, rev: this.rev, upsert: patch.upsert, remove: patch.remove });
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
  private readonly subscribed = new Map<Viewer, Live>();

  constructor(
    private readonly convert: Convert,
    private readonly log: Log = () => {},
  ) {}

  get(id: string): Live {
    let b = this.live.get(id);
    if (!b) {
      b = new Live(id, this.convert, this.log);
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

  /** Points a mod socket at one board (it leaves the previous one). */
  subscribe(v: Viewer, id: string): void {
    this.unsubscribe(v);
    const { machine } = splitBoard(id);
    if (machine !== null) {
      // shortcut: boards on other machines need the relay (hd-jf3.7); until then the mod shows "server down".
      const m: ServerMessage = {
        type: "status",
        board: id,
        upstream: "disconnected",
        detail: `no relay to ${machine}`,
      };
      v.send(JSON.stringify(m));
      return;
    }
    const b = this.get(id || DEFAULT_BOARD);
    b.viewers.add(v);
    this.subscribed.set(v, b);
    b.hello(v);
  }

  unsubscribe(v: Viewer): void {
    this.subscribed.get(v)?.viewers.delete(v);
    this.subscribed.delete(v);
  }

  /** Edits from a mod. `preview` is answered by the caller (it needs the paint generator). */
  onClient(v: Viewer, m: Exclude<ClientMessage, { type: "preview" }>): Promise<void> {
    if (m.type === "subscribe") return Promise.resolve(this.subscribe(v, m.board));
    if (splitBoard(m.board).machine !== null) return Promise.resolve();
    const { writer } = this.get(m.board);
    if (m.type === "ops") return writer.apply(m.ops);
    return m.type === "undo" ? writer.undo() : writer.redo();
  }
}

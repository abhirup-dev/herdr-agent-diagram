// The relay side: one Bridge per remote machine spawns the machine's link (ssh, or its hc `--via` command) running
// the remote endpoint, and multiplexes all that machine's boards over the pipe. `Mux` routes machine-qualified
// board ids (`vpsme/t1f`) to a Bridge and unqualified ones to the local backend: one interface for both.
import type { ClientMessage } from "../canvas/protocol.ts";
import { type Clock, realClock } from "./clock.ts";
import { encode, LineDecoder, readLines } from "./ndjson.ts";
import { type BoardServerMessage, type DownFrame, parseDownFrame, splitBoardId, type UpFrame } from "./protocol.ts";

export type Listener = (msg: BoardServerMessage) => void;

/** What the frontend side talks to, local or remote. `subscribe` returns its unsubscribe. */
export interface Backend {
  subscribe(board: string, listener: Listener): () => void;
  send(board: string, msg: ClientMessage): void;
}

/** A running link process: lines out of its stdout, lines into its stdin. */
export interface Link {
  write(text: string): void;
  readonly lines: AsyncIterable<string>;
  kill(): void;
}
export type Spawn = (argv: readonly string[]) => Link;

export const spawnLink: Spawn = (argv) => {
  const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  return {
    write(text) {
      proc.stdin.write(text);
      proc.stdin.flush();
    },
    lines: readLines(proc.stdout),
    kill: () => proc.kill(),
  };
};

/** Lines pushed from a callback, read as an async iterable. */
class LineQueue implements AsyncIterable<string> {
  #items: string[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  push(lines: readonly string[]): void {
    this.#items.push(...lines);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) yield next;
      else if (this.#ended) return;
      else await new Promise<void>((r) => (this.#wake = r));
    }
  }
}

/** Like spawnLink, under a pseudo-terminal: `hc attach` needs one. */
export const spawnPty: Spawn = (argv) => {
  const lines = new LineQueue();
  const dec = new LineDecoder();
  const term = new Bun.Terminal({ cols: 200, rows: 50, data: (_t, d) => lines.push(dec.push(d)) });
  const proc = Bun.spawn([...argv], { terminal: term });
  void proc.exited.then(() => lines.end());
  return {
    write: (text) => term.write(text),
    lines,
    kill() {
      proc.kill();
      term.close();
    },
  };
};

const shq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The hc-native link (run with spawnPty): makes sure terminal `name` on `machine` runs `remoteLine` with its tty in
 * raw mode, then attaches to it. The remote program outlives dropped links; reattaching takes ~40 ms.
 * `name` must be unique per local core: two relays attached to one endpoint would mix their input.
 */
export function hcLinkArgv(machine: string, name: string, remoteLine: string): string[] {
  const run = ["hc", "run", "--on", machine, "--bg", "--rm", "--no-parent", "--name", name, "--", "sh", "-c"];
  const start = [...run, `stty raw -echo; exec ${remoteLine}`].map(shq).join(" ");
  // `hc run` fails with name_taken when the endpoint already runs: attach to it anyway.
  return ["sh", "-c", `${start} >/dev/null 2>&1; exec hc attach ${shq(`${machine}/${name}`)}`];
}

/**
 * Fallback link (run with spawnLink): argv that runs `remoteLine` on a machine from `hc machine ls --json`, over ssh
 * or the machine's --via command, as hc itself does. Keepalives are short: the user's ssh config may only notice a
 * dead link after minutes. A ControlMaster in the user's ssh config is reused as ssh always does.
 */
export function linkArgv(m: { readonly target: string; readonly via: boolean }, remoteLine: string): string[] {
  // shortcut: assumes hc keeps a --via machine's command in `target` (not observable on vpsme, an ssh machine); verify with a real --via machine.
  if (m.via) return ["sh", "-c", `${m.target} ${shq(remoteLine)}`];
  const opts = ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"];
  return ["ssh", ...opts, m.target, remoteLine];
}

export interface BridgeOptions {
  readonly machine: string;
  readonly argv: readonly string[];
  readonly spawn?: Spawn;
  readonly clock?: Clock;
  readonly pingMs?: number;
  /** No frame for this long: the link is hung, kill it. */
  readonly deadMs?: number;
  readonly backoffMs?: readonly [min: number, max: number];
}

/** Ops wait for a live link; previews are moment-to-moment and dropped while down. */
const queueable = (m: ClientMessage) => m.type !== "preview";

export class Bridge implements Backend {
  readonly #o: Required<BridgeOptions>;
  readonly #listeners = new Map<string, Set<Listener>>();
  #queue: UpFrame[] = [];
  #link: Link | undefined;
  #live = false;
  #attempt = 0;
  #lastFrame = 0;
  /** When the current link started: frames before the pong to a ping sent since then are stale. */
  #since = 0;
  #sentN = 0;
  #recvN: number | undefined;
  #cancel: (() => void) | undefined;

  constructor(options: BridgeOptions) {
    this.#o = {
      spawn: spawnLink,
      clock: realClock,
      pingMs: 5000,
      deadMs: 15000,
      backoffMs: [500, 30000],
      ...options,
    };
  }

  get connected(): boolean {
    return this.#live;
  }

  subscribe(board: string, listener: Listener): () => void {
    let set = this.#listeners.get(board);
    if (!set) {
      set = new Set();
      this.#listeners.set(board, set);
      if (this.#link) this.#write({ kind: "board", board, msg: { type: "subscribe" } });
      else if (!this.#cancel) this.#connect();
    }
    set.add(listener);
    return () => {
      if (!set.delete(listener) || set.size) return;
      this.#listeners.delete(board);
      this.#write({ kind: "board", board, msg: { type: "unsubscribe" } });
      if (!this.#listeners.size) this.close();
    };
  }

  send(board: string, msg: ClientMessage): void {
    const f: UpFrame = { kind: "board", board, msg };
    if (this.#live) this.#write(f);
    else if (queueable(msg)) this.#queue.push(f);
  }

  /** Drops the link and stops reconnecting; a later subscribe starts again. */
  close(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#listeners.clear();
    this.#queue = [];
    this.#drop();
  }

  #write(f: UpFrame): void {
    const link = this.#link;
    try {
      link?.write(encode({ ...f, n: this.#sentN++ }));
    } catch {
      if (link) this.#lost(link, "write failed");
    }
  }

  #connect(): void {
    this.#cancel = undefined;
    const link = this.#o.spawn(this.#o.argv);
    this.#link = link;
    this.#lastFrame = this.#o.clock.now();
    this.#since = this.#lastFrame;
    this.#sentN = 0;
    this.#recvN = undefined;
    this.#beat(link); // the ping goes first, so its pong precedes every reply to the subscribes
    this.#subscribeAll();
    void this.#read(link);
  }

  #beat(link: Link): void {
    if (this.#link !== link) return;
    if (this.#o.clock.now() - this.#lastFrame > this.#o.deadMs) {
      this.#lost(link, "no answer");
      return;
    }
    this.#write({ kind: "ping", t: this.#o.clock.now() });
    this.#cancel = this.#o.clock.after(this.#o.pingMs, () => this.#beat(link));
  }

  async #read(link: Link): Promise<void> {
    try {
      for await (const line of link.lines) {
        if (this.#link !== link) return;
        const f = parseDownFrame(line);
        if (!f) continue;
        this.#lastFrame = this.#o.clock.now();
        if (!this.#fresh(f)) continue;
        if (f.kind === "board") for (const l of this.#listeners.get(f.board) ?? []) l(f.msg);
      }
    } catch {
      // the stream failed: same as its end
    }
    this.#lost(link, "link closed");
  }

  /** False for frames an hc attach repaints: old ones before the fresh pong, or ones seen already after a re-dial. */
  #fresh(f: DownFrame): boolean {
    if (!this.#live) {
      if (f.kind !== "pong" || f.t < this.#since) return false;
      this.#up();
    }
    if (f.n !== undefined && this.#recvN !== undefined) {
      if (f.n <= this.#recvN) return false;
      if (f.n > this.#recvN + 1) this.#subscribeAll(); // frames were lost
    }
    this.#recvN = f.n ?? this.#recvN;
    return true;
  }

  /** Each backend answers a subscribe with the board's full state. */
  #subscribeAll(): void {
    for (const board of this.#listeners.keys()) this.#write({ kind: "board", board, msg: { type: "subscribe" } });
  }

  #up(): void {
    this.#live = true;
    this.#attempt = 0;
    const queued = this.#queue;
    this.#queue = [];
    for (const f of queued) this.#write(f);
  }

  #lost(link: Link, detail: string): void {
    if (this.#link !== link) return;
    this.#drop();
    this.#emitStatus(`${this.#o.machine}: ${detail}`);
    if (!this.#listeners.size) return;
    const [min, max] = this.#o.backoffMs;
    const wait = Math.min(max, min * 2 ** this.#attempt++);
    this.#cancel?.();
    this.#cancel = this.#o.clock.after(wait, () => this.#connect());
  }

  #drop(): void {
    const link = this.#link;
    this.#link = undefined;
    this.#live = false;
    link?.kill();
  }

  #emitStatus(detail: string): void {
    const msg: BoardServerMessage = { type: "status", upstream: "disconnected", detail };
    for (const set of this.#listeners.values()) for (const l of set) l(msg);
  }
}

/** Routes `machine/board` ids to one Bridge per machine (made on first use), plain ids to `local`. */
export class Mux implements Backend {
  readonly #bridges = new Map<string, Bridge>();

  constructor(
    private readonly local: Backend,
    private readonly makeBridge: (machine: string) => Bridge,
  ) {}

  #route(id: string): [Backend, string] {
    const { machine, board } = splitBoardId(id);
    if (!machine) return [this.local, board];
    let b = this.#bridges.get(machine);
    if (!b) {
      b = this.makeBridge(machine);
      this.#bridges.set(machine, b);
    }
    return [b, board];
  }

  subscribe(id: string, listener: Listener): () => void {
    const [backend, board] = this.#route(id);
    return backend.subscribe(board, listener);
  }

  send(id: string, msg: ClientMessage): void {
    const [backend, board] = this.#route(id);
    backend.send(board, msg);
  }

  close(): void {
    for (const b of this.#bridges.values()) b.close();
    this.#bridges.clear();
  }
}

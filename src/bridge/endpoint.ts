// The remote end of a bridge: runs on the agent's machine as the link's command, relays frames between the pipe
// (stdin/stdout) and that machine's own sidecar, one websocket per subscribed board. Writes to the pipe merge
// while it is busy (Coalescer). Exits on stdin EOF or when pings stop (a hung link sends no EOF).
//   bun endpoint.ts ['ws://127.0.0.1:3077/']   (normally through `herdr-draw bridge endpoint`, which starts the sidecar)
import type { ClientMessage } from "../canvas/protocol.ts";
import { type Clock, realClock } from "./clock.ts";
import { Coalescer } from "./coalesce.ts";
import { encode, readLines } from "./ndjson.ts";
import { type BoardClientMessage, type BoardServerMessage, type DownFrame, parseUpFrame } from "./protocol.ts";

/** One board's connection to the local sidecar. `send` may be called before it opens. */
export interface BoardSocket {
  send(msg: ClientMessage): void;
  close(): void;
}
export type Connect = (board: string, onMessage: (m: BoardServerMessage) => void, onClose: () => void) => BoardSocket;

export interface EndpointOptions {
  readonly lines: AsyncIterable<string>;
  /** Resolves once the pipe took it (backpressure). */
  readonly write: (text: string) => void | Promise<void>;
  readonly connect: Connect;
  readonly clock?: Clock;
  readonly idleMs?: number;
  readonly retryMs?: number;
  readonly log?: (msg: string) => void;
  /** Called before reconnecting to a sidecar that closed: restarts it if it died. */
  readonly ensureSidecar?: () => void;
}

class Outbox {
  readonly #pending = new Coalescer();
  #busy = false;

  constructor(
    private readonly write: EndpointOptions["write"],
    private readonly stamp: (f: DownFrame) => string,
    private readonly log: (msg: string) => void,
  ) {}

  push(board: string, msg: BoardServerMessage): void {
    this.#pending.push(board, msg);
    if (!this.#busy) void this.#pump();
  }

  async #pump(): Promise<void> {
    this.#busy = true;
    try {
      while (!this.#pending.empty) {
        const drained = this.#pending.drain();
        const text = drained.map(({ board, msg }) => this.stamp({ kind: "board", board, msg })).join("");
        const shown = drained
          .filter(({ msg }) => msg.type !== "preview")
          .map(({ board, msg }) => `${board} ${msg.type}`);
        if (shown.length) this.log(`-> ${shown.join(", ")} (${text.length} bytes)`);
        // A write that never finishes stalls every later board frame (pongs bypass this queue): say so.
        const since = Date.now();
        const slow = setTimeout(() => this.log(`stdout write of ${text.length} bytes still pending after 5 s`), 5000);
        await this.write(text);
        clearTimeout(slow);
        if (Date.now() - since > 5000) this.log(`stdout write finished after ${Date.now() - since} ms`);
      }
    } finally {
      this.#busy = false;
    }
  }
}

export async function runEndpoint(o: EndpointOptions): Promise<void> {
  const clock = o.clock ?? realClock;
  const idleMs = o.idleMs ?? 20000;
  let n = 0;
  const stamp = (f: DownFrame) => encode({ ...f, n: n++ });
  const log = o.log ?? (() => {});
  const out = new Outbox(o.write, stamp, log);
  const boards = new Map<string, BoardSocket>();
  let lastUp: number | undefined;

  const open = (board: string): void => {
    log(`board ${board}: opening a socket to the sidecar`);
    const sock = o.connect(
      board,
      (m) => out.push(board, m),
      () => {
        if (boards.get(board) !== sock) return;
        log(`board ${board}: sidecar closed the socket; retrying`);
        out.push(board, { type: "status", upstream: "disconnected", detail: "sidecar closed" });
        clock.after(o.retryMs ?? 1000, () => {
          if (boards.get(board) !== sock) return;
          o.ensureSidecar?.();
          open(board);
        });
      },
    );
    boards.set(board, sock);
  };

  const onBoard = (board: string, msg: BoardClientMessage) => {
    if (msg.type !== "preview") log(`board ${board} <- ${msg.type}`);
    if (msg.type === "subscribe") {
      boards.get(board)?.close();
      open(board);
    } else if (msg.type === "unsubscribe") {
      const sock = boards.get(board);
      boards.delete(board);
      sock?.close();
    } else boards.get(board)?.send(msg);
  };

  const reopenAll = () => {
    for (const [board, sock] of [...boards]) {
      sock.close();
      open(board);
    }
  };

  let timedOut = () => {};
  const idle = new Promise<void>((resolve) => {
    timedOut = resolve;
  });
  let cancelIdle = clock.after(idleMs, timedOut);
  const touch = () => {
    cancelIdle();
    cancelIdle = clock.after(idleMs, timedOut);
  };

  const relay = (async () => {
    for await (const line of o.lines) {
      const f = parseUpFrame(line);
      if (!f) continue;
      touch();
      // Up frames were lost (a relay starting over sends 0): reopening a board resends its full state.
      if (f.n !== undefined && f.n !== 0 && lastUp !== undefined && f.n !== lastUp + 1) {
        log(`up frames ${lastUp + 1}..${f.n - 1} lost: reopening every board`);
        reopenAll();
      }
      lastUp = f.n ?? lastUp;
      if (f.kind === "ping") {
        await o.write(stamp({ kind: "pong", t: f.t }));
        continue;
      }
      onBoard(f.board, f.msg);
    }
  })();

  log("started");
  const why = await Promise.race([
    relay.then(() => "the link closed (stdin EOF)"),
    idle.then(() => `no frames for ${idleMs} ms`),
  ]);
  log(`exiting: ${why}`);
  cancelIdle();
  for (const sock of boards.values()) sock.close();
  boards.clear();
}

/** A board websocket to the local sidecar; messages sent before it opens wait. */
/** One websocket per board to this machine's sidecar (`url`, its root), speaking its board frames. */
export function wsConnect(url: string): Connect {
  return (board, onMessage, onClose) => {
    const ws = new WebSocket(url);
    const early: string[] = [JSON.stringify({ kind: "board", board, msg: { type: "subscribe" } })];
    ws.onopen = () => {
      for (const t of early.splice(0)) ws.send(t);
    };
    ws.onmessage = (e) => {
      try {
        const f = JSON.parse(String(e.data)) as { kind?: unknown; board?: unknown; msg?: BoardServerMessage };
        if (f.kind === "board" && f.board === board && f.msg) onMessage(f.msg);
      } catch {
        // not JSON: ignore
      }
    };
    ws.onclose = onClose;
    return {
      send(msg) {
        const t = JSON.stringify({ kind: "board", board, msg });
        if (ws.readyState === WebSocket.OPEN) ws.send(t);
        else early.push(t);
      },
      close() {
        ws.onclose = null;
        ws.close();
      },
    };
  };
}

if (import.meta.main) {
  const port = process.env.CANVAS_SIDECAR_PORT ?? "3077";
  const url = process.argv[2] ?? `ws://127.0.0.1:${port}/`;
  // stdout and stderr are the link (a pty): logs go to a file only.
  const { logger } = await import("../log/log.mjs");
  const log = logger("endpoint");
  const ensure = process.env.HERDR_DRAW_ENSURE ? (JSON.parse(process.env.HERDR_DRAW_ENSURE) as string[]) : null;
  const sink = Bun.stdout.writer();
  await runEndpoint({
    lines: readLines(Bun.stdin.stream()),
    write: async (text) => {
      sink.write(text);
      await sink.flush();
    },
    connect: wsConnect(url),
    log,
    ...(ensure ? { ensureSidecar: () => void Bun.spawnSync(ensure, { stdout: "ignore", stderr: "ignore" }) } : {}),
  });
  process.exit(0);
}

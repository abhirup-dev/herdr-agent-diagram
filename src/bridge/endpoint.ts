// The remote end of a bridge: runs on the agent's machine as the link's command, relays frames between the pipe
// (stdin/stdout) and that machine's own sidecar, one websocket per subscribed board. Writes to the pipe merge
// while it is busy (Coalescer). Exits on stdin EOF or when pings stop (a hung link sends no EOF).
//   bun endpoint.ts ['ws://127.0.0.1:3077/b/{board}/ws']
import type { ClientMessage } from "../canvas/protocol.ts";
import { type Clock, realClock } from "./clock.ts";
import { Coalescer } from "./coalesce.ts";
import { encode, readLines } from "./ndjson.ts";
import { type BoardServerMessage, type DownFrame, parseUpFrame } from "./protocol.ts";

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
}

class Outbox {
  readonly #pending = new Coalescer();
  #busy = false;

  constructor(private readonly write: EndpointOptions["write"]) {}

  push(board: string, msg: BoardServerMessage): void {
    this.#pending.push(board, msg);
    if (!this.#busy) void this.#pump();
  }

  async #pump(): Promise<void> {
    this.#busy = true;
    try {
      while (!this.#pending.empty) {
        const frames = this.#pending.drain().map(({ board, msg }): DownFrame => ({ kind: "board", board, msg }));
        await this.write(frames.map(encode).join(""));
      }
    } finally {
      this.#busy = false;
    }
  }
}

export async function runEndpoint(o: EndpointOptions): Promise<void> {
  const clock = o.clock ?? realClock;
  const idleMs = o.idleMs ?? 20000;
  const out = new Outbox(o.write);
  const boards = new Map<string, BoardSocket>();

  const open = (board: string): void => {
    const sock = o.connect(
      board,
      (m) => out.push(board, m),
      () => {
        if (boards.get(board) !== sock) return;
        out.push(board, { type: "status", upstream: "disconnected", detail: "sidecar closed" });
        clock.after(o.retryMs ?? 1000, () => boards.get(board) === sock && open(board));
      },
    );
    boards.set(board, sock);
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
      if (f.kind === "ping") {
        await o.write(encode({ kind: "pong", t: f.t } satisfies DownFrame));
        continue;
      }
      const { board, msg } = f;
      if (msg.type === "subscribe") {
        boards.get(board)?.close();
        open(board);
      } else if (msg.type === "unsubscribe") {
        const sock = boards.get(board);
        boards.delete(board);
        sock?.close();
      } else boards.get(board)?.send(msg);
    }
  })();

  await Promise.race([relay, idle]);
  cancelIdle();
  for (const sock of boards.values()) sock.close();
  boards.clear();
}

/** A board websocket to the local sidecar; messages sent before it opens wait. */
export function wsConnect(template: string): Connect {
  return (board, onMessage, onClose) => {
    const ws = new WebSocket(template.replace("{board}", encodeURIComponent(board)));
    const early: string[] = [];
    ws.onopen = () => {
      for (const t of early.splice(0)) ws.send(t);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as BoardServerMessage);
      } catch {
        // not JSON: ignore
      }
    };
    ws.onclose = onClose;
    return {
      send(msg) {
        const t = JSON.stringify(msg);
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
  const template = process.argv[2] ?? `ws://127.0.0.1:${port}/b/{board}/ws`;
  const sink = Bun.stdout.writer();
  await runEndpoint({
    lines: readLines(Bun.stdin.stream()),
    write: async (text) => {
      sink.write(text);
      await sink.flush();
    },
    connect: wsConnect(template),
  });
  process.exit(0);
}

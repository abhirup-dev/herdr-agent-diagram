import { describe, expect, test } from "bun:test";
import { Bridge, type Link, linkArgv, Mux } from "../src/bridge/bridge.ts";
import type { Clock } from "../src/bridge/clock.ts";
import { Coalescer } from "../src/bridge/coalesce.ts";
import { type BoardSocket, runEndpoint } from "../src/bridge/endpoint.ts";
import { encode, LineDecoder, MAX_LINE } from "../src/bridge/ndjson.ts";
import {
  type BoardServerMessage,
  parseDownFrame,
  parseUpFrame,
  qualify,
  splitBoardId,
  type UpFrame,
} from "../src/bridge/protocol.ts";
import type { ClientMessage, ServerMessage } from "../src/canvas/protocol.ts";
import { applyMessage, emptyScene } from "../src/canvas/scene.ts";
import type { CanvasElement } from "../src/canvas/types.ts";

const el = (id: string, x = 0) => ({ id, x, index: null }) as unknown as CanvasElement;
const tick = () => Bun.sleep(0);

class FakeClock implements Clock {
  t = 0;
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  now = () => this.t;
  after(ms: number, fn: () => void) {
    const timer = { at: this.t + ms, fn, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.#timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = next.at;
      next.live = false;
      next.fn();
      await tick();
    }
    this.t = end;
    await tick();
  }
}

/** An async line stream fed by hand. */
class Channel implements AsyncIterable<string> {
  #items: string[] = [];
  #wake?: () => void;
  #ended = false;
  push(text: string) {
    this.#items.push(...text.split("\n").filter(Boolean));
    this.#wake?.();
  }
  end() {
    this.#ended = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.#items.length) yield this.#items.shift() as string;
      else if (this.#ended) return;
      else await new Promise<void>((r) => (this.#wake = r));
    }
  }
}

/** A fake sidecar on the remote machine: boards with a scene, ops recorded. */
class FakeSidecar {
  ops: { board: string; msg: ClientMessage }[] = [];
  sockets = new Map<string, (m: BoardServerMessage) => void>();
  connect = (board: string, onMessage: (m: BoardServerMessage) => void): BoardSocket => {
    this.sockets.set(board, onMessage);
    queueMicrotask(() => onMessage({ type: "scene", rev: 1, elements: [el(`${board}-a`)] }));
    return { send: (msg) => this.ops.push({ board, msg }), close: () => this.sockets.delete(board) };
  };
}

/** Spawner whose links run the real endpoint in memory against `sidecar`. `drop()` kills the current one. */
function memorySpawner(sidecar: FakeSidecar, clock: Clock) {
  const spawned: { argv: readonly string[]; up: Channel; down: Channel }[] = [];
  const spawn = (argv: readonly string[]): Link => {
    const up = new Channel();
    const down = new Channel();
    spawned.push({ argv, up, down });
    void runEndpoint({ lines: up, write: (t) => down.push(t), connect: sidecar.connect, clock }).then(() => down.end());
    return { write: (t) => up.push(t), lines: down, kill: () => up.end() };
  };
  return { spawn, spawned };
}

describe("bridge ndjson", () => {
  test("splits lines across chunks and UTF-8 sequences", () => {
    const d = new LineDecoder();
    const bytes = new TextEncoder().encode(`${encode({ a: "é" })}${encode({ b: 2 })}`);
    const out = [...d.push(bytes.slice(0, 8)), ...d.push(bytes.slice(8, 20)), ...d.push(bytes.slice(20))];
    expect(out.map((l) => JSON.parse(l))).toEqual([{ a: "é" }, { b: 2 }]);
  });

  test("drops an oversized line whole and keeps the next", () => {
    const d = new LineDecoder();
    expect(d.push("x".repeat(MAX_LINE + 1))).toEqual([]);
    expect(d.push('xx\n{"ok":1}\n')).toEqual(['{"ok":1}']);
  });
});

describe("bridge protocol", () => {
  test("board ids qualify and split", () => {
    expect(splitBoardId("vpsme/t1f")).toEqual({ machine: "vpsme", board: "t1f" });
    expect(splitBoardId("t1f")).toEqual({ board: "t1f" });
    expect(qualify("vpsme", "t1f")).toBe("vpsme/t1f");
    expect(qualify(undefined, "t1f")).toBe("t1f");
  });

  test("parsers accept known frames and reject the rest", () => {
    expect(parseDownFrame('{"kind":"board","board":"t1","msg":{"type":"pins","pins":[]}}')).not.toBeNull();
    expect(parseDownFrame('{"kind":"pong","t":1}')).not.toBeNull();
    expect(parseDownFrame('{"kind":"board","board":"../x","msg":{"type":"scene"}}')).toBeNull();
    expect(parseDownFrame('{"kind":"board","board":"t1","msg":{"type":"ops"}}')).toBeNull();
    expect(parseUpFrame('{"kind":"board","board":"t1","msg":{"type":"subscribe"}}')).not.toBeNull();
    expect(parseUpFrame('{"kind":"ping"}')).toBeNull();
    expect(parseUpFrame("nope")).toBeNull();
  });
});

describe("bridge coalescing", () => {
  const replay = (msgs: readonly ServerMessage[]) => msgs.reduce((s, m) => applyMessage(s, m), emptyScene);
  const ids = (msgs: readonly ServerMessage[]) => replay(msgs).order.map((e) => `${e.id}:${(e as { x: number }).x}`);

  test("merged patches give the same scene as applying each in order", () => {
    const base: ServerMessage = { type: "scene", rev: 1, elements: [el("a"), el("b"), el("c")] };
    const patches: ServerMessage[] = [
      { type: "patch", rev: 2, upsert: [el("d"), el("a", 1)], remove: ["b"] },
      { type: "patch", rev: 3, upsert: [el("b", 2)], remove: ["c", "d"] },
      { type: "patch", rev: 4, upsert: [el("c", 3), el("a", 4)], remove: [] },
    ];
    const c = new Coalescer();
    for (const p of patches) c.push("t1", p);
    const drained = c.drain().map((f) => f.msg as ServerMessage);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ type: "patch", rev: 4 });
    expect(ids([base, ...drained])).toEqual(ids([base, ...patches]));
    expect(c.empty).toBe(true);
  });

  test("a scene absorbs later patches; status and previews keep the latest", () => {
    const c = new Coalescer();
    c.push("t1", { type: "patch", rev: 1, upsert: [el("z")], remove: [] });
    c.push("t1", { type: "status", upstream: "disconnected" });
    c.push("t1", { type: "scene", rev: 2, elements: [el("a"), el("b")] });
    c.push("t1", { type: "patch", rev: 3, upsert: [el("c")], remove: ["a"] });
    c.push("t1", { type: "status", upstream: "connected" });
    c.push("t2", { type: "history", canUndo: true, canRedo: false });
    const out = c.drain();
    expect(out.map((f) => [f.board, f.msg.type])).toEqual([
      ["t1", "scene"],
      ["t1", "status"],
      ["t2", "history"],
    ]);
    expect(out[0]?.msg).toMatchObject({ rev: 3, elements: [{ id: "b" }, { id: "c" }] });
    expect(out[1]?.msg).toMatchObject({ upstream: "connected" });
  });

  test("pins fold into a pending full list, else latest per pin", () => {
    const pin = (id: string, title = id) => ({ id, title, svg: "<svg/>", source: "graph TD", updated: 0 });
    const c = new Coalescer();
    c.push("t1", { type: "pin", pin: pin("p1") });
    c.push("t1", { type: "pin", pin: pin("p1", "new") });
    expect(c.drain().map((f) => f.msg)).toEqual([{ type: "pin", pin: pin("p1", "new") }]);
    c.push("t1", { type: "pins", pins: [pin("p1"), pin("p2")] });
    c.push("t1", { type: "unpin", id: "p1" });
    c.push("t1", { type: "pin", pin: pin("p3") });
    expect(c.drain().map((f) => f.msg)).toEqual([{ type: "pins", pins: [pin("p2"), pin("p3")] }]);
  });
});

describe("bridge link", () => {
  test("ssh and --via machines get the right argv", () => {
    expect(linkArgv({ target: "vpsme", via: false }, "bun x")).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      "vpsme",
      "bun x",
    ]);
    expect(linkArgv({ target: "fly ssh console -a x --pty=false -C", via: true }, "echo 'hi'")).toEqual([
      "sh",
      "-c",
      `fly ssh console -a x --pty=false -C 'echo '\\''hi'\\'''`,
    ]);
  });
});

describe("bridge mux", () => {
  test("mux routes qualified ids to one bridge per machine, plain ids to local", async () => {
    const clock = new FakeClock();
    const sidecar = new FakeSidecar();
    const { spawn, spawned } = memorySpawner(sidecar, clock);
    const subs: string[] = [];
    const local = {
      subscribe(b: string) {
        subs.push(b);
        return () => {};
      },
      send() {},
    };
    const made: string[] = [];
    const mux = new Mux(local, (machine) => {
      made.push(machine);
      return new Bridge({ machine, argv: [machine], spawn, clock });
    });
    const got: [string, BoardServerMessage][] = [];
    mux.subscribe("t0", () => {});
    mux.subscribe("vpsme/t1f", (m) => got.push(["vpsme/t1f", m]));
    mux.subscribe("vpsme/t2", (m) => got.push(["vpsme/t2", m]));
    await tick();
    await tick();
    expect(subs).toEqual(["t0"]);
    expect(made).toEqual(["vpsme"]);
    expect(spawned).toHaveLength(1);
    expect(got.map(([id, m]) => [id, m.type === "scene" && m.elements[0]?.id])).toEqual([
      ["vpsme/t1f", "t1f-a"],
      ["vpsme/t2", "t2-a"],
    ]);
    mux.send("vpsme/t2", { type: "undo" });
    await tick();
    expect(sidecar.ops).toEqual([{ board: "t2", msg: { type: "undo" } }]);
    mux.close();
  });
});

describe("bridge relay", () => {
  test("a dropped link reconnects with backoff, resubscribes and delivers queued ops", async () => {
    const clock = new FakeClock();
    const sidecar = new FakeSidecar();
    const { spawn, spawned } = memorySpawner(sidecar, clock);
    const bridge = new Bridge({ machine: "vpsme", argv: ["x"], spawn, clock, backoffMs: [500, 4000] });
    const got: BoardServerMessage[] = [];
    bridge.subscribe("t1", (m) => got.push(m));
    await tick();
    expect(bridge.connected).toBe(true);

    spawned[0]?.down.end(); // the link dies
    await tick();
    expect(bridge.connected).toBe(false);
    expect(got.at(-1)).toMatchObject({ type: "status", upstream: "disconnected" });
    bridge.send("t1", { type: "ops", ops: [{ op: "remove", ids: ["t1-a"] }] });
    bridge.send("t1", { type: "preview", req: 1, element: el("p") }); // dropped while down
    await clock.advance(499);
    expect(spawned).toHaveLength(1);
    await clock.advance(1);
    expect(spawned).toHaveLength(2);
    await tick();
    expect(bridge.connected).toBe(true);
    expect(got.at(-1)).toMatchObject({ type: "scene", rev: 1 });
    expect(sidecar.ops.map((o) => o.msg.type)).toEqual(["ops"]);
    bridge.close();
  });

  test("backoff doubles up to its cap while the machine stays unreachable", async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    const spawn = (): Link => {
      starts.push(clock.now());
      const down = new Channel();
      down.end();
      return { write() {}, lines: down, kill() {} };
    };
    const bridge = new Bridge({ machine: "m", argv: [], spawn, clock, backoffMs: [500, 2000] });
    bridge.subscribe("t1", () => {});
    await tick();
    await clock.advance(10_000);
    expect(starts.slice(0, 6)).toEqual([0, 500, 1500, 3500, 5500, 7500]);
    bridge.close();
  });
});

describe("bridge heartbeat and backpressure", () => {
  test("a hung link is killed after missed pongs; the endpoint quits when pings stop", async () => {
    const clock = new FakeClock();
    const writes: UpFrame[] = [];
    let killed = 0;
    const spawn = (): Link => ({
      write: (t) => writes.push(JSON.parse(t)),
      lines: new Channel(), // never answers
      kill: () => killed++,
    });
    const bridge = new Bridge({ machine: "m", argv: [], spawn, clock, pingMs: 5000, deadMs: 15000 });
    bridge.subscribe("t1", () => {});
    await clock.advance(15_000);
    expect(killed).toBe(0);
    await clock.advance(5000);
    expect(killed).toBe(1);
    expect(writes.filter((w) => w.kind === "ping").length).toBeGreaterThanOrEqual(3);
    bridge.close();

    let done = false;
    void runEndpoint({
      lines: new Channel(),
      write() {},
      connect: new FakeSidecar().connect,
      clock,
      idleMs: 20000,
    }).then(() => (done = true));
    await clock.advance(19_999);
    expect(done).toBe(false);
    await clock.advance(1);
    expect(done).toBe(true);
  });

  test("the endpoint merges board messages while the pipe is busy", async () => {
    const sidecar = new FakeSidecar();
    const up = new Channel();
    const written: string[] = [];
    let release = () => {};
    const write = (t: string) => {
      written.push(t);
      return new Promise<void>((r) => (release = r));
    };
    void runEndpoint({ lines: up, write, connect: sidecar.connect, clock: new FakeClock() });
    up.push(encode({ kind: "board", board: "t1", msg: { type: "subscribe" } }));
    await tick();
    await tick();
    const emit = sidecar.sockets.get("t1");
    for (let i = 2; i < 50; i++) emit?.({ type: "patch", rev: i, upsert: [el(`e${i}`)], remove: [] });
    release();
    await tick();
    expect(written).toHaveLength(2); // the first scene, then one merged patch
    const merged = parseDownFrame(written[1]?.trim() ?? "");
    expect(merged).toMatchObject({ kind: "board", board: "t1", msg: { type: "patch", rev: 49 } });
    up.end();
  });
});

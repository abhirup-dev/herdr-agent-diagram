import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../cli/lib/install.mjs";
import type { Bridge } from "../src/bridge/bridge.ts";
import type { BoardServerMessage, PinMessage } from "../src/bridge/protocol.ts";
import type { Viewer } from "../src/sidecar/boards.ts";
import { PinMirror, readPins } from "../src/sidecar/pins.ts";
import { Relay } from "../src/sidecar/relay.ts";
import { RemoteWatch } from "../src/sidecar/watch.ts";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "herdr-draw-test-"));

/** A pin state as `herdr-draw mermaid add` writes it. */
function writeLocalPins(home: string, terminal: string): void {
  const rel = `data/herdr-agent-diagram/${terminal}`;
  fs.mkdirSync(path.join(home, rel), { recursive: true });
  fs.writeFileSync(path.join(home, rel, "d1-r2.svg"), "<svg>one</svg>");
  const state = {
    rev: 2,
    next: 2,
    tabs: [
      {
        name: "Auth",
        pins: [
          {
            id: "d1",
            title: "Login",
            mmd: "flowchart TD\n a-->b",
            rev: 2,
            svg: `${rel}/d1-r2.svg`,
            type: "flowchart-v2",
            width: 100,
            height: 200,
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(home, rel, "state.json"), JSON.stringify(state));
}

describe("pins across machines", () => {
  test("a remote terminal's pins land in the local layout the mods read", () => {
    const remote = tmpHome();
    const local = tmpHome();
    writeLocalPins(remote, "t1f");
    const pins = readPins(remote, "t1f");
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ id: "d1", tab: "Auth", svg: "<svg>one</svg>", source: "flowchart TD\n a-->b" });

    const mirror = new PinMirror(local, "vpsme/t1f");
    mirror.apply({ type: "pins", pins });
    const dir = path.join(local, "data/herdr-agent-diagram/vpsme/t1f");
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    expect(state.tabs[0].name).toBe("Auth");
    expect(state.tabs[0].pins[0]).toMatchObject({
      id: "d1",
      title: "Login",
      svg: "data/herdr-agent-diagram/vpsme/t1f/d1-r2.svg",
    });
    expect(fs.readFileSync(path.join(local, state.tabs[0].pins[0].svg), "utf8")).toBe("<svg>one</svg>");

    mirror.apply({ type: "unpin", id: "d1" });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).tabs).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".svg"))).toEqual([]);
  });
});

/** A relay that records subscriptions instead of dialing machines. */
class FakeRelay {
  subs: string[] = [];
  viewers: Viewer[] = [];
  subscribe(v: Viewer, id: string) {
    this.subs.push(id);
    this.viewers.push(v);
  }
}

describe("following remote terminals", () => {
  const event = (terminal: string, labels: Record<string, string>) =>
    JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "labels", terminal, data: { labels } } });

  function watch() {
    const relay = new FakeRelay();
    const home = tmpHome();
    const w = new RemoteWatch(["vpsme"], relay as unknown as Relay, 3077, () => {}, home);
    const opened: string[] = [];
    w.openCanvas = (a) => void opened.push(a);
    return { w, relay, opened, home };
  }

  test("a canvas label opens the canvas once per new value; the startup snapshot only records it", () => {
    const { w, opened, home } = watch();
    w.onLine(JSON.stringify({ terminals: [{ address: "vpsme/t1f", labels: { "herdr-draw.canvas": "1" } }] }));
    expect(opened).toEqual([]);
    expect(fs.existsSync(path.join(home, "data/herdr-agent-diagram/vpsme/t1f/canvas.json"))).toBe(true);
    w.onLine(event("vpsme/t1f", { "herdr-draw.canvas": "1" }));
    w.onLine(event("vpsme/t1f", { "herdr-draw.canvas": "2" }));
    w.onLine(event("vpsme/t1f", { "herdr-draw.canvas": "2", other: "x" }));
    expect(opened).toEqual(["vpsme/t1f"]);
  });

  test("pins are followed once, and only on synced machines", () => {
    const { w, relay, home } = watch();
    w.onLine(event("vpsme/t1f", { "herdr-draw.pins": "1" }));
    w.onLine(event("vpsme/t1f", { "herdr-draw.pins": "2" }));
    w.onLine(event("other/t1", { "herdr-draw.pins": "1" }));
    w.onLine(event("t3", { "herdr-draw.pins": "1" }));
    w.onLine("not json");
    expect(relay.subs).toEqual(["vpsme/t1f"]);
    const pins: PinMessage = { type: "pins", pins: [{ id: "d1", title: "x", svg: "<svg/>", source: "a", updated: 0 }] };
    relay.viewers[0]?.send(JSON.stringify({ kind: "board", board: "vpsme/t1f", msg: pins }));
    expect(fs.existsSync(path.join(home, "data/herdr-agent-diagram/vpsme/t1f/state.json"))).toBe(true);
  });
});

describe("relay", () => {
  test("routes a machine's boards through one bridge, qualifies ids, unsubscribes", () => {
    const made: string[] = [];
    const calls: string[] = [];
    let listener: ((m: BoardServerMessage) => void) | undefined;
    const relay = new Relay((machine) => {
      made.push(machine);
      return {
        subscribe(board: string, l: (m: BoardServerMessage) => void) {
          calls.push(`sub ${board}`);
          listener = l;
          return () => calls.push(`unsub ${board}`);
        },
        send: (board: string, msg: { type: string }) => calls.push(`send ${board} ${msg.type}`),
        close() {},
      } as unknown as Bridge;
    });
    const got: string[] = [];
    const v: Viewer = { send: (t) => got.push(t) };
    relay.subscribe(v, "vpsme/t1f");
    relay.subscribe(v, "vpsme/t1f");
    relay.subscribe(v, "vpsme/t2");
    listener?.({ type: "history", canUndo: true, canRedo: false });
    relay.send("vpsme/t1f", { type: "undo" });
    relay.unsubscribe(v);
    expect(made).toEqual(["vpsme"]);
    expect(calls).toEqual(["sub t1f", "sub t2", "send t1f undo", "unsub t1f", "unsub t2"]);
    expect(JSON.parse(got[0] ?? "{}")).toMatchObject({ kind: "board", board: "vpsme/t2" });
  });
});

describe("install flags", () => {
  test("parses agents, machines and modes", () => {
    expect(parseArgs(["-y", "--agents", "claude,pi", "--machines", "vpsme"])).toEqual({
      yes: true,
      headless: false,
      agents: ["claude", "pi"],
      machines: ["vpsme"],
    });
    expect(parseArgs(["--headless", "--no-machines"])).toMatchObject({ headless: true, machines: [] });
  });
});

describe("board files", () => {
  test("a saved board is a .excalidraw scene with the board's elements", async () => {
    const { BoardSaver } = await import("../src/sidecar/save.ts");
    const dir = tmpHome();
    const saver = new BoardSaver(dir, () => {}, 0);
    saver.write("t1f", [{ id: "a", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }]);
    const scene = JSON.parse(fs.readFileSync(path.join(dir, "t1f.excalidraw"), "utf8"));
    expect(scene).toMatchObject({ type: "excalidraw", version: 2, source: "herdr-draw" });
    expect(scene.elements.map((e: { id: string }) => e.id)).toContain("a");
  });
});

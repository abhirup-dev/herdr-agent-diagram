import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STYLE,
  dragOut,
  hitTest,
  newElement,
  resizeBounds,
  scaleFields,
  simplePaints,
} from "../src/canvas/edit.ts";
import { Editor } from "../src/canvas/editor.ts";
import type { Op } from "../src/canvas/protocol.ts";
import type { CanvasElement } from "../src/canvas/types.ts";

const rect = (id: string, x: number, y: number, w = 100, h = 50): CanvasElement => ({
  ...newElement("rectangle", x, y, { ...DEFAULT_STYLE, backgroundColor: "#ffc9c9" }, id, 1),
  width: w,
  height: h,
});
const none = { shift: false, alt: false, cmd: false };

function setup(els: CanvasElement[]) {
  let scene = els;
  let t = 0;
  const ed = new Editor(
    () => scene,
    () => t,
  );
  return {
    ed,
    setScene: (s: CanvasElement[]) => {
      scene = s;
      ed.reconcile();
    },
    tick: (ms: number) => {
      t += ms;
    },
    ops: (): Op[][] => ed.outbox.splice(0),
  };
}

describe("edit geometry", () => {
  test("hit test picks the topmost element and maps bound text to its container", () => {
    const a = rect("a", 0, 0);
    const b = rect("b", 50, 0);
    const label = { ...newElement("text", 10, 10, DEFAULT_STYLE, "lbl", 1), width: 30, height: 20, containerId: "a" };
    expect(hitTest([a, b], 60, 10, 2)?.id).toBe("b");
    expect(hitTest([a, label], 15, 15, 2)?.id).toBe("a");
    expect(hitTest([a], 500, 500, 2)).toBeNull();
  });

  test("resize flips past the opposite edge and shift keeps the aspect ratio", () => {
    const b = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
    expect(resizeBounds(b, "e", -20, 0)).toEqual({ minX: -20, minY: 0, maxX: 0, maxY: 50 });
    expect(resizeBounds(b, "se", 200, 60, true)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
  });

  test("scaling a group moves and scales each member, points included", () => {
    const from = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const to = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    expect(scaleFields(rect("a", 50, 50, 50, 50), from, to)).toMatchObject({ x: 100, y: 50, width: 100, height: 50 });
    const line = dragOut(newElement("line", 0, 0, DEFAULT_STYLE, "l", 1), 0, 0, 100, 100, false);
    expect(scaleFields(line, from, to)).toMatchObject({
      points: [
        [0, 0],
        [200, 100],
      ],
    });
  });

  test("drag-out normalises negative drags and simple paints close the outline", () => {
    const r = dragOut(newElement("rectangle", 0, 0, DEFAULT_STYLE, "r", 1), 100, 100, 40, 70, false);
    expect(r).toMatchObject({ x: 40, y: 70, width: 60, height: 30 });
    const [stroke] = simplePaints(r);
    expect(stroke?.ops.length).toBe(5);
  });
});

describe("editor", () => {
  test("drag-create sends one create, selects it and keeps it visible until the echo", () => {
    const { ed, ops, setScene } = setup([]);
    ed.setTool("rectangle");
    ed.down(10, 10, none, 1, 2);
    ed.move(110, 60, none, 2);
    expect(ed.previews.size).toBe(1);
    ed.up(110, 60, none);
    const [[op]] = ops() as [[Op]];
    expect(op.op).toBe("create");
    const id = op.op === "create" ? op.element.id : "";
    expect(ed.selected.has(id)).toBe(true);
    expect(ed.tool).toBe("selection");
    expect(ed.elements().map((e) => e.id)).toEqual([id]);
    setScene([{ ...rect(id, 10, 10), id }]);
    expect(ed.pending.size).toBe(0);
  });

  test("a click without a drag creates nothing", () => {
    const { ed, ops } = setup([]);
    ed.setTool("ellipse");
    ed.down(10, 10, none, 1, 2);
    ed.up(10, 10, none);
    expect(ops()).toEqual([]);
  });

  test("moving a selection sends x/y updates and does not snap back on a stale patch", () => {
    const a = rect("a", 0, 0);
    const { ed, ops, setScene, tick } = setup([a]);
    ed.down(10, 10, none, 1, 2);
    ed.move(60, 30, none, 2);
    ed.up(60, 30, none);
    expect(ops()).toEqual([[{ op: "update", id: "a", fields: { x: 50, y: 20 } }]]);
    setScene([{ ...a, strokeColor: "#e03131" }]); // an unrelated agent edit lands first
    expect(ed.elements()[0]).toMatchObject({ x: 50, y: 20 });
    tick(3000); // the echo never came: give up the override
    expect(ed.elements()[0]).toMatchObject({ x: 0, y: 0 });
  });

  test("marquee selects enclosed elements; delete removes them with their labels", () => {
    const a = rect("a", 0, 0);
    const b = rect("b", 300, 0);
    const label = {
      ...newElement("text", 10, 10, DEFAULT_STYLE, "a-label", 1),
      width: 30,
      height: 20,
      containerId: "a",
    };
    const { ed, ops } = setup([a, b, label]);
    ed.down(-10, -10, none, 1, 2);
    ed.move(150, 100, none, 2);
    ed.up(150, 100, none);
    expect([...ed.selected]).toEqual(["a"]);
    ed.key("backspace");
    expect(ops()).toEqual([[{ op: "remove", ids: ["a", "a-label"] }]]);
    expect(ed.elements().map((e) => e.id)).toEqual(["b"]);
  });

  test("style changes apply to the selection as one batch and become the default", () => {
    const { ed, ops } = setup([rect("a", 0, 0), rect("b", 200, 0)]);
    ed.selectAll();
    ed.setStyle({ strokeColor: "#1971c2", roundEdges: false });
    const [batch] = ops();
    expect(batch).toHaveLength(2);
    expect(batch?.[0]).toEqual({ op: "update", id: "a", fields: { strokeColor: "#1971c2", roundness: null } });
    expect(ed.style.strokeColor).toBe("#1971c2");
  });

  test("double-click a shape edits its label; committing sends a label op", () => {
    const { ed, ops } = setup([rect("a", 0, 0)]);
    ed.down(20, 20, none, 2, 2);
    expect(ed.editing).toMatchObject({ containerId: "a", text: "" });
    ed.commitText("hello\n");
    expect(ops()).toEqual([[{ op: "label", containerId: "a", text: "hello" }]]);
  });

  test("text tool on empty canvas creates a text element; empty text creates nothing", () => {
    const { ed, ops } = setup([]);
    ed.setTool("text");
    ed.down(100, 100, none, 1, 2);
    ed.commitText("");
    expect(ops()).toEqual([]);
    ed.setTool("text");
    ed.down(100, 100, none, 1, 2);
    ed.commitText("note");
    const [[op]] = ops() as [[Op]];
    expect(op.op === "create" && op.element).toMatchObject({ type: "text", text: "note" });
  });

  test("arrows bind to the shapes under their ends", () => {
    const { ed, ops } = setup([rect("a", 0, 0), rect("b", 300, 0)]);
    ed.setTool("arrow");
    ed.down(50, 25, none, 1, 2);
    ed.move(350, 25, none, 2);
    ed.up(350, 25, none);
    const [[op]] = ops() as [[Op]];
    expect(op.op === "create" && op.element).toMatchObject({ start: { id: "a" }, end: { id: "b" } });
  });

  test("H toggles the hand back to the previous tool; Escape returns to selection (Excalidraw)", () => {
    const { ed } = setup([]);
    ed.setTool("rectangle");
    ed.key("h");
    expect(ed.tool).toBe("hand");
    ed.key("h");
    expect(ed.tool).toBe("rectangle");
    ed.key("escape");
    expect(ed.tool).toBe("selection");
  });

  test("dragging an arrow's midpoint adds a bend point; dragging the start point re-normalises", () => {
    const arrow = dragOut(newElement("arrow", 0, 0, DEFAULT_STYLE, "arr", 1), 0, 0, 200, 0, false);
    const { ed, ops } = setup([arrow]);
    ed.down(100, 0, none, 1, 2); // select it
    ed.up(100, 0, none);
    expect(ed.singleLinear()?.id).toBe("arr");
    ed.down(100, 0, none, 1, 2); // grab the midpoint handle
    ed.up(100, -60, none, 2);
    const [[bend]] = ops() as [[Op]];
    expect(bend).toEqual({
      op: "update",
      id: "arr",
      fields: {
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [100, -60],
          [200, 0],
        ],
        width: 200,
        height: 60,
        roundness: { type: 2 },
      },
    });
    ed.down(0, 0, none, 1, 2); // grab the start point
    ed.up(-50, 20, none, 2);
    const [[move]] = ops() as [[Op]];
    expect(move.op === "update" && move.fields).toMatchObject({
      x: -50,
      y: 20,
      points: [
        [0, 0],
        [150, -80],
        [250, -20],
      ],
    });
  });

  test("tool shortcuts switch tools, and keys are ignored while editing text", () => {
    const { ed } = setup([]);
    expect(ed.key("r")).toBe(true);
    expect(ed.tool).toBe("rectangle");
    ed.setTool("text");
    ed.down(0, 0, none, 1, 2);
    expect(ed.key("e")).toBe(false);
    expect(ed.tool).toBe("text");
  });
});

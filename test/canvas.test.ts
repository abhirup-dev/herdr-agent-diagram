import { describe, expect, test } from "bun:test";
import { fit, toScreen, toWorld, zoomAt } from "../src/canvas/camera.ts";
import { elementPaints, isTransparent, withOpacity } from "../src/canvas/shape.ts";
import type { CanvasElement, LinearElement, ShapeElement } from "../src/canvas/types.ts";

const base = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: null,
  seed: 1234,
  version: 1,
  versionNonce: 1,
  index: null,
  isDeleted: false,
  groupIds: [],
  boundElements: null,
  locked: false,
} as const;
const rect: ShapeElement = { ...base, id: "r", type: "rectangle", x: 0, y: 0, width: 200, height: 80 };
const arrow: LinearElement = {
  ...base,
  id: "a",
  type: "arrow",
  x: 0,
  y: 0,
  width: 150,
  height: 0,
  points: [
    [0, 0],
    [150, 0],
  ],
  startBinding: null,
  endBinding: null,
  startArrowhead: null,
  endArrowhead: "arrow",
};

describe("shape", () => {
  test("same seed gives identical strokes (deterministic, like Excalidraw)", () => {
    expect(JSON.stringify(elementPaints(rect))).toBe(JSON.stringify(elementPaints(rect)));
  });
  test("a different seed changes the strokes", () => {
    expect(JSON.stringify(elementPaints({ ...rect, seed: 99 }))).not.toBe(JSON.stringify(elementPaints(rect)));
  });
  test("transparent rectangle: strokes only; filled one adds a fill", () => {
    expect(elementPaints(rect).every((p) => p.kind === "stroke")).toBe(true);
    expect(elementPaints({ ...rect, backgroundColor: "#a5d8ff" }).some((p) => p.kind === "fill")).toBe(true);
  });
  test("arrow: shaft plus two head strokes", () => {
    const paints = elementPaints(arrow);
    expect(paints.length).toBeGreaterThanOrEqual(3);
    expect(elementPaints({ ...arrow, endArrowhead: null }).length).toBeLessThan(paints.length);
  });
  test("dashed strokes carry Excalidraw's dash array", () => {
    expect(elementPaints({ ...rect, strokeStyle: "dashed" })[0]?.dash).toEqual([8, 10]);
  });
  test("text draws no paths (the renderer lays out text)", () => {
    const text = {
      ...base,
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      text: "hi",
      originalText: "hi",
      fontSize: 20,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      lineHeight: 1.25,
    } as const satisfies CanvasElement;
    expect(elementPaints(text)).toEqual([]);
  });
  test("freedraw: one filled outline parsed from Excalidraw's SVG path", () => {
    const pts = [
      [0, 0],
      [10, 5],
      [30, 20],
      [50, 10],
    ] as const;
    const fd = {
      ...base,
      id: "f",
      type: "freedraw",
      x: 0,
      y: 0,
      width: 50,
      height: 20,
      points: pts,
      pressures: [],
      simulatePressure: true,
    } as const;
    const [outline] = elementPaints(fd as unknown as CanvasElement);
    expect(outline?.kind).toBe("fill");
    expect(outline?.ops[0]?.op).toBe("move");
    expect(outline?.ops.some((o) => o.op === "bcurveTo")).toBe(true);
  });
  test("colour helpers", () => {
    expect(isTransparent("transparent")).toBe(true);
    expect(isTransparent("#ffffff00")).toBe(true);
    expect(isTransparent("#1e1e1e")).toBe(false);
    expect(withOpacity("#1e1e1e", 50)).toBe("#1e1e1e80");
    expect(withOpacity("#abc", 100)).toBe("#abc");
  });
});

describe("camera", () => {
  const c = { offsetX: 10, offsetY: 20, zoom: 2 };
  test("toScreen and toWorld invert each other", () => {
    expect(toWorld(c, toScreen(c, [33, 44]))).toEqual([33, 44]);
  });
  test("zoomAt keeps the point under the cursor fixed", () => {
    const at = [300, 200] as const;
    const before = toWorld(c, at);
    const after = toWorld(zoomAt(c, 1.5, at), at);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });
  test("fit centres the bounds and never zooms past 1", () => {
    const f = fit({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 1000, 800);
    expect(f.zoom).toBe(1);
    expect(toScreen(f, [50, 25])).toEqual([500, 400]);
  });
});

import { applyMessage, emptyScene, sceneBounds } from "../src/canvas/scene.ts";

describe("scene", () => {
  const a = { ...rect, id: "a", index: "a1" };
  const b = { ...rect, id: "b", index: "a0", x: 300 };
  test("scene message replaces everything and orders by fractional index", () => {
    const s = applyMessage(emptyScene, { type: "scene", rev: 1, elements: [a, b] });
    expect(s.order.map((e) => e.id)).toEqual(["b", "a"]);
  });
  test("patch upserts and removes, reporting changed ids", () => {
    const s1 = applyMessage(emptyScene, { type: "scene", rev: 1, elements: [a, b] });
    const changed = new Set<string>();
    const s2 = applyMessage(s1, { type: "patch", rev: 2, upsert: [{ ...a, x: 50 }], remove: ["b"] }, changed);
    expect(s2.order.map((e) => e.id)).toEqual(["a"]);
    expect(s2.byId.get("a")?.x).toBe(50);
    expect([...changed].sort()).toEqual(["a", "b"]);
  });
  test("elements without an index stack on top in arrival order", () => {
    const s = applyMessage(emptyScene, {
      type: "scene",
      rev: 1,
      elements: [{ ...a, index: null, id: "n" }, a],
    });
    expect(s.order.map((e) => e.id)).toEqual(["a", "n"]);
  });
  test("bounds cover shapes and arrow points", () => {
    const s = applyMessage(emptyScene, {
      type: "scene",
      rev: 1,
      elements: [
        a,
        {
          ...arrow,
          id: "arr",
          x: 100,
          y: 200,
          points: [
            [0, 0],
            [-80, 40],
          ],
        },
      ],
    });
    expect(sceneBounds(s)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 240 });
  });
});

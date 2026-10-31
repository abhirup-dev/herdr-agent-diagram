import { describe, expect, test } from "bun:test";
import { cutOut } from "../src/canvas/shape.ts";
import type { PathOp } from "../src/canvas/types.ts";

describe("arrow labels", () => {
  test("cutOut removes the stroke inside the label box", () => {
    const ops: PathOp[] = [
      { op: "move", data: [0, 0] },
      { op: "lineTo", data: [100, 0] },
    ];
    const out = cutOut(ops, { x: 40, y: -5, width: 20, height: 10 });
    expect(out.map((o) => [o.op, o.data.map(Math.round)])).toEqual([
      ["move", [0, 0]],
      ["lineTo", [40, 0]],
      ["move", [60, 0]],
      ["lineTo", [100, 0]],
    ]);
  });

  test("cutOut keeps a curve that misses the box whole", () => {
    const ops: PathOp[] = [
      { op: "move", data: [0, 0] },
      { op: "bcurveTo", data: [30, 0, 70, 0, 100, 0] },
    ];
    const out = cutOut(ops, { x: 40, y: 10, width: 20, height: 10 });
    expect(out.filter((o) => o.op === "move")).toHaveLength(1);
    expect(out.at(-1)?.data).toEqual([100, 0]);
  });
});

import { expect, test } from "bun:test";
import { prepare, render } from "../src/board/render.ts";
import { sceneFile } from "../src/board/scene-file.ts";

test("container labels honour each alignment and keep centred defaults", async () => {
  for (const verticalAlign of ["top", "middle", "bottom"]) {
    for (const textAlign of ["left", "center", "right"]) {
      const raw = [
        {
          id: "zone",
          type: "rectangle",
          x: 20,
          y: 30,
          width: 300,
          height: 200,
          label: { text: "Auth zone", verticalAlign, textAlign },
        },
      ];
      const els = await prepare(raw);
      const t = els.find((e) => e.type === "text")!;
      expect(t).toMatchObject({ verticalAlign, textAlign, containerId: "zone" });
      expect(t.x).toBeCloseTo(
        textAlign === "left" ? 25 : textAlign === "right" ? 315 - Number(t.width) : 170 - Number(t.width) / 2,
      );
      expect(t.y).toBeCloseTo(
        verticalAlign === "top" ? 35 : verticalAlign === "bottom" ? 225 - Number(t.height) : 130 - Number(t.height) / 2,
      );
      expect(sceneFile(raw).elements).toContainEqual(
        expect.objectContaining({ type: "text", verticalAlign, textAlign }),
      );
      const svg = await render(raw, { format: "svg" });
      expect(svg.data).toContain("Auth zone");
    }
  }
  const els = await prepare([
    { id: "default", type: "rectangle", x: 0, y: 0, width: 300, height: 200, label: { text: "Default" } },
  ]);
  expect(els.find((e) => e.type === "text")).toMatchObject({ verticalAlign: "middle", textAlign: "center" });
}, 30000);

test("bound routes keep world waypoints, orthogonal elbows and bindings after moves and updates", async () => {
  const { Board } = await import("../src/board/store.ts");
  for (const elbowed of [false, true]) {
    const b = new Board();
    b.batch([
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 80 },
      { id: "b", type: "rectangle", x: 340, y: 0, width: 100, height: 80 },
      {
        id: "route",
        type: "arrow",
        x: 108,
        y: 40,
        points: [
          [0, 0],
          [40, 0],
          [40, 100],
          [184, 100],
          [184, 0],
          [224, 0],
        ],
        elbowed,
        start: { id: "a" },
        end: { id: "b" },
      },
    ]);
    const world = () => {
      const a = b.get("route");
      return (a.points as number[][]).map((p) => [Number(a.x) + p[0]!, Number(a.y) + p[1]!]);
    };
    const interior = world().slice(1, -1);
    expect(interior).toEqual([
      [148, 40],
      [148, 140],
      [292, 140],
      [292, 40],
    ]);
    b.update("a", { x: 10, y: 20 });
    b.update("route", { strokeColor: "red", points: undefined });
    for (const p of interior) expect(world()).toContainEqual(p);
    expect(b.get("route").x).toBeGreaterThan(110);
    if (elbowed) {
      const pts = world();
      for (let i = 1; i < pts.length; i++)
        expect(pts[i]?.[0] === pts[i - 1]?.[0] || pts[i]?.[1] === pts[i - 1]?.[1]).toBe(true);
    }
    const prepared = await prepare(b.list());
    expect(prepared.find((e) => e.id === "route")).toMatchObject({
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
      elbowed,
    });
    expect(prepared.find((e) => e.id === "route")?.points).toEqual(b.get("route").points);
  }
});

test("oversized labels clear bound boxes and leave native and SVG shafts intact", async () => {
  const { withPaints } = await import("../src/board/paints.ts");
  const { isCanvasElement } = await import("../src/canvas/types.ts");
  const { renderingWarnings } = await import("../src/board/render.ts");
  for (const points of [
    [
      [0, 0],
      [24, 0],
    ],
    [
      [0, 0],
      [0, 24],
    ],
    [
      [0, 0],
      [24, 24],
    ],
  ]) {
    const raw = [
      { id: "s", type: "rectangle", x: -100, y: -40, width: 100, height: 80 },
      { id: "e", type: "rectangle", x: 24, y: -40, width: 100, height: 80 },
      {
        id: "short",
        type: "arrow",
        x: 0,
        y: 0,
        points,
        startBinding: { elementId: "s", focus: 0, gap: 0 },
        endBinding: { elementId: "e", focus: 0, gap: 0 },
        label: { text: "HTTPS request" },
        roughness: 0,
      },
    ];
    const prepared = ((await prepare(raw)) as { type: string }[]).filter(isCanvasElement);
    const t = prepared.find((e) => e.type === "text");
    expect(t).toBeDefined();
    if (!t) throw new Error("missing label");
    for (const box of raw.slice(0, 2))
      expect(
        t.x >= box.x + Number(box.width) ||
          t.x + t.width <= box.x ||
          t.y >= box.y + Number(box.height) ||
          t.y + t.height <= box.y,
      ).toBe(true);
    const arrow = withPaints(prepared).find((e) => e.id === "short");
    const { elementPaints } = await import("../src/canvas/shape.ts");
    if (!arrow) throw new Error("missing arrow");
    expect(arrow.paints).toEqual(elementPaints(arrow));
    expect(await renderingWarnings(raw)).toMatchObject({
      warnings: [expect.stringMatching(/^arrow short:.*widen the gap/)],
    });
    const svg = await render(raw, { format: "svg" });
    expect(svg.data).toContain("HTTPS request");
    expect(svg.data).not.toContain('mask="url(');
  }
  const normal = [
    {
      id: "normal",
      type: "arrow",
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [300, 0],
      ],
      label: { text: "OK" },
    },
  ];
  expect(await renderingWarnings(normal)).toEqual({});
  const els = await prepare(normal);
  const t = els.find((e) => e.type === "text");
  expect(Number(t?.x) + Number(t?.width) / 2).toBeCloseTo(150);
  expect(Number(t?.y) + Number(t?.height) / 2).toBeCloseTo(0);
});

test("add, apply and update expose only nonempty top-level warnings", async () => {
  const { run } = await import("../src/board/cli.ts");
  const { handle } = await import("../src/board/http.ts");
  const { Registry } = await import("../src/sidecar/boards.ts");
  const boards = new Registry(async () => []);
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  let output = "";
  globalThis.fetch = (async (url, options) => handle(boards, new Request(url as string, options))) as typeof fetch;
  process.stdout.write = ((data: string) => {
    output += data;
    return true;
  }) as typeof process.stdout.write;
  try {
    for (const [command, input] of [
      [
        ["add", "-"],
        [
          {
            id: "short",
            type: "arrow",
            x: 0,
            y: 0,
            points: [
              [0, 0],
              [24, 0],
            ],
            label: { text: "HTTPS request" },
          },
        ],
      ],
      [["apply", "-"], { update: [{ id: "short", set: { label: { text: "Another long label" } } }] }],
      [["update", "short", "--set", '{"label":{"text":"Still too long"}}'], null],
    ] as const) {
      output = "";
      expect(
        await run([...command], { url: "http://127.0.0.1/b/render-test", stdin: async () => JSON.stringify(input) }),
      ).toBe(0);
      expect(JSON.parse(output).warnings).toEqual([expect.stringMatching(/^arrow short:/)]);
    }
    output = "";
    expect(
      await run(["update", "short", "--set", '{"points":[[0,0],[1000,0]]}'], { url: "http://127.0.0.1/b/render-test" }),
    ).toBe(0);
    expect(JSON.parse(output)).not.toHaveProperty("warnings");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
});

test("two-point elbow bindings get an orthogonal route and follow a moved endpoint", async () => {
  const { Board } = await import("../src/board/store.ts");
  const b = new Board();
  b.batch([
    { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 80 },
    { id: "b", type: "rectangle", x: 340, y: 100, width: 100, height: 80 },
    { id: "route", type: "arrow", x: 0, y: 0, elbowed: true, start: { id: "a" }, end: { id: "b" } },
  ]);
  b.update("b", { y: 150 });
  const arrow = b.get("route");
  const pts = arrow.points as number[][];
  expect(pts.length).toBeGreaterThan(2);
  for (let i = 1; i < pts.length; i++)
    expect(pts[i]?.[0] === pts[i - 1]?.[0] || pts[i]?.[1] === pts[i - 1]?.[1]).toBe(true);
  const last = pts.at(-1);
  expect(Number(arrow.x) + Number(last?.[0])).toBe(332);
  expect(Number(arrow.y) + Number(last?.[1])).toBe(190);
});

test("normal labels still cut native shafts at the midpoint", async () => {
  const { withPaints } = await import("../src/board/paints.ts");
  const { elementPaints } = await import("../src/canvas/shape.ts");
  const { isCanvasElement } = await import("../src/canvas/types.ts");
  const els = (
    (await prepare([
      {
        id: "normal",
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [300, 0],
        ],
        roughness: 0,
        label: { text: "OK" },
      },
    ])) as { type: string }[]
  ).filter(isCanvasElement);
  const arrow = withPaints(els).find((e) => e.id === "normal");
  if (!arrow) throw new Error("missing arrow");
  expect(arrow.paints).not.toEqual(elementPaints(arrow));
  const svg = await render(els, { format: "svg", embedFonts: false });
  expect(svg.data).toContain('mask="url(');
});

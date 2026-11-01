import { describe, expect, test } from "bun:test";
import { run } from "../src/board/cli.ts";
import { handle } from "../src/board/http.ts";
import { labelOverflowWarnings } from "../src/board/overflow.ts";
import { describeScene, prepareElement, prepareUpdate } from "../src/board/prepare.ts";
import { Board } from "../src/board/store.ts";
import { measureTextWidth } from "../src/board/upstream/core/render/text-metrics.js";
import { Registry } from "../src/sidecar/boards.ts";

const rect = (extra: Record<string, unknown> = {}) =>
  prepareElement({ id: "api", type: "rectangle", x: 0, y: 0, width: 120, height: 60, ...extra });

describe("prepare input", () => {
  test("text on a frame becomes its name", () => {
    const frame = prepareElement({ id: "f", type: "frame", x: 0, y: 0, width: 400, height: 200, text: "Services" });
    expect(frame.name).toBe("Services");
    expect(frame).not.toHaveProperty("text");
    expect(frame).not.toHaveProperty("label");
    const kept = prepareElement({ id: "f", type: "frame", x: 0, y: 0, text: "Services", name: "Backend" });
    expect(kept.name).toBe("Backend");
    expect(kept).not.toHaveProperty("text");
  });

  test("fontSize on a labelled shape becomes label.fontSize", () => {
    const shape = rect({ text: "API", fontSize: 28 });
    expect(shape.fontSize).toBeUndefined();
    expect(shape.label).toEqual({ text: "API", fontSize: 28 });
    const labelled = rect({ label: { text: "API" }, fontSize: 32 });
    expect(labelled.label).toEqual({ text: "API", fontSize: 32 });
    expect(labelled.fontSize).toBeUndefined();
    const text = prepareElement({ id: "t", type: "text", x: 0, y: 0, text: "Note", fontSize: 18 });
    expect(text).toMatchObject({ text: "Note", fontSize: 18 });
    expect(text).not.toHaveProperty("label");
  });

  test("frame text and shape fontSize are what the canvas draws", async () => {
    const { prepare } = await import("../src/board/render.ts");
    const shape = prepareElement({
      id: "api",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 220,
      height: 80,
      text: "API",
      fontSize: 32,
    });
    const drawn = await prepare([shape]);
    expect(drawn.find((e) => e.type === "text")).toMatchObject({ text: "API", fontSize: 32, containerId: "api" });
    const frame = prepareElement({ id: "f", type: "frame", x: 0, y: 0, width: 300, height: 180, text: "Services" });
    const frames = await prepare([frame]);
    expect(frames.find((e) => e.id === "f")?.name).toBe("Services");
  });

  test("an update keeps the label text when only fontSize changes", () => {
    const existing = { type: "rectangle", label: { text: "API" } };
    const updated = prepareUpdate({ fontSize: 30 }, "rectangle", existing);
    expect(updated.label).toEqual({ text: "API", fontSize: 30 });
    expect(updated).not.toHaveProperty("fontSize");
    const bare = prepareUpdate({ fontSize: 30 }, "rectangle");
    expect(bare.fontSize).toBe(30);
    expect(bare).not.toHaveProperty("label");
    const frame = prepareUpdate({ text: "Services" }, "frame");
    expect(frame.name).toBe("Services");
    expect(frame).not.toHaveProperty("text");
    expect(frame).not.toHaveProperty("label");
  });
});

describe("describe scene", () => {
  test("arrows list endpoints and frames list their name", () => {
    const text = describeScene([
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 50 },
      { id: "ar", type: "arrow", x: 190, y: 68, start: { id: "a" }, end: { id: "b" } },
      { id: "zone", type: "frame", x: 0, y: 0, width: 500, height: 200, name: "Backend" },
      { id: "free", type: "arrow", x: 10, y: 80 },
    ]);
    expect(text).toContain("[ar] arrow | at (190, 68) | from a -> b");
    expect(text).toContain('[zone] frame | at (0, 0) | size 500x200 | name: "Backend"');
    expect(text).toContain("a --> b (arrow: ar)");
    expect(text).not.toContain("from ? -> ?");
    const bound = describeScene([
      { id: "link", type: "arrow", x: 0, y: 0, startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
    ]);
    expect(bound).toContain("[link] arrow | at (0, 0) | from a -> b");
  });
});

describe("duplicate ids", () => {
  test("create and batch refuse an existing id and change nothing", () => {
    const b = new Board();
    b.create({ id: "api", type: "rectangle", x: 0, y: 0, width: 80, height: 40 });
    expect(() => b.create({ id: "api", type: "ellipse", x: 1, y: 1 })).toThrow("id api exists; use update");
    expect(() =>
      b.batch([
        { id: "new", type: "ellipse", x: 0, y: 0 },
        { id: "api", type: "diamond", x: 0, y: 0 },
      ]),
    ).toThrow("id api exists; use update");
    expect([...b.elements.keys()]).toEqual(["api"]);
    expect(b.get("api").type).toBe("rectangle");
    expect(() =>
      b.batch(
        [
          { id: "api", type: "rectangle", x: 0, y: 0 },
          { id: "api", type: "ellipse", x: 1, y: 1 },
        ],
        true,
      ),
    ).toThrow("id api exists; use update");
    expect(b.get("api").type).toBe("rectangle");
    b.batch([{ id: "api", type: "ellipse", x: 4, y: 4 }], true);
    expect(b.get("api").type).toBe("ellipse");
  });
});

describe("label overflow warnings", () => {
  test("a label wider than its shape warns; one that fits does not", () => {
    const text = "API gateway";
    const font = "20px Excalifont";
    const measured = measureTextWidth(text, font);
    const narrow = { id: "api", type: "rectangle", x: 0, y: 0, width: Math.floor(measured - 1), label: { text } };
    const wide = { id: "ok", type: "rectangle", x: 0, y: 0, width: Math.ceil(measured), label: { text } };
    expect(labelOverflowWarnings([narrow, wide])).toEqual([
      `rect api: label needs ~${Math.ceil(measured)}px width (has ${narrow.width})`,
    ]);
    const bigText = "Hi";
    const bigWidth = measureTextWidth(bigText, "64px Excalifont");
    const big = labelOverflowWarnings([
      {
        id: "api",
        type: "rectangle",
        x: 0,
        y: 0,
        width: Math.floor(bigWidth - 1),
        label: { text: bigText, fontSize: 64 },
      },
    ]);
    expect(big).toEqual([`rect api: label needs ~${Math.ceil(bigWidth)}px width (has ${Math.floor(bigWidth - 1)})`]);
    expect(
      labelOverflowWarnings([
        { id: "api", type: "rectangle", x: 0, y: 0, width: 80, label: { text: "Hi", fontSize: 16 } },
      ]),
    ).toEqual([]);
    expect(
      labelOverflowWarnings([{ id: "t", type: "text", x: 0, y: 0, width: 10, text: "too wide for a text box" }]),
    ).toEqual([]);
  });
});

const boards = new Registry(async () => []);
const boardUrl = `http://127.0.0.1:${
  Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handle(boards, req) }).port
}/b/board-test`;

async function cli(args: string[], stdin?: string) {
  let out = "";
  let err = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((data: string | Uint8Array) => {
    out += String(data);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((data: string | Uint8Array) => {
    err += String(data);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await run(args, { url: boardUrl, ...(stdin === undefined ? {} : { stdin: async () => stdin }) });
    return { code, out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test.serial("add and apply of an existing id exit 2 and leave the element", async () => {
  const first = await cli([
    "add",
    "--one",
    JSON.stringify({ id: "api", type: "rectangle", x: 0, y: 0, width: 180, height: 60, text: "API" }),
  ]);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.out).elements[0].label.text).toBe("API");
  const again = await cli([
    "add",
    "--one",
    JSON.stringify({ id: "api", type: "ellipse", x: 9, y: 9, width: 10, height: 10, text: "nope" }),
  ]);
  expect(again.code).toBe(2);
  expect(again.err).toContain("id api exists; use update");
  const patch = await cli(
    ["apply", "-"],
    JSON.stringify({
      create: [{ id: "api", type: "diamond", x: 0, y: 0, text: "replaced" }],
      update: [{ id: "api", set: { x: 50 } }],
    }),
  );
  expect(patch.code).toBe(2);
  expect(patch.err).toContain("id api exists; use update");
  const got = await cli(["get", "api"]);
  expect(got.code).toBe(0);
  expect(JSON.parse(got.out)).toMatchObject({ id: "api", type: "rectangle", x: 0, label: { text: "API" } });
});

test.serial("describe shows arrow endpoints and the frame name", async () => {
  expect(
    (
      await cli([
        "add",
        "--one",
        JSON.stringify({ id: "zone", type: "frame", x: 0, y: 0, width: 400, height: 200, text: "Services" }),
      ])
    ).code,
  ).toBe(0);
  expect(
    (await cli(["add", "--one", JSON.stringify({ id: "a", type: "rectangle", x: 0, y: 40, width: 80, height: 40 })]))
      .code,
  ).toBe(0);
  expect(
    (await cli(["add", "--one", JSON.stringify({ id: "b", type: "rectangle", x: 240, y: 40, width: 80, height: 40 })]))
      .code,
  ).toBe(0);
  expect(
    (
      await cli([
        "add",
        "--one",
        JSON.stringify({ id: "ar", type: "arrow", x: 0, y: 0, startElementId: "a", endElementId: "b" }),
      ])
    ).code,
  ).toBe(0);
  const described = await cli(["describe"]);
  expect(described.code).toBe(0);
  expect(described.out).toContain("from a -> b");
  expect(described.out).toContain('name: "Services"');
});

test.serial("add, apply and update warn only when a label overflows its shape", async () => {
  const text = "API gateway service";
  const measured = Math.ceil(measureTextWidth(text, "20px Excalifont"));
  const overflow = await cli([
    "add",
    "--one",
    JSON.stringify({ id: "wide", type: "rectangle", x: 0, y: 300, width: 40, height: 60, text }),
  ]);
  expect(overflow.code).toBe(0);
  expect(JSON.parse(overflow.out).warnings).toEqual([`rect wide: label needs ~${measured}px width (has 40)`]);
  const fit = await cli(["update", "wide", "--set", JSON.stringify({ width: measured })]);
  expect(fit.code).toBe(0);
  expect(JSON.parse(fit.out)).not.toHaveProperty("warnings");
  const again = await cli(["apply", "-"], JSON.stringify({ update: [{ id: "wide", set: { width: 30 } }] }));
  expect(again.code).toBe(0);
  expect(JSON.parse(again.out).warnings).toEqual([`rect wide: label needs ~${measured}px width (has 30)`]);
});

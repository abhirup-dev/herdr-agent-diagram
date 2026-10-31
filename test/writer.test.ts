import { describe, expect, test } from "bun:test";
import type { RawElement } from "../src/sidecar/mirror.ts";
import { type Rest, Writer } from "../src/sidecar/writer.ts";

/** A fake server: an element map plus a call log. */
function fake(initial: RawElement[]) {
  const store = new Map(initial.map((e) => [e.id, e]));
  const raw = new Map(store); // the sidecar's mirror (lags the store in real life)
  const calls: string[] = [];
  const rest: Rest = {
    create: async (el) => {
      const e = el as RawElement;
      store.set(e.id, e);
      calls.push(`create ${e.id}`);
      return e;
    },
    update: async (id, fields) => {
      const e = { ...(store.get(id) as RawElement), ...fields };
      store.set(id, e);
      calls.push(`update ${id} ${JSON.stringify(fields)}`);
      return e;
    },
    remove: async (id) => {
      store.delete(id);
      calls.push(`remove ${id}`);
    },
    get: async (id) => store.get(id) ?? null,
  };
  const prepared = new Map<string, Record<string, unknown>>([["box-label", { containerId: "box", text: "hi" }]]);
  const writer = new Writer(rest, { raw: () => raw, prepared: (id) => prepared.get(id) });
  return { store, raw, calls, writer };
}

const box: RawElement = { id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50, label: { text: "hi" } };

describe("writer", () => {
  test("undo restores raw values, redo reapplies", async () => {
    const { store, writer } = fake([box]);
    await writer.apply([{ op: "update", id: "box", fields: { x: 40 } }]);
    await writer.apply([{ op: "update", id: "box", fields: { x: 80 } }]); // inverse must see x=40, not 0
    await writer.undo();
    expect(store.get("box")?.x).toBe(40);
    await writer.undo();
    expect(store.get("box")?.x).toBe(0);
    await writer.redo();
    expect(store.get("box")?.x).toBe(40);
    expect(writer.canRedo).toBe(true);
  });

  test("undoing a delete recreates the raw shorthand element, label and all", async () => {
    const { store, writer } = fake([box]);
    await writer.apply([{ op: "remove", ids: ["box", "box-label"] }]);
    expect(store.has("box")).toBe(false);
    await writer.undo();
    expect(store.get("box")).toMatchObject({ type: "rectangle", label: { text: "hi" } });
  });

  test("editing a generated label updates its container's label", async () => {
    const { store, writer, calls } = fake([box]);
    await writer.apply([{ op: "update", id: "box-label", fields: { text: "bye" } }]);
    expect(calls).toEqual(['update box {"label":{"text":"bye"}}']);
    expect(store.get("box")?.label).toEqual({ text: "bye" });
    await writer.undo();
    expect(store.get("box")?.label).toEqual({ text: "hi" });
  });

  test("a label op prefers a raw bound text element", async () => {
    const text: RawElement = { id: "t", type: "text", containerId: "box2", text: "old" };
    const { store, writer } = fake([{ id: "box2", type: "rectangle" }, text]);
    await writer.apply([{ op: "label", containerId: "box2", text: "new" }]);
    expect(store.get("t")?.text).toBe("new");
  });

  test("undoing a create removes it; a new edit clears redo", async () => {
    const { store, writer } = fake([]);
    await writer.apply([{ op: "create", element: { id: "n", type: "ellipse", x: 0, y: 0 } }]);
    await writer.undo();
    expect(store.has("n")).toBe(false);
    await writer.apply([{ op: "create", element: { id: "m", type: "ellipse", x: 0, y: 0 } }]);
    expect(writer.canRedo).toBe(false);
  });
});

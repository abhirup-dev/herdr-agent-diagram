import { describe, expect, test } from "bun:test";
import { diff, stableSeed, withSeeds } from "../src/sidecar/diff.ts";

describe("sidecar diff", () => {
  test("diff ignores fields the SDK regenerates on every conversion", () => {
    const prev = new Map([["a", { id: "a", x: 1, updated: 1, versionNonce: 5 }]]);
    expect(diff(prev, [{ id: "a", x: 1, updated: 2, versionNonce: 9 }]).upsert).toEqual([]);
    expect(diff(prev, [{ id: "a", x: 2, updated: 2, versionNonce: 9 }]).upsert).toHaveLength(1);
  });

  test("missing seeds are filled from the id, existing seeds kept", () => {
    expect(stableSeed("probe")).toBe(stableSeed("probe"));
    expect(stableSeed("probe")).not.toBe(stableSeed("probe2"));
    expect(stableSeed("probe")).toBeGreaterThan(0);
    const [a, b] = withSeeds([{ id: "a" }, { id: "b", seed: 7 }]);
    expect(a?.seed).toBe(stableSeed("a"));
    expect(b?.seed).toBe(7);
  });
});

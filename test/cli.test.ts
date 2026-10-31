import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../bin/herdr-draw.mjs";
import { status } from "../bin/lib/canvas.mjs";
import { extract, parseArgs } from "../bin/lib/mermaid.mjs";

const CLI = join(import.meta.dir, "../bin/herdr-draw.mjs");
const run = (args: string[], env: Record<string, string> = {}, stdin = "") => {
  const r = Bun.spawnSync(["node", CLI, ...args], { env: { ...process.env, ...env }, stdin: Buffer.from(stdin) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

describe("herdr-draw router", () => {
  test("routes known groups, refuses unknown ones", () => {
    for (const argv of [[], ["help"], ["mermaid", "ls"], ["canvas", "status"], ["open"]])
      expect(route(argv)).toBeFunction();
    expect(route(["bogus"])).toBeNull();
    expect(route(["open", "extra"])).toBeNull();
  });

  test("help lists every group; unknown commands exit 2 with usage", () => {
    const help = run(["help"]);
    expect(help.code).toBe(0);
    for (const g of ["mermaid", "canvas", "open"]) expect(help.out).toContain(`  ${g} `);
    const bad = run(["bogus"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("usage: herdr-draw");
    expect(run(["mermaid", "bogus"]).code).toBe(2);
  });
});

describe("mermaid args", () => {
  test("parseArgs takes values for --tab/--title/--terminal, flags otherwise", () => {
    expect(parseArgs(["add", "--tab", "T", "--json", "f.mmd"])).toEqual({ _: ["add", "f.mmd"], tab: "T", json: true });
  });

  test("extract reads a mermaid fence and its heading", () => {
    expect(extract("# Title\n```mermaid\nflowchart TD\n a-->b\n```\n")).toEqual({
      mmd: "flowchart TD\n a-->b",
      title: "Title",
    });
    expect(extract("flowchart TD\n a-->b\n")).toEqual({ mmd: "flowchart TD\n a-->b", title: null });
  });
});

test("mermaid add, ls, remove on a temp app home", () => {
  const env = { HERDR_APP_HOME: mkdtempSync(join(tmpdir(), "herdr-draw-test-")), HC_TERMINAL_ID: "t1" };
  const add = run(["mermaid", "add", "--title", "Build"], env, "flowchart TD\n a-->b\n");
  expect(add.code).toBe(0);
  expect(add.out).toStartWith("d1 pinned");
  const state = JSON.parse(readFileSync(join(env.HERDR_APP_HOME, "data/herdr-agent-diagram/t1/state.json"), "utf8"));
  expect(state.tabs[0].pins[0]).toMatchObject({
    id: "d1",
    title: "Build",
    svg: "data/herdr-agent-diagram/t1/d1-r1.svg",
  });
  expect(run(["mermaid", "ls"], env).out).toContain("d1  Build");
  expect(run(["mermaid", "remove", "d1"], env).out).toBe("d1 removed\n");
  expect(run(["mermaid", "ls"], env).out).toBe("no pins for t1\n");
});

test("canvas status reports everything down when nothing listens", async () => {
  const s = await status({ EXPRESS_SERVER_URL: "http://127.0.0.1:9", CANVAS_SIDECAR_PORT: "9" });
  expect(s).toEqual({
    server: { url: "http://127.0.0.1:9", up: false },
    sidecar: { url: "http://127.0.0.1:9", up: false },
    board: null,
  });
});

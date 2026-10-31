import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program, route } from "../cli/herdr-draw.mjs";
import { program as canvasProgram, status } from "../cli/lib/canvas.mjs";
import { program as installProgram } from "../cli/lib/install.mjs";
import { parseArgs as logsArgs, program as logsProgram } from "../cli/lib/logs.mjs";
import { extract, program as mermaidProgram, parseArgs } from "../cli/lib/mermaid.mjs";
import { COMMANDS } from "../src/board/cli.ts";

const CLI = join(import.meta.dir, "../cli/herdr-draw.mjs");
const run = (args: string[], env: Record<string, string> = {}, stdin = "") => {
  const r = Bun.spawnSync(["node", CLI, ...args], { env: { ...process.env, ...env }, stdin: Buffer.from(stdin) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

describe("herdr-draw router", () => {
  test("routes known groups, refuses unknown ones", () => {
    for (const argv of [[], ["help"], ["-h"], ["--version"], ["-V"], ["mermaid", "ls"], ["canvas", "status"], ["open"]])
      expect(route(argv)).toBeFunction();
    for (const argv of [["bogus"], ["--bogus"], ["bridge"], ["bridge", "other"], ["help", "bogus"]])
      expect(route(argv)).toBeNull();
    expect(route(["bridge", "endpoint"])).toBeFunction();
  });

  test("unknown commands, options and extra arguments exit 2 with a message", () => {
    const bad = run(["bogus"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown command bogus");
    expect(bad.err).toContain("usage: herdr-draw");
    expect(run(["mermaid", "bogus"]).code).toBe(2);
    for (const [argv, msg] of [
      [["mermaid", "add", "--bogus"], "Unknown option `--bogus`"],
      [["mermaid", "remove"], "missing required args"],
      [["open", "extra"], "Unused args: `extra`"],
      [["logs", "a", "b"], "Unused args: `b`"],
      [["install", "--bogus"], "Unknown option `--bogus`"],
    ] as const) {
      const r = run([...argv]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(msg);
    }
  });

  test("--version and -V print only the version (doctor compares it)", () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    for (const flag of ["--version", "-V"]) expect(run([flag]).out).toBe(`${version}\n`);
  });

  test("help is lazy: an overview, then each group's details on request", () => {
    const top = run(["help"]);
    expect(top.code).toBe(0);
    for (const g of ["mermaid", "canvas", "open", "install", "uninstall", "doctor", "logs", "bridge endpoint"])
      expect(top.out).toContain(`  ${g} `);
    expect(top.out).not.toContain("herdr-draw mermaid:");
    expect(top.out).not.toContain("Board commands");
    for (const v of [
      "HC_TERMINAL_ID",
      "HERDR_APP_HOME",
      "CANVAS_SIDECAR_PORT",
      "HERDR_DRAW_BUN",
      "HERDR_DRAW_DEBUG",
      "HERDR_DRAW_LOGS",
      "HERDR_DRAW_BOARDS",
      "XDG_STATE_HOME",
      "HERDR_DRAW_HOME",
      "HERDR_DRAW_REPO",
    ])
      expect(top.out).toContain(`  ${v} `);
    // Between them, the overview and the group helps cover every option and board command.
    const all = [top, ...["mermaid", "canvas", "install", "logs"].map((g) => run([g, "help"]))]
      .map((r) => r.out)
      .join("\n");
    const programs = [program(), mermaidProgram(), canvasProgram(), installProgram(), logsProgram()];
    for (const opt of programs.flatMap((p) => [p.globalCommand, ...p.commands]).flatMap((c) => c.options))
      for (const flag of opt.rawName.split(/[ ,]+/).filter((t: string) => t.startsWith("-")))
        expect(all).toContain(flag);
    for (const c of Object.values(COMMANDS)) expect(all).toContain(`  ${c.usage}\n`);
    // the same help from any group, and per board command
    expect(run(["mermaid", "add", "--help"]).out).toStartWith("herdr-draw mermaid:");
    expect(run(["canvas", "help"]).out).toContain("  clear --yes\n");
    for (const argv of [
      ["canvas", "help", "query"],
      ["canvas", "query", "--help"],
      ["help", "canvas", "query"],
    ])
      expect(run(argv).out).toStartWith(`Usage: ${COMMANDS.query?.usage}`);
  });

  test("every board command's flags are in its usage", () => {
    for (const c of Object.values(COMMANDS))
      for (const f of Object.keys(c.flags ?? {})) expect(c.usage).toContain(`--${f}`);
  });
});

describe("group args", () => {
  test("mermaid: the command, its positionals, string options and switches", () => {
    expect(parseArgs(["add", "--tab", "T", "--title", "2024", "f.mmd"])).toMatchObject({
      cmd: "add",
      args: ["f.mmd"],
      options: { tab: "T", title: "2024" },
    });
    expect(parseArgs(["ls", "--json"])).toMatchObject({ cmd: "ls", args: [], options: { json: true } });
    expect(parseArgs(["bogus", "x"])).toMatchObject({ cmd: undefined, args: ["bogus", "x"] });
    expect(() => parseArgs(["ls", "--tab", "T"])).toThrow("Unknown option `--tab`");
    expect(() => parseArgs(["add", "--tab"])).toThrow("value is missing");
    // help skips the checks
    expect(parseArgs(["replace", "--help"])).toMatchObject({ cmd: "replace", options: { help: true } });
  });

  test("logs: component, -n, --machine, --path", () => {
    expect(logsArgs(["sidecar", "-n", "5", "--machine", "vpsme", "--path"])).toEqual({
      component: "sidecar",
      n: 5,
      machine: "vpsme",
      path: true,
      help: false,
    });
    expect(logsArgs(["-n", "nope"])).toMatchObject({ component: null, n: 100, machine: null });
    expect(logsArgs(["help"]).help).toBe(true);
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
  const s = await status({ HC_TERMINAL_ID: "t5", CANVAS_SIDECAR_PORT: "9" });
  expect(s).toEqual({
    sidecar: { url: "http://127.0.0.1:9", up: false, pid: null },
    board: { id: "t5", url: "http://127.0.0.1:9/b/t5" },
    boards: [],
  });
});

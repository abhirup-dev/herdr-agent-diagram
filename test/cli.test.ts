import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program, route } from "../cli/herdr-draw.mjs";
import { program as canvasProgram, status } from "../cli/lib/canvas.mjs";
import { program as installProgram } from "../cli/lib/install.mjs";
import { parseArgs as logsArgs, program as logsProgram } from "../cli/lib/logs.mjs";
import {
  DEFAULT_VIEW,
  extract,
  program as mermaidProgram,
  parseArgs,
  popupBox,
  readWindowSize,
} from "../cli/lib/mermaid.mjs";
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

describe("mermaid popup fit", () => {
  const tallTD = `flowchart TD
  A[Start Task] --> B[Step 1: Ingest Data]
  B --> C[Step 2: Parse Tokens]
  C --> D[Step 3: Build Graph]
  D --> E[Step 4: Layout Nodes]
  E --> F[Step 5: Render Edges]
  F --> G[Step 6: Apply Theme]
  G --> H[Step 7: Check Readability]
  H --> I[Step 8: Output Preview]
  I --> J[Done]
`;

  const wideLR = `flowchart LR
  A[Step 1: First Process Stage] --> B[Step 2: Second Process Stage] --> C[Step 3: Third Process Stage] --> D[Step 4: Fourth Process Stage] --> E[Step 5: Fifth Process Stage] --> F[Step 6: Sixth Process Stage]
`;

  test("missing window.json falls back to default 1100x620 box", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-draw-fit-missing-"));
    const env = { HERDR_APP_HOME: home };
    expect(readWindowSize(home)).toBeNull();
    expect(popupBox(home)).toEqual(DEFAULT_VIEW);

    const r = run(["mermaid", "check"], env, "flowchart TD\n a-->b\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("preview:");
    expect(r.out).toContain("fits the popup (1100x620) at 100% size");
    expect(r.out).not.toContain("warning:");
  });

  test("corrupt window.json falls back gracefully", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-draw-fit-corrupt-"));
    writeFileSync(join(home, "window.json"), "NOT_JSON");
    expect(popupBox(home)).toEqual(DEFAULT_VIEW);
  });

  test("portrait window: tall TD passes, wide LR warns to switch to TD", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-draw-fit-portrait-"));
    // 1059 x 1647 with 0.85 dialog overlay gives 900 x 1400
    writeFileSync(join(home, "window.json"), JSON.stringify({ state: "windowed", bounds: [0, 0, 1059, 1647] }));
    const env = { HERDR_APP_HOME: home };
    expect(popupBox(home)).toEqual({ width: 900, height: 1400 });

    // Tall TD passes without warning in portrait
    const tdRun = run(["mermaid", "check"], env, tallTD);
    expect(tdRun.code).toBe(0);
    expect(tdRun.out).toContain("preview:");
    expect(tdRun.out).toContain("fits the popup (900x1400) at 100% size");
    expect(tdRun.out).not.toContain("warning:");

    // Wide LR is too wide for portrait popup (900px) and warns to switch to TD
    const lrRun = run(["mermaid", "check"], env, wideLR);
    expect(lrRun.code).toBe(0);
    expect(lrRun.out).toContain("preview:");
    expect(lrRun.out).toContain("fits the popup (900x1400) at 58% size");
    expect(lrRun.out).toContain(
      "warning: text shows at 58% when fitted; split it, shorten labels, or switch direction (TD)",
    );
  });

  test("landscape window: wide LR passes, tall TD warns to switch to LR", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-draw-fit-landscape-"));
    // 1718 x 1073 with 0.85 dialog overlay gives 1460 x 912
    writeFileSync(join(home, "window.json"), JSON.stringify({ state: "windowed", bounds: [1727, 1089, 1718, 1073] }));
    const env = { HERDR_APP_HOME: home };
    expect(popupBox(home)).toEqual({ width: 1460, height: 912 });

    // Wide LR (1550x82) fits in 1460x912 at 94% size (>= MIN_FIT 70%) without warning
    const lrRun = run(["mermaid", "check"], env, wideLR);
    expect(lrRun.code).toBe(0);
    expect(lrRun.out).toContain("preview:");
    expect(lrRun.out).toContain("fits the popup (1460x912) at 94% size");
    expect(lrRun.out).not.toContain("warning:");

    // Very tall TD in landscape warns to switch to LR
    const veryTallTD = `flowchart TD
  A[Start Task] --> B[Step 1: Ingest Data]
  B --> C[Step 2: Parse Tokens]
  C --> D[Step 3: Build Graph]
  D --> E[Step 4: Layout Nodes]
  E --> F[Step 5: Render Edges]
  F --> G[Step 6: Apply Theme]
  G --> H[Step 7: Check Readability]
  H --> I[Step 8: Output Preview]
  I --> J[Step 9: Additional Work]
  J --> K[Step 10: Deep Analysis]
  K --> L[Step 11: Complex Routing]
  L --> M[Step 12: Extra Validation]
  M --> N[Step 13: Edge Case Inspection]
  N --> O[Step 14: Quality Assurance]
  O --> P[Done]
`;
    const tdRun = run(["mermaid", "check"], env, veryTallTD);
    expect(tdRun.code).toBe(0);
    expect(tdRun.out).toContain("preview:");
    expect(tdRun.out).toContain("fits the popup (1460x912) at 60% size");
    expect(tdRun.out).toContain(
      "warning: text shows at 60% when fitted; split it, shorten labels, or switch direction (LR)",
    );
  });

  test("windows.json fallback is supported when window.json is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-draw-fit-windows-"));
    writeFileSync(join(home, "windows.json"), JSON.stringify({ main: { bounds: [0, 0, 1059, 1647] } }));
    expect(popupBox(home)).toEqual({ width: 900, height: 1400 });
  });
});

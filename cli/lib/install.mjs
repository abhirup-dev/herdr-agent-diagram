// herdr-draw install | uninstall | doctor: sets up this machine (the one running the Herdr app) and, only when
// asked, other machines from `hc machine ls`, so agents running there can draw too.
//   This machine: the CLI (~/.local/bin/herdr-draw), the mods (diagram-pane, diagram-popup, excal-canvas) and the
//   skills for the chosen agents. Another machine ("headless"): the CLI and skills only; its visuals show here.
// Nothing is installed on another machine unless the person picks it (interactive) or passes --machines / -y.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { logger } from "../../src/log/log.mjs";
import { parse } from "./args.mjs";

const log = logger("install");
const SRC = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "../..");
const VERSION = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version;
const HOME = os.homedir();
const MODS = ["diagram-pane", "diagram-popup", "excal-canvas"];
const SKILLS = ["herdr-canvas-mod"];
/** Names earlier versions installed: their links are removed on install and uninstall. */
const OLD_SKILLS = ["herdr-canvas", "herdr-diagram"];
/** Where each agent reads personal skills from. */
const AGENTS = {
  claude: { bin: "claude", skills: ".claude/skills" },
  pi: { bin: "pi", skills: ".pi/agent/skills" },
  codex: { bin: "codex", skills: ".codex/skills" },
};
/** Where a synced machine keeps its copy (same layout as the bootstrap's clone). */
const REMOTE_DIR = ".local/share/herdr-draw";

export const HELP = `herdr-draw install: set up herdr-draw on this machine and, if you choose, on your other machines.

usage: herdr-draw install [-y] [--agents claude,pi,codex | --agents none] [--machines vpsme,... | --no-machines]
       herdr-draw uninstall [-y] [--machines vpsme,...]
       herdr-draw doctor
       herdr-draw --version

  install             the CLI (~/.local/bin/herdr-draw), the mods and the skills here; then, if chosen, other machines
  uninstall           remove them here and from the synced machines (or only the --machines given)
  doctor              check the setup here and on synced machines; exits 1 if something is missing
  -y, --yes           no questions: every detected agent, and every connected machine unless --machines/--no-machines
  --agents LIST       which agents get the skills (claude, pi, codex; default: the ones found); none for no skills
  --machines LIST     other machines (hc machine ls) that get the CLI and skills, so agents there can draw;
                      their canvases and pins show in this Herdr app
  --no-machines       only this machine
  --headless          (used on other machines) CLI and skills only, no Herdr app here
  -V, --version       print the version (doctor compares it across machines)
`;

// ---------- small helpers ----------

const appHome = (env) => env.HERDR_APP_HOME ?? path.join(HOME, ".config/herdr-app");
const stateFile = (env) => path.join(appHome(env), "data/herdr-draw/install.json");
const binDir = () => path.join(HOME, ".local/bin");
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const say = (msg) => process.stdout.write(`${msg}\n`);
const die = (msg) => {
  process.stderr.write(`herdr-draw install: ${msg}\n`);
  process.exit(1);
};

/** install/uninstall/doctor options (see args.mjs). */
export function program() {
  const cli = cac("herdr-draw install");
  cli.option("-h, --help", "help");
  cli
    .command("")
    .option("-y, --yes", "no questions")
    .option("--agents <list>", "agents")
    .option("--machines [list]", "machines")
    .option("--no-machines", "only this machine")
    .option("--headless", "no Herdr app here");
  return cli;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const { options } = parse(program(), argv);
  const list = (v) => (typeof v === "string" ? v.split(",").filter(Boolean) : null);
  /** @type {{ yes: boolean, headless: boolean, agents: string[] | null, machines: string[] | null, help?: true }} */
  const o = {
    yes: Boolean(options.yes),
    headless: Boolean(options.headless),
    agents: list(options.agents),
    // --no-machines is false, a bare --machines true, but no flag at all is also true (cac's default for --no-)
    machines:
      options.machines === false || (options.machines === true && argv.includes("--machines"))
        ? []
        : list(options.machines),
    ...(options.help ? { help: true } : {}),
  };
  const bad = (o.agents ?? []).filter((a) => a !== "none" && !AGENTS[a]);
  if (bad.length) die(`unknown agent ${bad.join(", ")} (known: ${Object.keys(AGENTS).join(", ")}, or none)`);
  return o;
}

/** Questions go to the terminal even under `curl ... | sh` (stdin is the script then). */
function asker(yes) {
  if (yes) return null;
  let input;
  try {
    input = fs.createReadStream("/dev/tty");
  } catch {
    return null;
  }
  const rl = createInterface({ input, output: process.stdout });
  return {
    async yesNo(q, def = true) {
      const a = (await rl.question(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      return a ? a.startsWith("y") : def;
    },
    async pick(q, all, def) {
      const a = (await rl.question(`${q} (${all.join(", ")}) [${def.join(",") || "none"}] `)).trim();
      if (!a) return def;
      if (a === "none") return [];
      return a.split(/[\s,]+/).filter((x) => all.includes(x));
    },
    close: () => {
      rl.close();
      input.destroy();
    },
  };
}

/** A bun that runs, as an absolute path: the CLI wrapper pins it so agents' PATH doesn't matter. */
function bunPath() {
  const candidates = [
    process.versions.bun ? process.execPath : null,
    path.join(HOME, ".bun/bin/bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ];
  const found = candidates.find((c) => c && spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
  if (found) return found;
  const which = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
  return which || die("bun not found: install it first (curl -fsSL https://bun.sh/install | bash)");
}

const detectAgents = () => Object.keys(AGENTS).filter((a) => has(AGENTS[a].bin));

// ---------- this machine ----------

function writeCli(bun) {
  fs.mkdirSync(binDir(), { recursive: true });
  const file = path.join(binDir(), "herdr-draw");
  if (fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file);
  fs.writeFileSync(
    file,
    `#!/bin/sh\n# herdr-draw ${VERSION}, installed from ${SRC}\nexec "${bun}" "${SRC}/cli/herdr-draw.mjs" "$@"\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

/** A skill link herdr-draw made (it points at some herdr-draw copy's skills/<name>); others are left alone. */
const ourLink = (link, name) => {
  try {
    return fs.readlinkSync(link).endsWith(`/skills/${name}`) && fs.existsSync(path.join(link, "SKILL.md"));
  } catch {
    return false;
  }
};

/** Removes links to skills under their old names (they now dangle: the folder was renamed). */
function removeOldLinks(dir) {
  for (const s of OLD_SKILLS) {
    const link = path.join(dir, s);
    try {
      if (fs.readlinkSync(link).endsWith(`/skills/${s}`)) fs.unlinkSync(link);
    } catch {}
  }
}

function linkSkills(agents) {
  const done = [];
  for (const a of agents) {
    const dir = path.join(HOME, AGENTS[a].skills);
    fs.mkdirSync(dir, { recursive: true });
    removeOldLinks(dir);
    for (const s of SKILLS) {
      const link = path.join(dir, s);
      const cur = fs.lstatSync(link, { throwIfNoEntry: false });
      if (cur && !ourLink(link, s) && fs.existsSync(link)) {
        say(`  skip ${link}: something else is there (yours?), not replacing it`);
        continue;
      }
      if (cur) fs.unlinkSync(link);
      fs.symlinkSync(path.join(SRC, "skills", s), link);
    }
    done.push(a);
  }
  return done;
}

function installMods(env, bun) {
  const r = spawnSync(bun, ["run", "--silent", "build:mod"], { cwd: SRC, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) die("building the canvas mod failed (bun run build:mod)");
  const from = {
    "diagram-pane": "mods/diagram-pane",
    "diagram-popup": "mods/diagram-popup",
    "excal-canvas": "dist/mods/excal-canvas",
  };
  for (const m of MODS) {
    const to = path.join(appHome(env), "mods", m);
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(path.join(SRC, from[m]), to, { recursive: true });
  }
}

function saveState(env, state) {
  const file = stateFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export const loadState = (env) => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(env), "utf8"));
  } catch {
    return null;
  }
};

// ---------- other machines ----------

const hcJson = (args) => JSON.parse(execFileSync("hc", [...args, "--json"], { encoding: "utf8" }));
/** Runs a shell script on a machine; returns its output, or throws with what it printed. */
function onMachine(m, script, { input, timeout = 120 } = {}) {
  const r = spawnSync(
    "hc",
    ["exec", "--on", m, "--timeout", String(timeout), ...(input ? ["-i"] : []), "sh", "-c", script],
    {
      input,
      encoding: input ? undefined : "utf8",
      maxBuffer: 64 << 20,
    },
  );
  const out = String(r.stdout ?? "");
  log(
    `${m}: exec (${input ? `stdin ${input.length} B, ` : ""}timeout ${timeout}s) ${script.replace(/\s+/g, " ").slice(0, 200)} -> ${r.status}${
      r.status
        ? ` ${String(r.stderr ?? "")
            .trim()
            .slice(0, 300)}`
        : ""
    }`,
  );
  if (r.status !== 0) throw new Error(`${m}: ${String(r.stderr ?? "").trim() || out.trim() || `exit ${r.status}`}`);
  return out;
}

function listMachines() {
  if (!has("hc")) return [];
  try {
    return hcJson(["machine", "ls"]).machines.filter((m) => m.state === "connected");
  } catch {
    return [];
  }
}

/** The package's own files (no node_modules, no build output), as a gzipped tar. */
function packTar() {
  let files;
  try {
    files = execFileSync("git", ["-C", SRC, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    files = ["package.json", "bun.lock", "cli", "src", "skills", "mods", "scripts"];
  }
  return execFileSync("tar", ["-czf", "-", "-C", SRC, ...files], { maxBuffer: 256 << 20 });
}

const remoteAgents = (m) =>
  Object.keys(AGENTS).filter((a) =>
    onMachine(
      m,
      `command -v ${AGENTS[a].bin} >/dev/null || test -d "$HOME/${path.dirname(AGENTS[a].skills)}" && echo yes || true`,
    ).includes("yes"),
  );

/** bun.lock is lockfile v2: older bun can't read it. */
const MIN_BUN = "1.4";
/** herdr-draw's own bun on a machine whose bun is missing or too old; never replaces theirs. */
const PRIVATE_BUN = ".local/share/herdr-draw-bun";
/** Sets $B to a bun >= MIN_BUN on that machine, or empty. */
const REMOTE_BUN = [
  'B=""; for c in "$HOME/' + PRIVATE_BUN + '/bun" "$(command -v bun)" "$HOME/.bun/bin/bun"; do',
  '[ -x "$c" ] || continue; case "$("$c" --version 2>/dev/null)" in 1.[4-9]*|1.[1-9][0-9]*|[2-9]*) B="$c"; break;; esac; done',
].join(" ");
/** Downloads a release bun into PRIVATE_BUN: no installer script, so no shell-profile edits. */
const PRIVATE_BUN_INSTALL = `D="$HOME/${PRIVATE_BUN}"; mkdir -p "$D" && cd "$D" &&
case "$(uname -s)-$(uname -m)" in Linux-x86_64) a=linux-x64;; Linux-aarch64|Linux-arm64) a=linux-aarch64;;
  Darwin-arm64) a=darwin-aarch64;; Darwin-x86_64) a=darwin-x64;; *) echo "unsupported $(uname -sm)"; exit 1;; esac &&
curl -fsSL -o bun.zip "https://github.com/oven-sh/bun/releases/latest/download/bun-$a.zip" &&
{ unzip -oq bun.zip || python3 -m zipfile -e bun.zip .; } && mv "bun-$a/bun" bun && chmod +x bun && rm -rf bun.zip "bun-$a" && ./bun --version`;

async function syncMachine(m, agents, ask) {
  say(`\n${m}: copying herdr-draw ${VERSION} to ~/${REMOTE_DIR}`);
  // A clean copy (files from older versions go), keeping node_modules so bun install stays quick.
  const extract = `D="$HOME/${REMOTE_DIR}"; mkdir -p "$D" && find "$D" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + && tar -xzf - -C "$D"`;
  onMachine(m, extract, {
    input: packTar(),
    timeout: 300,
  });
  if (!onMachine(m, `${REMOTE_BUN}; echo "$B"`).trim()) {
    const q = `${m} has no bun >= ${MIN_BUN}. Download one just for herdr-draw into ~/${PRIVATE_BUN} (your bun stays)?`;
    if (ask && !(await ask.yesNo(q))) throw new Error(`${m}: needs bun >= ${MIN_BUN}; skipped`);
    say(`${m}: downloading bun into ~/${PRIVATE_BUN}`);
    onMachine(m, PRIVATE_BUN_INSTALL, { timeout: 300 });
  }
  say(`${m}: installing dependencies and skills (${agents.join(", ") || "no agents"})`);
  const flags = `-y --headless --agents ${agents.join(",") || "none"}`;
  const out = onMachine(
    m,
    `${REMOTE_BUN}; cd "$HOME/${REMOTE_DIR}" && "$B" install --production --frozen-lockfile >/dev/null && "$B" cli/herdr-draw.mjs install ${flags}`,
    { timeout: 600 },
  );
  for (const line of out.trim().split("\n")) say(`  ${m}| ${line}`);
}

async function chooseMachines(o, ask) {
  const all = listMachines();
  if (o.machines) {
    const unknown = o.machines.filter((n) => !all.some((m) => m.name === n));
    if (unknown.length) die(`not connected machines: ${unknown.join(", ")} (hc machine ls)`);
    return o.machines;
  }
  if (!all.length) return [];
  if (!ask) return o.yes ? all.map((m) => m.name) : [];
  say(`\nYour other machines: ${all.map((m) => m.name).join(", ")}`);
  say("herdr-draw can sync its CLI and skills there, so agents on them can draw; nothing runs until they do.");
  return ask.pick(
    "Sync to which machines?",
    all.map((m) => m.name),
    [],
  );
}

// ---------- commands ----------

async function install(o, env) {
  const ask = asker(o.yes);
  try {
    const bun = bunPath();
    const found = detectAgents();
    let agents = o.agents?.filter((a) => a !== "none") ?? found;
    if (!o.agents && ask && !o.headless)
      agents = await ask.pick("Install skills for which agents?", Object.keys(AGENTS), found);
    say(o.headless ? `herdr-draw ${VERSION} (headless: no Herdr app here)` : `herdr-draw ${VERSION} on this machine`);
    say(`  cli     ${writeCli(bun)}`);
    if (!o.headless) {
      installMods(env, bun);
      say(`  mods    ${MODS.join(", ")} -> ${path.join(appHome(env), "mods")}`);
    }
    say(`  skills  ${linkSkills(agents).join(", ") || "none"}`);
    if (!process.env.PATH?.split(":").includes(binDir())) say(`  note    add ${binDir()} to your PATH`);
    if (o.headless) return;

    const prev = loadState(env)?.machines ?? {};
    const machines = await chooseMachines(o, ask);
    const synced = { ...prev };
    for (const m of machines) {
      try {
        const there = remoteAgents(m);
        const chosen = ask
          ? await ask.pick(`Skills on ${m} for which agents?`, Object.keys(AGENTS), there)
          : (o.agents ?? there);
        await syncMachine(m, chosen, ask);
        synced[m] = { agents: chosen, version: VERSION, synced: new Date().toISOString() };
      } catch (e) {
        say(`  ${e.message}`);
      }
    }
    saveState(env, { version: VERSION, src: SRC, agents, machines: synced });
    say(
      `\ndone. ${Object.keys(synced).length ? `Synced machines: ${Object.keys(synced).join(", ")}. ` : ""}Agents use it through the skills; check with: herdr-draw doctor`,
    );
  } finally {
    ask?.close();
  }
}

function removeLocal(env, headless) {
  const cli = path.join(binDir(), "herdr-draw");
  if (fs.existsSync(cli) && fs.readFileSync(cli, "utf8").includes("herdr-draw")) fs.unlinkSync(cli);
  for (const a of Object.values(AGENTS)) {
    removeOldLinks(path.join(HOME, a.skills));
    for (const s of SKILLS) {
      const link = path.join(HOME, a.skills, s);
      if (ourLink(link, s)) fs.unlinkSync(link);
    }
  }
  if (headless) return;
  for (const m of MODS) fs.rmSync(path.join(appHome(env), "mods", m), { recursive: true, force: true });
  fs.rmSync(stateFile(env), { force: true });
}

async function uninstall(o, env) {
  const machines = o.machines ?? Object.keys(loadState(env)?.machines ?? {});
  const ask = asker(o.yes);
  try {
    for (const m of machines) {
      if (ask && !(await ask.yesNo(`Remove herdr-draw from ${m} too?`))) continue;
      try {
        onMachine(
          m,
          `${REMOTE_BUN}; "$B" "$HOME/${REMOTE_DIR}/cli/herdr-draw.mjs" uninstall -y --headless && rm -rf "$HOME/${REMOTE_DIR}" "$HOME/${PRIVATE_BUN}"`,
        );
        say(`${m}: removed`);
      } catch (e) {
        say(`  ${e.message}`);
      }
    }
    removeLocal(env, o.headless);
    say(o.headless ? "removed the CLI and skills" : "removed the CLI, mods and skills (the repo or clone stays)");
  } finally {
    ask?.close();
  }
}

function doctor(env) {
  const rows = [];
  const check = (what, ok, hint = "") =>
    rows.push(`${ok ? "ok  " : "FAIL"} ${what}${ok || !hint ? "" : `  -> ${hint}`}`);
  const state = loadState(env);
  check("bun", Boolean(bunPath()));
  check("hc (herdr-core)", has("hc"), "install Herdr");
  check("herdr-draw on PATH", has("herdr-draw"), `add ${binDir()} to PATH`);
  for (const m of MODS)
    check(`mod ${m}`, fs.existsSync(path.join(appHome(env), "mods", m, "main.js")), "herdr-draw install");
  for (const a of state?.agents ?? detectAgents())
    for (const s of SKILLS)
      check(`${a} skill ${s}`, fs.existsSync(path.join(HOME, AGENTS[a].skills, s, "SKILL.md")), "herdr-draw install");
  for (const [m, info] of Object.entries(state?.machines ?? {})) {
    let v = "";
    try {
      v = onMachine(m, `"$HOME/.local/bin/herdr-draw" --version`, { timeout: 30 }).trim();
    } catch {}
    const label = `${m}: herdr-draw ${v || "missing"} (skills: ${info.agents.join(", ") || "none"})`;
    check(label, v === VERSION, `herdr-draw install --machines ${m}`);
  }
  say(rows.join("\n"));
  if (rows.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
}

export const version = () => say(VERSION);

export function setup(cmd, argv, env) {
  const o = argv[0] === "help" ? { help: true } : parseArgs(argv);
  if (o.help) return process.stdout.write(HELP);
  if (cmd === "install") return install(o, env);
  if (cmd === "uninstall") return uninstall(o, env);
  return doctor(env);
}

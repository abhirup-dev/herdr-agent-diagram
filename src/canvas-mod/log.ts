import * as fs from "fs/promises";
import { appHome } from "herdr";

// Debug log for herdr-draw (`herdr-draw logs mod`): the mod runtime has no file append, so the last lines are kept
// here and the file rewritten (one writer at a time). Never throws.
const LOG_MAX = 300;
export function modLogger(
  name: string,
): ((msg: string) => void) & { use(cx: { spawn(f: () => Promise<void>): unknown }): void } {
  // Mods may only write under the app home (herdr.d.ts), so mod logs live there; `herdr-draw logs` reads both.
  const dir = `${appHome()}/data/herdr-draw/logs`;
  const file = `${dir}/mod-${name}.log`;
  let lines: string[] = [];
  let writing = false;
  let again = false;
  let loaded = false;
  // Async work in a mod runs through a view's cx.spawn: lines wait until a view lends its cx (log.use).
  let cx: { spawn(f: () => Promise<void>): unknown } | null = null;
  const write = async (): Promise<void> => {
    if (writing) {
      again = true;
      return;
    }
    writing = true;
    try {
      if (!loaded) {
        loaded = true;
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        const old = await fs.readFile(file, "utf8").catch(() => "");
        lines = old.split("\n").filter(Boolean).slice(-LOG_MAX).concat(lines);
      }
      if (lines.length > LOG_MAX) lines = lines.slice(-LOG_MAX);
      if (lines.length) await fs.writeFile(file, `${lines.join("\n")}\n`);
    } catch {
      // logging must never break the mod
    }
    writing = false;
    if (again) {
      again = false;
      flush();
    }
  };
  const flush = () => {
    if (cx) cx.spawn(write);
  };
  const log = (msg: string) => {
    lines.push(`${new Date().toISOString()} app mod-${name} info  ${msg}`);
    flush();
  };
  log.use = (viewCx: { spawn(f: () => Promise<void>): unknown }) => {
    cx = viewCx;
    flush();
  };
  return log;
}

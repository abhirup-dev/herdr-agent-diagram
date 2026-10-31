// Every board on this machine is written to a .excalidraw file shortly after it changes, so a board outlives the
// sidecar: an agent (or the person) brings it back with `herdr-draw canvas import <file>`. Nothing reads these files
// on start: no automatic recovery (yet).
//   $HERDR_DRAW_BOARDS, default ${XDG_STATE_HOME:-~/.local/state}/herdr-draw/boards/<board>.excalidraw
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sceneFile } from "../board/scene-file.ts";
import { logger } from "../log/log.mjs";

const debug = logger("sidecar").debug;

export const boardsDir = (env = process.env): string =>
  env.HERDR_DRAW_BOARDS ??
  path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "herdr-draw", "boards");

type Log = (msg: string) => void;

/** Debounced, atomic writes per board: a burst of edits is one write. */
export class BoardSaver {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly dir: string = boardsDir(),
    private readonly log: Log = () => {},
    private readonly delayMs = 1000,
  ) {}

  /** `elements` is read when the write happens, so it sees the latest state. Ids are path-safe (local boards). */
  schedule(board: string, elements: () => readonly object[]): void {
    clearTimeout(this.#timers.get(board));
    this.#timers.set(
      board,
      setTimeout(() => {
        this.#timers.delete(board);
        this.write(board, elements());
      }, this.delayMs),
    );
  }

  write(board: string, elements: readonly object[]): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${board}.excalidraw`);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(sceneFile(elements), null, 2));
      fs.renameSync(tmp, file);
      debug(`saved board ${board}: ${elements.length} element(s) -> ${file}`);
    } catch (e) {
      this.log(`saving board ${board} failed: ${String(e)}`);
    }
  }
}

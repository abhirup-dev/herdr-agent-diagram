// The Excalidraw SDK, headless: scene preparation (shorthand -> full elements) and screenshots. Both run the
// vendored upstream renderer (jsdom globals + the bundled SDK, loaded once per process and shared by every
// board). Calls are serialised: they share one jsdom document and its global state.

import { isCanvasElement } from "../canvas/types.ts";
import { labelWarnings } from "./layout.ts";
import { prepareScene } from "./upstream/core/render/excalidraw-node/index.js";
import { type RenderOptions, type RenderResult, renderScene } from "./upstream/core/render/index.js";

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/** Elements as the canvas shows them: shorthand expanded, labels bound, arrows bound, restored. */
export const prepare = (elements: readonly object[]): Promise<Record<string, unknown>[]> =>
  serial(() => prepareScene(elements as Record<string, never>[]));

/** A PNG (base64) or SVG of the elements. */
export const render = (elements: readonly object[], options: RenderOptions): Promise<RenderResult> =>
  serial(() => renderScene({ elements: elements as Record<string, never>[], files: {} }, options));

/** Additive CLI diagnostics, omitted when no arrow label needs more room. */
export async function renderingWarnings(elements: readonly object[]): Promise<{ warnings?: string[] }> {
  const live = await prepare(elements);
  const warnings = labelWarnings((live as { type: string }[]).filter(isCanvasElement));
  return warnings.length ? { warnings } : {};
}

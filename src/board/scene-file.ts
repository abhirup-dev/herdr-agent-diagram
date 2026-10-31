// A board as a .excalidraw file: what `export` prints and what the sidecar saves in the background. `import` reads
// it back, and excalidraw.com opens it.
import { expandElementsForExport } from "./upstream/core/expand-elements.js";

export interface SceneFile {
  readonly type: "excalidraw";
  readonly version: 2;
  readonly source: string;
  readonly elements: readonly object[];
  readonly appState: object;
}

export function sceneFile(elements: readonly object[]): SceneFile {
  return {
    type: "excalidraw",
    version: 2,
    source: "herdr-draw",
    elements: expandElementsForExport(elements as never, { deterministic: true }) as object[],
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
  };
}

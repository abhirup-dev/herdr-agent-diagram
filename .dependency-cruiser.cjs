// Layering: src/canvas is the shared, pure core; the mod (runs inside Herdr's slow, DOM-less JS runtime) and the
// sidecar (Bun) both build on it and never on each other. src/board (the board store, REST API and CLI) builds on
// the core only; the sidecar hosts it. `bun run lint:deps` fails on any violation.
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "core-stays-pure",
      comment: "src/canvas is shared by the mod and the sidecar: it must not reach into either.",
      severity: "error",
      from: { path: "^src/canvas/" },
      to: { path: "^src/(canvas-mod|sidecar|board)/" },
    },
    {
      name: "mod-not-sidecar",
      severity: "error",
      from: { path: "^src/canvas-mod/" },
      to: { path: "^src/sidecar/" },
    },
    {
      name: "sidecar-not-mod",
      severity: "error",
      from: { path: "^src/sidecar/" },
      to: { path: "^src/canvas-mod/" },
    },
    {
      name: "board-stands-alone",
      comment: "src/board is used by the sidecar and the CLI: it must not reach into either host or the mod.",
      severity: "error",
      from: { path: "^src/board/" },
      to: { path: "^src/(canvas-mod|sidecar)/" },
    },
    {
      name: "mod-not-board",
      comment: "The board is Bun code (jsdom, the Excalidraw SDK); the mod talks to it over the WebSocket only.",
      severity: "error",
      from: { path: "^src/canvas-mod/" },
      to: { path: "^src/board/" },
    },
    {
      name: "mod-runtime-no-npm",
      comment: "The mod bundle runs in Herdr's mod runtime: npm code there is slow or breaks (no DOM, no timers). Types are fine.",
      severity: "error",
      from: { path: "^src/canvas-mod/" },
      to: { dependencyTypes: ["npm"], dependencyTypesNot: ["type-only"] },
    },
    { name: "no-orphans", severity: "warn", from: { orphan: true, pathNot: "\\.d\\.ts$|(^|/)tsconfig\\.json$|^scripts/" }, to: {} },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    parser: "swc",
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};

// Layering: src/canvas is the shared, pure core; the mod (runs inside Herdr's slow, DOM-less JS runtime) and the
// sidecar (Bun) both build on it and never on each other. `bun run lint:deps` fails on any violation.
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "core-stays-pure",
      comment: "src/canvas is shared by the mod and the sidecar: it must not reach into either.",
      severity: "error",
      from: { path: "^src/canvas/" },
      to: { path: "^src/(canvas-mod|sidecar)/" },
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
      name: "bridge-stands-alone",
      comment: "src/bridge (relay and remote endpoint) builds on the shared core only; the sidecar uses it at integration.",
      severity: "error",
      from: { path: "^src/bridge/" },
      to: { path: "^src/(canvas-mod|sidecar)/" },
    },
    {
      name: "no-bridge-in-mod-or-core",
      comment: "The bridge spawns processes (Bun): the mod runtime can't run it and the pure core must not depend on it.",
      severity: "error",
      from: { path: "^src/(canvas-mod|canvas)/" },
      to: { path: "^src/bridge/" },
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

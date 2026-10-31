// Diffs two prepared scenes into a patch, and gives agent elements stable seeds. No IO, so it is unit-tested.

/** An element as a board stores it: agent shorthand (label/start/end) or a full Excalidraw element. */
export type RawElement = Readonly<Record<string, unknown>> & { readonly id: string };

export interface Keyed {
  readonly id: string;
}

export interface Patch<T extends Keyed> {
  readonly upsert: T[];
  readonly remove: string[];
}

/** Fields the SDK regenerates on every conversion; they don't change what is drawn. */
const VOLATILE = new Set(["updated", "versionNonce"]);
const stable = (el: object) => JSON.stringify(el, (k, v) => (VOLATILE.has(k) ? undefined : v));

/** What changed between two prepared scenes, by deep comparison (server updates don't always bump `version`). */
export function diff<T extends Keyed>(prev: ReadonlyMap<string, T>, next: readonly T[]): Patch<T> {
  const upsert = next.filter((el) => {
    const old = prev.get(el.id);
    return old === undefined || stable(old) !== stable(el);
  });
  const ids = new Set(next.map((el) => el.id));
  return { upsert, remove: [...prev.keys()].filter((id) => !ids.has(id)) };
}

/**
 * A seed derived from the id (FNV-1a), for elements the agent created without one: the SDK would otherwise
 * pick a random seed on every conversion and the hand-drawn strokes would re-wobble on each edit.
 */
export function stableSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 2 ** 31 || 1;
}

/** Raw elements with a stable seed filled in where missing. */
export const withSeeds = (els: Iterable<RawElement>): RawElement[] =>
  [...els].map((el) => (typeof el.seed === "number" ? el : { ...el, seed: stableSeed(el.id) }));

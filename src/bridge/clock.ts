// Time behind an interface so heartbeat and backoff tests run instantly.
export interface Clock {
  now(): number;
  /** Runs `fn` once after `ms`; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

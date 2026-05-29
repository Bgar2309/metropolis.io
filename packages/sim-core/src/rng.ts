// Deterministic seeded PRNG. No Math.random / Date.now anywhere in sim-core so that
// the same seed + same command stream always reproduces an identical world. This is
// what makes replays, time-lapses, and server-side ranked verification possible.

// mulberry32: fast, good-enough 32-bit generator. State is a single uint32 so it
// serializes trivially into save files.
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force into uint32 range; avoid a zero state producing a short cycle.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Snapshot the internal state (for save files). */
  getState(): number {
    return this.state >>> 0;
  }

  /** Restore from a snapshot (for loading saves / replays). */
  setState(state: number): void {
    this.state = state >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

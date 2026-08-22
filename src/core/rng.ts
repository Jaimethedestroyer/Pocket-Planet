/**
 * Deterministic pseudo-random number generation.
 *
 * Nothing in the simulation or in world generation may call Math.random().
 * Every random value must be traceable back to the world seed, so that
 * `seed + player event log` fully reproduces a planet and its history.
 */

/** Hash an arbitrary string into a 32-bit unsigned integer seed. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix a base seed with a stream id so independent systems never correlate. */
export function mixSeed(seed: number, stream: number): number {
  let h = (seed ^ Math.imul(stream, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max). */
  int(min: number, max: number): number;
  /** Approximately normal, mean 0, stddev 1. */
  normal(): number;
  /** True with the given probability. */
  chance(p: number): boolean;
  /** Uniformly distributed point on the unit sphere. */
  onSphere(): { x: number; y: number; z: number };
}

/** One step of mulberry32. Shared so `makeRng` and `Stream` cannot drift. */
function step(a: number): number {
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * The same generator, reseedable, and without the six closures `makeRng`
 * allocates.
 *
 * For the ordinary case — a system that wants one stream and keeps it — that
 * allocation is irrelevant and `makeRng` reads better. This is for the case the
 * town planner has: a *separate* stream per building plot, seeded from the plot
 * rather than drawn in sequence, because a shared sequential generator is what
 * makes a town rearrange itself as it grows. Several hundred of those per town
 * and forty towns in flight made building the generators a tenth of the whole
 * cost of planning. One instance, reseeded, produces bit-identical values.
 */
export class Stream implements Rng {
  private a = 0;

  reseed(seed: number): this {
    this.a = seed >>> 0;
    return this;
  }

  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    return step(this.a);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(min + this.next() * (max - min));
  }

  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  onSphere(): { x: number; y: number; z: number } {
    const z = this.next() * 2 - 1;
    const t = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(t), y: r * Math.sin(t), z };
  }
}

/**
 * mulberry32 — small, fast, and good enough for world generation and
 * simulation. Period 2^32, which is far beyond anything a single stream
 * consumes in a game session.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    return step(a);
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min)),
    normal: () => {
      // Box-Muller, one value per call. The second value is discarded to keep
      // the generator stateless from the caller's point of view.
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    chance: (p) => next() < p,
    onSphere: () => {
      const z = next() * 2 - 1;
      const t = next() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return { x: r * Math.cos(t), y: r * Math.sin(t), z };
    },
  };
}

/**
 * The simulation's view of the planet.
 *
 * A Fibonacci-spiral point set over the sphere, sampled from the same terrain
 * function the renderer meshes. These cells are never drawn: territory is
 * painted as a smooth field, so the player sees borders as curves rather than
 * as the edges of the graph underneath. The graph exists only so that
 * population, culture and armies have somewhere to flow.
 */

import { PlanetField } from '../planet/heightfield';
import { MAX_ELEVATION, PLANET_RADIUS } from '../planet/config';
import { CellFlag } from './types';

/** Neighbours stored per cell. Six matches the average valence of the point set. */
export const NEIGHBOURS = 6;

export interface CellGraph {
  count: number;
  /** Unit position, three floats per cell. */
  position: Float32Array;
  /** Neighbour indices, `NEIGHBOURS` per cell, -1 padded. */
  neighbours: Int32Array;

  height: Float32Array;
  moisture: Float32Array;
  temperature: Float32Array;
  flags: Uint8Array;

  /** How much life a cell can support before technology, 0..1. */
  habitability: Float32Array;

  landCells: Int32Array;
  /** Surface area represented by one cell, in square metres. */
  cellArea: number;
}

/**
 * Fibonacci sphere. Gives a near-uniform point distribution with no poles and
 * no seams, and — usefully — generates points already sorted by latitude, which
 * is what makes the neighbour search below cheap.
 */
function fibonacciSphere(count: number, out: Float32Array): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out[i * 3] = Math.cos(theta) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * r;
  }
}

/**
 * Nearest-neighbour graph.
 *
 * Because the point set is sorted by latitude, and the nearest neighbours of a
 * cell are always within about twice the mean point spacing, only a band of the
 * array needs to be searched. That turns an O(n^2) sweep into something linear
 * enough to build five hundred worlds in a soak run without noticing.
 */
function buildNeighbours(count: number, pos: Float32Array): Int32Array {
  const out = new Int32Array(count * NEIGHBOURS).fill(-1);
  // Mean angular spacing between points on a unit sphere with uniform density.
  const spacing = Math.sqrt((4 * Math.PI) / count);
  const window = Math.ceil(count * spacing * 0.5) + 12;

  const bestIdx = new Int32Array(NEIGHBOURS);
  const bestDot = new Float64Array(NEIGHBOURS);

  for (let i = 0; i < count; i++) {
    bestIdx.fill(-1);
    // Cosine similarity: larger is nearer, so seed with the worst possible.
    bestDot.fill(-2);

    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];

    const lo = Math.max(0, i - window);
    const hi = Math.min(count - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const d = x * pos[j * 3] + y * pos[j * 3 + 1] + z * pos[j * 3 + 2];
      // Insertion into a tiny sorted list beats a full sort of the window.
      if (d <= bestDot[NEIGHBOURS - 1]) continue;
      let k = NEIGHBOURS - 1;
      while (k > 0 && bestDot[k - 1] < d) {
        bestDot[k] = bestDot[k - 1];
        bestIdx[k] = bestIdx[k - 1];
        k--;
      }
      bestDot[k] = d;
      bestIdx[k] = j;
    }
    for (let k = 0; k < NEIGHBOURS; k++) out[i * NEIGHBOURS + k] = bestIdx[k];
  }
  return out;
}

function gaussian(x: number, centre: number, width: number): number {
  const t = (x - centre) / width;
  return Math.exp(-t * t);
}

/**
 * How much population a cell can support before technology.
 *
 * Warm and damp is best, but nothing habitable drops to exactly zero except
 * water and ice — a civilization that cannot cross a desert never builds an
 * empire worth watching.
 */
function habitabilityOf(
  height: number,
  moisture: number,
  temperature: number,
  coast: boolean,
): number {
  if (height <= 0) return 0;

  const warmth = gaussian(temperature, 0.66, 0.3);
  const damp = 0.18 + 0.82 * gaussian(moisture, 0.62, 0.34);
  // High ground is thin and steep; the penalty starts well up the range.
  const altitude = 1 - Math.min(1, Math.max(0, (height / MAX_ELEVATION - 0.42) / 0.5)) * 0.75;

  let h = warmth * damp * altitude;
  // Coasts get fishing, trade and a milder climate.
  if (coast) h = Math.min(1, h * 1.25 + 0.06);
  return Math.max(0, Math.min(1, h));
}

export function buildCellGraph(field: PlanetField, count: number): CellGraph {
  const position = new Float32Array(count * 3);
  fibonacciSphere(count, position);

  const neighbours = buildNeighbours(count, position);

  const height = new Float32Array(count);
  const moisture = new Float32Array(count);
  const temperature = new Float32Array(count);
  const flags = new Uint8Array(count);
  const habitability = new Float32Array(count);

  // Sample at the graph's own resolution, not the renderer's: the simulation
  // should see the shape of a region, not the boulders in it.
  const cellArea = (4 * Math.PI * PLANET_RADIUS * PLANET_RADIUS) / count;
  const spacing = Math.sqrt(cellArea);
  const sample = new Float64Array(3);

  for (let i = 0; i < count; i++) {
    field.evaluate(position[i * 3], position[i * 3 + 1], position[i * 3 + 2], spacing, sample);
    height[i] = sample[0];
    moisture[i] = sample[1];
    temperature[i] = sample[2];
    if (sample[0] > 0) flags[i] |= CellFlag.Land;
  }

  // Coast needs the land mask complete first.
  let landCount = 0;
  for (let i = 0; i < count; i++) {
    if (!(flags[i] & CellFlag.Land)) continue;
    landCount++;
    for (let k = 0; k < NEIGHBOURS; k++) {
      const n = neighbours[i * NEIGHBOURS + k];
      if (n >= 0 && !(flags[n] & CellFlag.Land)) {
        flags[i] |= CellFlag.Coast;
        break;
      }
    }
  }

  const landCells = new Int32Array(landCount);
  let w = 0;
  for (let i = 0; i < count; i++) {
    if (flags[i] & CellFlag.Land) {
      landCells[w++] = i;
      habitability[i] = habitabilityOf(
        height[i],
        moisture[i],
        temperature[i],
        (flags[i] & CellFlag.Coast) !== 0,
      );
    }
  }

  return {
    count,
    position,
    neighbours,
    height,
    moisture,
    temperature,
    flags,
    habitability,
    landCells,
    cellArea,
  };
}

/** Great-circle distance between two cells, in metres. */
export function cellDistance(graph: CellGraph, a: number, b: number): number {
  const d =
    graph.position[a * 3] * graph.position[b * 3] +
    graph.position[a * 3 + 1] * graph.position[b * 3 + 1] +
    graph.position[a * 3 + 2] * graph.position[b * 3 + 2];
  return Math.acos(Math.max(-1, Math.min(1, d))) * PLANET_RADIUS;
}

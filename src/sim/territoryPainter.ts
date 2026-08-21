/**
 * Territory as a painted field, not a set of cells.
 *
 * Each owned cell splats a soft radial blob of its polity's colour into an
 * equirectangular buffer, weighted by population so heartlands read stronger
 * than frontiers. Overlapping blobs blend, and the result is sampled by the
 * terrain shader as a tint.
 *
 * The point of doing it this way rather than colouring cell polygons is that
 * the player must never be able to see the simulation's graph. A border here is
 * wherever two colour fields happen to meet, which produces a curve — not the
 * edges of four thousand invisible cells.
 */

import { TERRITORY_HEIGHT, TERRITORY_WIDTH, polityColor } from './protocol';
import type { Simulation } from './sim';

export class TerritoryPainter {
  private width = TERRITORY_WIDTH;
  private height = TERRITORY_HEIGHT;
  /** Accumulators: premultiplied colour and total weight per texel. */
  private accum = new Float32Array(TERRITORY_WIDTH * TERRITORY_HEIGHT * 4);
  private out = new Uint8ClampedArray(TERRITORY_WIDTH * TERRITORY_HEIGHT * 4);
  private colors: [number, number, number][] = [];

  /** Angular radius of one cell's blob, in radians. */
  private blobRadius: number;

  constructor(cellCount: number) {
    // Roughly two cell spacings, so neighbouring cells of the same polity merge
    // into one mass instead of reading as a row of dots.
    this.blobRadius = Math.sqrt((4 * Math.PI) / cellCount) * 2.1;
  }

  paint(sim: Simulation): Uint8ClampedArray {
    this.accum.fill(0);

    // Colours only change when a polity is created, so cache them.
    for (const p of sim.polities) {
      if (!this.colors[p.id]) this.colors[p.id] = polityColor(p.hue);
    }

    const land = sim.graph.landCells;
    for (let i = 0; i < land.length; i++) {
      const cell = land[i];
      const owner = sim.owner[cell] - 1;
      if (owner < 0) continue;
      const pop = sim.population[cell];
      if (pop < 1) continue;

      const x = sim.graph.position[cell * 3];
      const y = sim.graph.position[cell * 3 + 1];
      const z = sim.graph.position[cell * 3 + 2];
      // Population weighting, damped: a capital should dominate its province,
      // not erase every village around it.
      const weight = 0.35 + Math.min(1, Math.sqrt(pop / 20000));
      this.splat(x, y, z, this.colors[owner], weight);
    }

    this.resolve();
    return this.out;
  }

  private splat(
    x: number,
    y: number,
    z: number,
    color: [number, number, number],
    weight: number,
  ): void {
    const lat = Math.asin(Math.max(-1, Math.min(1, y)));
    const lon = Math.atan2(z, x);

    const v = (0.5 - lat / Math.PI) * this.height;
    const u = ((lon / (Math.PI * 2) + 0.5) % 1) * this.width;

    const radiusV = (this.blobRadius / Math.PI) * this.height;
    // Equirectangular projection stretches longitude towards the poles, so the
    // blob has to widen to stay circular on the actual sphere.
    const cosLat = Math.max(0.08, Math.cos(lat));
    const radiusU = radiusV / cosLat;

    const v0 = Math.max(0, Math.floor(v - radiusV));
    const v1 = Math.min(this.height - 1, Math.ceil(v + radiusV));
    const u0 = Math.floor(u - radiusU);
    const u1 = Math.ceil(u + radiusU);

    for (let py = v0; py <= v1; py++) {
      const dv = (py + 0.5 - v) / radiusV;
      const dv2 = dv * dv;
      if (dv2 > 1) continue;
      for (let px = u0; px <= u1; px++) {
        const du = (px + 0.5 - u) / radiusU;
        const d2 = du * du + dv2;
        if (d2 > 1) continue;
        // Smooth falloff, so blobs blend rather than stack into hard discs.
        const falloff = (1 - d2) * (1 - d2);
        const w = falloff * weight;

        // Wrap longitude.
        let wx = px % this.width;
        if (wx < 0) wx += this.width;
        const o = (py * this.width + wx) * 4;
        this.accum[o] += color[0] * w;
        this.accum[o + 1] += color[1] * w;
        this.accum[o + 2] += color[2] * w;
        this.accum[o + 3] += w;
      }
    }
  }

  private resolve(): void {
    const n = this.width * this.height;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const w = this.accum[o + 3];
      if (w <= 0.0001) {
        this.out[o] = 0;
        this.out[o + 1] = 0;
        this.out[o + 2] = 0;
        this.out[o + 3] = 0;
        continue;
      }
      this.out[o] = (this.accum[o] / w) * 255;
      this.out[o + 1] = (this.accum[o + 1] / w) * 255;
      this.out[o + 2] = (this.accum[o + 2] / w) * 255;
      // Coverage saturates well below the accumulated weight, so a densely
      // settled interior is solid while a frontier fades out.
      this.out[o + 3] = Math.min(1, w / 0.55) * 255;
    }
  }
}

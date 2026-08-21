/**
 * The planet's terrain function.
 *
 * This is a pure function of position on the unit sphere. It has no state, no
 * cached grid and no tiles — which is precisely why the terrain reads as a
 * continuous world rather than a board. Any point can be evaluated at any
 * detail level, so the LOD system is free to subdivide as far as the camera
 * asks it to.
 *
 * The only subtlety is band-limiting. Each octave is faded out once its
 * features get close to the vertex spacing of whatever mesh is being built.
 * Without that, a coarse patch samples high-frequency noise at random phase
 * and the terrain visibly boils as LOD levels swap. With it, detail fades in
 * smoothly and the silhouette stays stable.
 */

import { Noise3D } from '../core/noise';
import { mixSeed } from '../core/rng';
import { MAX_DEPTH, MAX_ELEVATION, PLANET_RADIUS } from './config';

export interface TerrainSample {
  /** Metres relative to sea level. Negative is sea floor. */
  height: number;
  /** 0 = desert, 1 = rainforest. */
  moisture: number;
  /** 0 = polar, 1 = tropical. */
  temperature: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Sea level crossing of the continent field. Tuned for ~30% land coverage. */
const SEA_THRESHOLD = 0.115;

export class PlanetField {
  readonly seed: number;

  private warpA: Noise3D;
  private warpB: Noise3D;
  private continent: Noise3D;
  private orogeny: Noise3D;
  private mountain: Noise3D;
  private detail: Noise3D;
  private seafloor: Noise3D;
  private moisture: Noise3D;
  private climate: Noise3D;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.warpA = new Noise3D(mixSeed(seed, 1));
    this.warpB = new Noise3D(mixSeed(seed, 2));
    this.continent = new Noise3D(mixSeed(seed, 3));
    this.orogeny = new Noise3D(mixSeed(seed, 4));
    this.mountain = new Noise3D(mixSeed(seed, 5));
    this.detail = new Noise3D(mixSeed(seed, 6));
    this.seafloor = new Noise3D(mixSeed(seed, 7));
    this.moisture = new Noise3D(mixSeed(seed, 8));
    this.climate = new Noise3D(mixSeed(seed, 9));
  }

  /**
   * Band-limited fBm. `spacing` is the world-space distance between adjacent
   * vertices of the mesh being generated; octaves whose features are smaller
   * than a few times that are faded out and the loop exits early.
   */
  private bandFbm(
    noise: Noise3D,
    x: number,
    y: number,
    z: number,
    baseFreq: number,
    octaves: number,
    spacing: number,
    lacunarity = 2.02,
    gain = 0.5,
  ): number {
    let amp = 1;
    let freq = baseFreq;
    let sum = 0;
    let norm = 0;
    const fadeLo = spacing * 1.25;
    const fadeHi = spacing * 3.6;

    for (let o = 0; o < octaves; o++) {
      // Normalise against the full octave stack so that dropping detail never
      // shifts the underlying landform.
      norm += amp;
      const featureArc = PLANET_RADIUS / freq;
      const w = smoothstep(fadeLo, fadeHi, featureArc);
      if (w > 0.0001) {
        sum += amp * w * noise.sample(x * freq, y * freq, z * freq);
      } else if (featureArc < fadeLo) {
        // Everything beyond here is finer still; account for the remaining
        // amplitude in the normaliser and stop.
        for (let k = o + 1; k < octaves; k++) {
          amp *= gain;
          norm += amp;
        }
        break;
      }
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Band-limited ridged multifractal, output in [0, 1]. */
  private bandRidged(
    noise: Noise3D,
    x: number,
    y: number,
    z: number,
    baseFreq: number,
    octaves: number,
    spacing: number,
    lacunarity = 2.07,
    gain = 0.52,
  ): number {
    let amp = 1;
    let freq = baseFreq;
    let sum = 0;
    let norm = 0;
    let prev = 1;
    const fadeLo = spacing * 1.25;
    const fadeHi = spacing * 3.6;

    for (let o = 0; o < octaves; o++) {
      norm += amp;
      const featureArc = PLANET_RADIUS / freq;
      const w = smoothstep(fadeLo, fadeHi, featureArc);
      if (w <= 0.0001 && featureArc < fadeLo) {
        for (let k = o + 1; k < octaves; k++) {
          amp *= gain;
          norm += amp;
        }
        break;
      }
      let n = 1 - Math.abs(noise.sample(x * freq, y * freq, z * freq));
      n *= n;
      n *= prev;
      prev = Math.min(1, n * 1.7);
      sum += amp * w * n;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Domain warp. Offsetting the sample position by a low-frequency noise field
   * is the single cheapest trick that turns "blobby noise islands" into
   * coastlines with peninsulas, bays and archipelagos.
   */
  private warp(x: number, y: number, z: number, out: Float64Array): void {
    // Kept gentle on purpose. Turned up, the warp stops making coastlines
    // interesting and starts shearing whole continents into marbled swirls.
    const f = 0.9;
    const a = 0.16;
    const wx = this.warpA.sample(x * f, y * f, z * f);
    const wy = this.warpA.sample(x * f + 31.7, y * f - 12.3, z * f + 5.1);
    const wz = this.warpB.sample(x * f - 7.9, y * f + 44.2, z * f - 21.6);
    out[0] = x + wx * a;
    out[1] = y + wy * a;
    out[2] = z + wz * a;
  }

  private scratch = new Float64Array(3);

  /**
   * Terrain height in world units relative to sea level.
   *
   * @param spacing world-space vertex spacing of the consuming mesh; controls
   *   how much high-frequency detail is included.
   */
  height(x: number, y: number, z: number, spacing: number): number {
    const w = this.scratch;
    this.warp(x, y, z, w);
    const c = this.continentField(w[0], w[1], w[2], spacing);
    return this.heightFrom(w[0], w[1], w[2], c, spacing);
  }

  /**
   * Height, moisture and temperature in one pass.
   *
   * Meshing evaluates every vertex, so sharing the domain warp and the
   * continent field between the three outputs — rather than recomputing them
   * per channel — is worth roughly a 40% saving on patch build time.
   *
   * Writes `[height, moisture, temperature]` into `out` at `offset`.
   */
  evaluate(
    x: number,
    y: number,
    z: number,
    spacing: number,
    out: Float32Array | Float64Array | number[],
    offset = 0,
  ): void {
    const w = this.scratch;
    this.warp(x, y, z, w);
    const wx = w[0], wy = w[1], wz = w[2];
    const c = this.continentField(wx, wy, wz, spacing);

    const height = this.heightFrom(wx, wy, wz, c, spacing);

    // Moisture: latitude circulation bands, distance inland, and noise.
    const poleness = Math.abs(y);
    const itcz = Math.exp(-Math.pow((poleness - 0.02) / 0.3, 2));
    const storm = Math.exp(-Math.pow((poleness - 0.63) / 0.22, 2)) * 0.8;
    const bands = clamp01(itcz + storm);
    // A deliberately broad landness ramp: this measures "how far inland",
    // not "is this land", so continental interiors dry out.
    const fromSea = 1 - smoothstep(SEA_THRESHOLD, SEA_THRESHOLD + 0.5, c);
    const n = this.moisture.fbm(x * 3.4, y * 3.4, z * 3.4, 3) * 0.5 + 0.5;
    let m = 0.3 * bands + 0.33 * fromSea + 0.37 * n;
    if (height > MAX_ELEVATION * 0.35) {
      m -= smoothstep(MAX_ELEVATION * 0.35, MAX_ELEVATION * 0.85, height) * 0.3;
    }

    out[offset] = height;
    out[offset + 1] = clamp01(m);
    out[offset + 2] = this.temperatureAt(y, height);
  }

  /**
   * The continent field: the single value that decides land from sea.
   *
   * Deliberately split into two parts. A low-frequency, fast-decaying fBm
   * gives a handful of large landmasses rather than noise-speckle, and a small
   * high-frequency term perturbs only the coastline, producing inlets and
   * offshore islands without breaking the continents apart.
   */
  private continentField(wx: number, wy: number, wz: number, spacing: number): number {
    const base = this.bandFbm(this.continent, wx, wy, wz, 0.95, 4, spacing, 2.1, 0.42);
    const coast = this.bandFbm(this.continent, wx * 2.3, wy * 2.3, wz * 2.3, 5.5, 3, spacing);
    return base + coast * 0.075;
  }

  /** Height given an already-warped position and continent value. */
  private heightFrom(
    wx: number,
    wy: number,
    wz: number,
    c: number,
    spacing: number,
  ): number {
    const land = smoothstep(SEA_THRESHOLD, SEA_THRESHOLD + 0.15, c);

    // --- Ocean floor ------------------------------------------------------
    // Abyssal plains deepen away from the shelf, with mid-ocean ridges lifting
    // long welts back up through them.
    const abyss = smoothstep(SEA_THRESHOLD - 0.02, SEA_THRESHOLD - 0.30, c);
    let h = 0;
    if (abyss > 0.002) {
      const floorVar = this.bandFbm(this.seafloor, wx, wy, wz, 3.1, 4, spacing) * 0.5 + 0.5;
      const ridge = this.bandRidged(this.seafloor, wx, wy, wz, 2.6, 4, spacing);
      h -= abyss * MAX_DEPTH * (0.52 + 0.48 * floorVar);
      h += abyss * ridge * ridge * 13;
    }

    if (land <= 0.002) return h;

    // --- Land base --------------------------------------------------------
    const plateau = this.bandFbm(this.detail, wx, wy, wz, 2.7, 4, spacing) * 0.5 + 0.5;
    h += Math.pow(land, 1.22) * (7 + plateau * 15);

    // --- Mountain belts ---------------------------------------------------
    // Orogeny gates where mountains are allowed at all, so ranges form in
    // bands across a continent instead of studding it evenly.
    const belt = this.bandFbm(this.orogeny, wx, wy, wz, 1.95, 3, spacing) * 0.5 + 0.5;
    const orogenyMask = smoothstep(0.4, 0.79, belt);
    if (orogenyMask > 0.002) {
      const ridge = this.bandRidged(this.mountain, wx, wy, wz, 3.7, 7, spacing);
      h += Math.pow(ridge, 1.35) * orogenyMask * land * MAX_ELEVATION * 0.86;
    }

    // --- Hills and surface detail ----------------------------------------
    // Faded out near the waterline. Fine detail has an amplitude of a couple of
    // metres, so on a coastal plain it crosses sea level constantly and peppers
    // the shore with sub-metre puddles — which reads as noise, not as lakes.
    const coastal = smoothstep(0.5, 7.0, h);
    h += this.bandFbm(this.detail, wx, wy, wz, 11, 5, spacing) * 2.6 * land * coastal;
    h +=
      this.bandFbm(this.detail, wx * 1.7, wy * 1.7, wz * 1.7, 43, 4, spacing) *
      0.55 *
      land *
      coastal;

    return h;
  }

  /** Full terrain sample including climate. Convenience wrapper over evaluate(). */
  sample(x: number, y: number, z: number, spacing: number): TerrainSample {
    const out = this.sampleScratch;
    this.evaluate(x, y, z, spacing, out);
    return { height: out[0], moisture: out[1], temperature: out[2] };
  }

  private sampleScratch = new Float64Array(3);

  /** 0 at the poles, 1 at the equator, minus a lapse rate with altitude. */
  temperatureAt(y: number, height: number): number {
    const poleness = Math.abs(y);
    let t = 1 - Math.pow(poleness, 1.5);
    t += this.climate.fbm(y * 2.3, poleness * 3.1, 0.5, 2) * 0.06;
    // Lapse rate. Kept mild on purpose: ordinary land on a planet this small is
    // already a large fraction of the maximum elevation, so a realistic-looking
    // coefficient here freezes entire temperate continents.
    if (height > 0) t -= (height / MAX_ELEVATION) * 0.34;
    return clamp01(t);
  }

  /**
   * Analytic-ish surface normal, from finite differences of the height field
   * in the local tangent plane. Computed from world position alone, so two
   * patches at different LOD levels agree wherever their detail level agrees
   * and shading has no visible patch seams.
   */
  normal(
    x: number,
    y: number,
    z: number,
    spacing: number,
    radius: number,
    out: Float64Array,
  ): void {
    // Tangent basis around the surface normal.
    let ax = 0, ay = 0, az = 0;
    const absX = Math.abs(x), absY = Math.abs(y), absZ = Math.abs(z);
    if (absX <= absY && absX <= absZ) ax = 1;
    else if (absY <= absZ) ay = 1;
    else az = 1;

    let tx = ay * z - az * y;
    let ty = az * x - ax * z;
    let tz = ax * y - ay * x;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;

    const bx = y * tz - z * ty;
    const by = z * tx - x * tz;
    const bz = x * ty - y * tx;

    // Step by one vertex spacing, expressed as an angle on the unit sphere.
    const e = spacing / radius;
    const inv = 1 / Math.hypot(1, e);

    const h0 = this.height(x, y, z, spacing);

    const p1x = (x + tx * e) * inv, p1y = (y + ty * e) * inv, p1z = (z + tz * e) * inv;
    const p2x = (x + bx * e) * inv, p2y = (y + by * e) * inv, p2z = (z + bz * e) * inv;
    const h1 = this.height(p1x, p1y, p1z, spacing);
    const h2 = this.height(p2x, p2y, p2z, spacing);

    // Surface points, then the cross product of the two tangent deltas.
    const r0 = radius + h0;
    const r1 = radius + h1;
    const r2 = radius + h2;
    const v1x = p1x * r1 - x * r0, v1y = p1y * r1 - y * r0, v1z = p1z * r1 - z * r0;
    const v2x = p2x * r2 - x * r0, v2y = p2y * r2 - y * r0, v2z = p2z * r2 - z * r0;

    let nx = v1y * v2z - v1z * v2y;
    let ny = v1z * v2x - v1x * v2z;
    let nz = v1x * v2y - v1y * v2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    // The cross product points outward given the basis handedness above; guard
    // anyway so a degenerate patch can never flip the lighting.
    if (nx * x + ny * y + nz * z < 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }
    out[0] = nx; out[1] = ny; out[2] = nz;
  }
}

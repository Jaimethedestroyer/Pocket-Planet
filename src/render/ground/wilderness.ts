/**
 * Vegetation outside the towns.
 *
 * Trees, crops and scrub used to exist in a ring around every settlement and
 * nowhere else, which made a wilderness the one part of the planet that was
 * visibly emptier than the farmland — exactly backwards.
 *
 * The obvious fix is to hang a scatter off the terrain's LOD patches. That is
 * the right long-term answer and it is a much larger problem than it looks:
 * patches split and merge constantly while the camera moves, so the scatter has
 * to be stable across a subdivision it does not control, and every LOD change
 * re-uploads thousands of instances.
 *
 * This is the cheap version, and it is cheap because of an observation about
 * where vegetation actually has to exist: only where you are. One disc of
 * scatter follows the camera's ground point and is rebuilt when it has moved a
 * third of its own radius — a few hundred metres of flying, and a few
 * milliseconds of terrain sampling when it happens. Density falls off with
 * distance so the near field is dense and the far edge is sparse, which is both
 * what a landscape looks like and what keeps the instance count bounded.
 *
 * Species come from the climate the terrain function already computes, so a
 * cold coast gets conifers and a dry interior gets scrub without anything
 * having to decide what biome it is.
 */

import * as THREE from 'three';
import { PLANET_RADIUS } from '../../planet/config';
import { makeRng, mixSeed } from '../../core/rng';
import type { PlanetField } from '../../planet/heightfield';
import type { PropPlacement } from './plan';

/** Candidate points tested per rebuild. Roughly a third of them take. */
const SCATTER_COUNT = 900;

/** Candidates tested per frame while a rebuild is in progress. */
const CHUNK = 220;

/** Rebuild once the camera's ground point has moved this fraction of the radius. */
const REBUILD_FRACTION = 0.32;

export class Wilderness {
  private field: PlanetField;
  private seed: number;

  private centre = new THREE.Vector3();
  private radius = 0;
  private built = false;
  private lastMs = 0;

  /** The scatter currently uploaded. Replaced only when a rebuild finishes. */
  props: PropPlacement[] = [];

  /**
   * A rebuild in progress.
   *
   * Built a few hundred candidates at a time and swapped in whole, so a long
   * flight never costs a frame and the old scatter stays on screen while the
   * new one is coming together. Sampling nine hundred points against the
   * terrain function is seventeen milliseconds; a fifth of that is a frame
   * nobody notices.
   */
  private pending: PropPlacement[] | null = null;
  private pendingIndex = 0;
  private pendingRng: ReturnType<typeof makeRng> | null = null;
  private pendingCentre = new THREE.Vector3();
  private pendingRadius = 0;
  private pendingExclude: { centre: THREE.Vector3; radius: number }[] = [];

  private dir = new THREE.Vector3();
  private east = new THREE.Vector3();
  private north = new THREE.Vector3();

  constructor(field: PlanetField, seed: number) {
    this.field = field;
    this.seed = seed >>> 0;
  }

  /** True when the scatter changed and the caller has to re-upload. */
  update(
    groundUnit: THREE.Vector3,
    reach: number,
    exclude: { centre: THREE.Vector3; radius: number }[],
  ): boolean {
    if (reach < 40) {
      this.pending = null;
      if (!this.built && this.props.length === 0) return false;
      this.props.length = 0;
      this.built = false;
      return true;
    }

    if (this.pending) return this.advance();

    // Angular distance is the honest measure here: the two points are on a
    // sphere, and near the poles a difference in longitude is not a distance.
    const moved = this.built
      ? Math.acos(THREE.MathUtils.clamp(this.centre.dot(groundUnit), -1, 1)) * PLANET_RADIUS
      : Infinity;
    if (
      this.built &&
      moved < this.radius * REBUILD_FRACTION &&
      Math.abs(reach - this.radius) < this.radius * 0.2
    ) {
      return false;
    }

    this.start(groundUnit, reach, exclude);
    return this.advance();
  }

  private start(
    groundUnit: THREE.Vector3,
    reach: number,
    exclude: { centre: THREE.Vector3; radius: number }[],
  ): void {
    this.pendingCentre.copy(groundUnit).normalize();
    this.pendingRadius = reach;
    this.pendingExclude = exclude.map((e) => ({ centre: e.centre.clone(), radius: e.radius }));
    this.pending = [];
    this.pendingIndex = 0;

    const up = this.pendingCentre;
    const ref = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.east.crossVectors(ref, up).normalize();
    this.north.crossVectors(up, this.east);

    // Seeded by where the disc is, not by how many have been built: fly away
    // and back and the same trees are in the same places.
    const key =
      (Math.round(up.x * 4096) * 73856093) ^
      (Math.round(up.y * 4096) * 19349663) ^
      (Math.round(up.z * 4096) * 83492791);
    this.pendingRng = makeRng(mixSeed(this.seed, key));
  }

  /** Test the next chunk of candidates. True when the scatter was swapped in. */
  private advance(): boolean {
    const pending = this.pending;
    const rng = this.pendingRng;
    if (!pending || !rng) return false;

    const start = performance.now();
    const end = Math.min(SCATTER_COUNT, this.pendingIndex + CHUNK);
    this.scatter(pending, rng, this.pendingIndex, end);
    this.pendingIndex = end;
    // Per chunk, not per rebuild: what matters is the frame, not the total.
    this.lastMs = performance.now() - start;

    if (this.pendingIndex < SCATTER_COUNT) return false;

    this.props = pending;
    this.centre.copy(this.pendingCentre);
    this.radius = this.pendingRadius;
    this.built = true;
    this.pending = null;
    this.pendingRng = null;
    return true;
  }

  get buildMs(): number {
    return this.lastMs;
  }

  private scatter(
    out: PropPlacement[],
    rng: ReturnType<typeof makeRng>,
    from: number,
    to: number,
  ): void {
    const up = this.pendingCentre;
    const exclude = this.pendingExclude;
    const world = new THREE.Vector3();
    for (let i = from; i < to; i++) {
      // Radius as u^1.5 rather than sqrt(u): uniform area density spreads a
      // fixed budget evenly over a disc, which means the far edge looks the
      // same as the ground at your feet and neither is dense enough.
      const r = this.pendingRadius * Math.pow(rng.next(), 1.5);
      const angle = rng.next() * Math.PI * 2;
      const a = Math.cos(angle) * r;
      const b = Math.sin(angle) * r;

      this.dir
        .copy(up)
        .addScaledVector(this.east, a / PLANET_RADIUS)
        .addScaledVector(this.north, b / PLANET_RADIUS)
        .normalize();

      const ground = this.field.sample(this.dir.x, this.dir.y, this.dir.z, 0.5);
      if (ground.height < 1.8) continue;

      // Thin out on anything a tree would fall off, and above the treeline.
      if (ground.temperature < 0.14) continue;
      const density =
        Math.min(1, ground.moisture * 1.5) *
        Math.min(1, (ground.temperature - 0.1) * 2.2) *
        (1 - THREE.MathUtils.smoothstep(ground.height, 15, 24));
      if (!rng.chance(density)) continue;

      // Towns plant their own; this must not double up inside one.
      let inTown = false;
      world.copy(this.dir).multiplyScalar(PLANET_RADIUS + ground.height);
      for (const town of exclude) {
        if (world.distanceToSquared(town.centre) < town.radius * town.radius * 2.9) {
          inTown = true;
          break;
        }
      }
      if (inTown) continue;

      let kind = 0;
      if (ground.temperature < 0.36) kind = 2;
      else if (ground.moisture < 0.32) kind = 3;
      else if (ground.temperature > 0.74 && ground.moisture < 0.48) kind = 3;

      const lush = 0.5 + ground.moisture * 0.8;
      out.push({
        origin: this.dir.clone().multiplyScalar(PLANET_RADIUS + ground.height - 0.25),
        rot: rng.next() * Math.PI,
        size: kind === 3 ? rng.range(1.4, 2.6) : rng.range(3.0, 7.0),
        kind,
        tint: [
          rng.range(0.08, 0.19) * lush,
          rng.range(0.17, 0.32) * lush,
          rng.range(0.05, 0.14) * lush,
        ],
      });
    }
  }

  /** Force a rebuild on the next update, e.g. after the range changed. */
  invalidate(): void {
    this.built = false;
    this.pending = null;
  }

  /** Drop the scatter entirely. Used when the layer stops drawing the world. */
  clear(): void {
    this.props = [];
    this.built = false;
    this.pending = null;
  }
}

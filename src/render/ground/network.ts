/**
 * The roads between towns.
 *
 * Everything else in `ground/` builds one settlement at a time, and that is
 * exactly what made a region of them read as a scatter of unrelated models: a
 * dozen towns, each with its own tidy street plan, and nothing at all in the
 * space between them. A road leaving a town is the cheapest thing that makes a
 * continent look inhabited rather than decorated, because it is the only piece
 * of geometry that says two of these places know about each other.
 *
 * A route is chosen the way a route gets chosen: start with the straight line,
 * then let the ground argue with it. Each interior point slides sideways
 * towards the elevation its neighbours are at, damped so that a road already
 * running down a fall line is left to run down it — the same trick the street
 * planner uses, applied over a kilometre instead of over a block. What comes
 * out is a road that swings wide around a hill and takes the saddle, which is
 * both what a real one does and, from six hundred metres up, unmistakably a
 * road rather than a line.
 *
 * Two things keep this affordable. Routes are **cached by the pair of cells**:
 * a route depends on the terrain and on nothing else, so it is computed once
 * and never again, however the towns at its ends grow or change hands. And
 * routing is **budgeted per frame**, like town planning, so arriving over a
 * dense region costs a few milliseconds spread over a second rather than one
 * stalled frame.
 */

import * as THREE from 'three';
import { PLANET_RADIUS } from '../../planet/config';
import type { PlanetField } from '../../planet/heightfield';
import type { RoadPath } from './plan';

/**
 * Furthest two settlements may be and still be worth joining, in metres.
 *
 * Settlements on this planet sit about a hundred metres apart, so this is a
 * little over two hops. Wider, and every town acquires a spray of long straight
 * routes to places it has no relationship with, which reads as a survey grid
 * rather than as a road network.
 */
const LINK_MAX = 190;

/** How many neighbours a town reaches out to. */
const LINKS_PER_TOWN = 3;

/** Spacing of the routing samples along a link. */
const ROUTE_STEP = 14;

/** How far a route may bend away from the straight line, in metres. */
const MAX_BEND = 60;

/** Sampling detail. Coarser than a street: this is read from much further up. */
const SAMPLE_SPACING = 3;

export interface NetworkTown {
  cell: number;
  unit: THREE.Vector3;
  /** Built radius in metres, so the link can stop where the streets start. */
  radius: number;
  polity: number;
  tier: number;
  era: number;
}

interface Link {
  a: number;
  b: number;
  /** Draped route, or null when the terrain refused one (open water, a cliff). */
  points: THREE.Vector3[] | null;
}

function pairKey(a: number, b: number): number {
  // Cells are well under 2^20 on any graph this game generates.
  return a < b ? a * 1048576 + b : b * 1048576 + a;
}

export class RoadNetwork {
  private links = new Map<number, Link>();
  private queue: { a: NetworkTown; b: NetworkTown }[] = [];
  private live: Link[] = [];

  /** Routes built on the last update, for the HUD. */
  routedMs = 0;

  constructor(
    private field: PlanetField,
    private budgetMs = 1.5,
  ) {}

  /**
   * Choose which towns are joined, and route whatever is not routed yet.
   *
   * The choice is nearest-neighbour with a preference for one's own polity —
   * states build roads inside themselves first — plus one link to the nearest
   * town of any allegiance, which is what stops a border reading as a wall.
   * Returns true when the set of drawable routes changed.
   */
  update(towns: NetworkTown[]): boolean {
    const wanted = new Set<number>();
    for (let i = 0; i < towns.length; i++) {
      const town = towns[i];
      const near: { town: NetworkTown; d: number }[] = [];
      for (let j = 0; j < towns.length; j++) {
        if (i === j) continue;
        const other = towns[j];
        const d = town.unit.distanceTo(other.unit) * PLANET_RADIUS;
        if (d > LINK_MAX) continue;
        near.push({ town: other, d });
      }
      near.sort((p, q) => p.d - q.d);

      let own = 0;
      let any = 0;
      for (const candidate of near) {
        const sameState = candidate.town.polity === town.polity;
        if (sameState && own >= LINKS_PER_TOWN - 1) continue;
        if (!sameState && any >= 1) continue;
        if (sameState) own++;
        else any++;
        wanted.add(pairKey(town.cell, candidate.town.cell));
        if (own + any >= LINKS_PER_TOWN) break;
      }
    }

    const byCell = new Map<number, NetworkTown>();
    for (const town of towns) byCell.set(town.cell, town);

    this.queue.length = 0;
    for (const key of wanted) {
      if (this.links.has(key)) continue;
      const a = byCell.get(Math.floor(key / 1048576));
      const b = byCell.get(key % 1048576);
      if (a && b) this.queue.push({ a, b });
    }

    // Nearest pairs first: a road between two towns the player is standing
    // between matters more than one at the edge of the view.
    this.queue.sort(
      (p, q) => p.a.unit.distanceToSquared(p.b.unit) - q.a.unit.distanceToSquared(q.b.unit),
    );

    const started = performance.now();
    let routed = 0;
    for (const pair of this.queue) {
      this.links.set(pairKey(pair.a.cell, pair.b.cell), this.route(pair.a, pair.b));
      routed++;
      if (performance.now() - started > this.budgetMs) break;
    }
    if (routed > 0) this.routedMs = performance.now() - started;

    // Forget routes nobody is asking for any more. Generous, because routing is
    // far more expensive than holding a few thousand positions.
    if (this.links.size > 900) {
      for (const key of this.links.keys()) {
        if (!wanted.has(key)) this.links.delete(key);
        if (this.links.size <= 600) break;
      }
    }

    const before = this.signature;
    this.live.length = 0;
    let signature = 0;
    for (const key of wanted) {
      const link = this.links.get(key);
      if (!link || !link.points) continue;
      this.live.push(link);
      // Order-independent, because a Set iterates in insertion order and the
      // insertion order depends on which town happened to be nearest the camera.
      signature = (signature + Math.imul(key | 0, 0x9e3779b9)) >>> 0;
    }
    this.signature = signature;
    return signature !== before;
  }

  private signature = -1;

  /**
   * The routes to draw, as roads.
   *
   * Width and grade are decided here rather than baked into the cached route,
   * because they are properties of the towns at the ends — which grow, change
   * era and change hands — and the route between them is a property of the
   * ground, which does not.
   */
  roads(byCell: Map<number, NetworkTown>, out: RoadPath[]): void {
    for (const link of this.live) {
      const a = byCell.get(link.a);
      const b = byCell.get(link.b);
      if (!a || !b || !link.points) continue;

      // Stop where the streets take over, so the route joins the town instead
      // of running a second carriageway through the middle of it. Trimmed from
      // the ends inwards rather than by testing every point, because a route
      // that curves back on itself would otherwise lose a piece out of its
      // middle and be drawn as two roads with a hole between them.
      const route = link.points;
      const last = route.length - 1;
      let from = 0;
      let to = last;
      while (from < last && route[from].distanceTo(route[0]) < a.radius * 0.55) from++;
      while (to > from && route[to].distanceTo(route[last]) < b.radius * 0.55) to--;
      if (to - from < 2) continue;
      const points = route.slice(from, to + 1);

      const era = Math.max(a.era, b.era);
      const tier = Math.max(a.tier, b.tier);
      out.push({
        points,
        width: 2.4 + era * 0.9 + tier * 0.35,
        // A made road, rather than a track worn between two villages, arrives
        // with the states that can afford to maintain one.
        grade: era >= 2 && tier >= 2 ? 1 : 0,
      });
    }
  }

  clear(): void {
    this.live.length = 0;
  }

  get routeCount(): number {
    return this.live.length;
  }

  /**
   * Route one link.
   *
   * The base path is a slerp, so it is a great circle and needs no tangent-plane
   * approximation. Everything after that is a lateral offset in metres, applied
   * in the local frame at each point — which keeps the whole search
   * one-dimensional, and one-dimensional is what makes three passes over a
   * hundred-metre road affordable.
   */
  private route(a: NetworkTown, b: NetworkTown): Link {
    const link: Link = { a: a.cell, b: b.cell, points: null };
    const span = a.unit.angleTo(b.unit) * PLANET_RADIUS;
    const n = Math.max(5, Math.min(40, Math.round(span / ROUTE_STEP)));

    const base: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      base.push(new THREE.Vector3().copy(a.unit).lerp(b.unit, i / n).normalize());
    }

    const lateral: THREE.Vector3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const prev = base[Math.max(0, i - 1)];
      const next = base[Math.min(n, i + 1)];
      lateral.push(
        new THREE.Vector3().crossVectors(base[i], scratch.copy(next).sub(prev)).normalize(),
      );
    }

    const offset = new Float64Array(n + 1);
    const height = new Float64Array(n + 1);
    const probe = new THREE.Vector3();

    const sample = (i: number, off: number): number => {
      probe
        .copy(base[i])
        .addScaledVector(lateral[i], off / PLANET_RADIUS)
        .normalize();
      return this.field.height(probe.x, probe.y, probe.z, SAMPLE_SPACING);
    };

    height[0] = sample(0, 0);
    height[n] = sample(n, 0);
    for (let i = 1; i < n; i++) height[i] = sample(i, 0);

    // Three passes. The first finds the saddle, the second and third tidy up
    // after it; a fourth has never visibly changed anything.
    const step = 4;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < n; i++) {
        const target = (height[i - 1] + height[i + 1]) * 0.5;
        const from = offset[i];
        const hp = sample(i, from + step);
        const hm = sample(i, from - step);
        const grad = (hp - hm) / (2 * step);
        const here = (hp + hm) * 0.5;
        // Damped, so a stretch running straight down the slope — where sideways
        // movement buys nothing — is left where the straight line put it.
        const move = ((target - here) * grad) / (grad * grad + 0.03);
        offset[i] = Math.max(
          -MAX_BEND,
          Math.min(MAX_BEND, from + Math.max(-step * 2, Math.min(step * 2, move))),
        );
        height[i] = here + grad * (offset[i] - from);
      }
      // Smooth the offsets: a route that is locally optimal at every point and
      // nowhere smooth is a road with a kink in it every fourteen metres.
      for (let i = 1; i < n; i++) {
        offset[i] = offset[i] * 0.6 + (offset[i - 1] + offset[i + 1]) * 0.2;
      }
    }

    // Drape, and give up on anything that would have to cross open water. A
    // road ending in the sea is worse than no road: the player reads it as a
    // bug, and it is one.
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      probe
        .copy(base[i])
        .addScaledVector(lateral[i], offset[i] / PLANET_RADIUS)
        .normalize();
      const h = this.field.height(probe.x, probe.y, probe.z, SAMPLE_SPACING);
      if (h < 1.5) return link;
      points.push(probe.clone().multiplyScalar(PLANET_RADIUS + h));
    }

    link.points = points;
    return link;
  }
}

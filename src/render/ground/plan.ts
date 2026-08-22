/**
 * Town planning.
 *
 * Given a settlement — a cell, a tier, an era and a culture — this lays out an
 * actual town on the actual terrain: streets first, then buildings along them,
 * then the fields and the people. It is a pure function of the settlement and
 * the world seed, so the same town is the same town across frames, across
 * reloads, and across two players holding the same seed.
 *
 * Streets before buildings, and never the other way around. Scattering
 * buildings and then trying to connect them produces a road network that looks
 * like a road network and a town that does not look like a town: real
 * settlements are frontage on a route. Laying the route first and hanging
 * buildings off it gets terraces, corners and squares for free.
 *
 * Everything is planned in a local tangent frame in metres, then lifted onto
 * the sphere at the end. A town is at most two hundred metres across on a
 * planet with a one-kilometre radius, which is a fifth of a radian — small
 * enough to plan flat, far too large to *place* flat, so the lift is a real
 * normalize rather than an offset.
 */

import * as THREE from 'three';
import { PLANET_RADIUS } from '../../planet/config';
import { Era } from '../../sim/types';
import { makeRng, mixSeed } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { PlanetField } from '../../planet/heightfield';
import { archetypes } from './archetypes';
import type { ArchetypeName } from './archetypes';
import { pickWeighted, samplePalette, townStyle } from './style';
import type { Rgb, TownStyle } from './style';

/** One building, ready to become an instance. */
export interface Placement {
  archetype: ArchetypeName;
  /** World position of the model's origin, at ground level. */
  origin: THREE.Vector3;
  /** Rotation about the surface normal, in the shader's tangent basis. */
  rot: number;
  scale: THREE.Vector3;
  wall: Rgb;
  roof: Rgb;
  /**
   * How coursed the walls are, 0 to 1. Thatch and daub have no visible
   * courses; mudbrick has broad ones; fired brick has four to the metre. It
   * travels per instance rather than per material because one town can be
   * halfway through rebuilding itself in a new material.
   */
  style: number;
}

/** A road, as a chain of world-space points with a width. */
export interface RoadPath {
  points: THREE.Vector3[];
  width: number;
  /** 0 track, 1 street, 2 highway. Drives wear and centre markings. */
  grade: number;
}

/** A crossed-quad prop: tree, crop row, rubble. */
export interface PropPlacement {
  origin: THREE.Vector3;
  rot: number;
  /** Metres. */
  size: number;
  kind: number;
  tint: Rgb;
}

/** A billboard person walking a street. */
export interface PersonPlacement {
  origin: THREE.Vector3;
  /** Direction of travel, world-space tangent. */
  along: THREE.Vector3;
  /** Metres per second. */
  speed: number;
  /** How far along the route, 0..1, at t = 0. */
  phase: number;
  /** Length of the walk before it turns around, in metres. */
  span: number;
  tint: Rgb;
  /** What they are wearing, before the polity's colour is mixed into it. */
  cloth: Rgb;
}

export interface TownPlan {
  cell: number;
  tier: number;
  era: Era;
  /** Signature of the inputs. When it changes, the plan is rebuilt. */
  signature: string;
  centre: THREE.Vector3;
  /** Built radius in metres. */
  radius: number;
  buildings: Placement[];
  roads: RoadPath[];
  props: PropPlacement[];
  people: PersonPlacement[];
}

export interface TownRequest {
  cell: number;
  tier: number;
  era: Era;
  culture: string;
  capital: boolean;
  coastal: boolean;
  ruined: boolean;
  /**
   * The great work standing here, if any.
   *
   * Chosen by the simulation in a particular year by a particular state, not
   * by the planner — so it survives the town emptying and the state falling,
   * and a resettlement nine centuries later inherits it.
   */
  wonder?: ArchetypeName;
  /** Unit position of the cell. */
  unit: THREE.Vector3;
}

/**
 * Everything the plan depends on.
 *
 * Deliberately *not* the polity: a town that changes hands keeps its buildings.
 * Conquest repaints the banners and the territory field, and that is exactly
 * what conquest should look like — the same streets under a new flag.
 */
export function signatureOf(req: TownRequest): string {
  return (
    `${req.tier}/${req.era}/${req.culture}/${req.capital ? 1 : 0}/` +
    `${req.ruined ? 1 : 0}/${req.wonder ?? '-'}`
  );
}

/** Built radius and building count per tier, from hamlet to metropolis. */
const TIER_RADIUS = [26, 36, 50, 68, 92, 120];
const TIER_BUILDINGS = [7, 14, 28, 52, 92, 160];

/** Vertex spacing to sample the terrain at. Fine: buildings sit on the detail. */
const SAMPLE_SPACING = 0.5;

/**
 * The shader's tangent basis at a point, reproduced exactly.
 *
 * Every rotation this file emits is an angle in *this* frame, computed per
 * building at the building's own position, because that is the frame the vertex
 * shader will rebuild. Using the town centre's frame for all of them looks
 * right at the centre and shears by a couple of degrees at the edge of a
 * metropolis — small, and exactly the kind of small that reads as sloppy.
 */
function basisAt(up: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3): void {
  if (Math.abs(up.y) < 0.99) east.set(0, 1, 0);
  else east.set(1, 0, 0);
  east.cross(up).normalize();
  north.crossVectors(up, east);
}

/** A 2D point in the town's local frame, in metres. */
interface Local {
  a: number;
  b: number;
}

interface Street {
  points: Local[];
  width: number;
  grade: number;
  /** Whether buildings may front onto it. */
  frontage: boolean;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Resample a polyline so its points are at most `step` apart. */
function densify(points: Local[], step: number): Local[] {
  const out: Local[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    const d = Math.hypot(q.a - p.a, q.b - p.b);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) {
      out.push({ a: lerp(p.a, q.a, k / n), b: lerp(p.b, q.b, k / n) });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * A wandering line between two points.
 *
 * The lateral offset is a half sine over the length, so the curve leaves and
 * arrives on its endpoints' own bearing. A random walk instead gives a road
 * that visibly kinks at every sample, which is the difference between an old
 * road and a badly generated one.
 */
function wander(
  from: Local,
  to: Local,
  bend: number,
  segments: number,
  rng: Rng,
): Local[] {
  const dx = to.a - from.a;
  const dy = to.b - from.b;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const amp1 = rng.range(-bend, bend);
  const amp2 = rng.range(-bend, bend) * 0.5;
  const out: Local[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const off = Math.sin(t * Math.PI) * amp1 + Math.sin(t * Math.PI * 2) * amp2;
    out.push({ a: from.a + dx * t + nx * off, b: from.b + dy * t + ny * off });
  }
  return out;
}

function clipToDisc(points: Local[], radius: number): Local[] {
  const out: Local[] = [];
  for (const p of points) {
    if (Math.hypot(p.a, p.b) <= radius) out.push(p);
    else if (out.length > 1) break;
    else out.length = 0;
  }
  return out;
}

/** Build the street network for one town. */
function planStreets(style: TownStyle, radius: number, tier: number, rng: Rng): Street[] {
  const streets: Street[] = [];
  const main = style.roadWidth;
  const lane = main * 0.72;
  const turn = rng.next() * Math.PI * 2;

  const rotate = (p: Local, angle: number): Local => ({
    a: p.a * Math.cos(angle) - p.b * Math.sin(angle),
    b: p.a * Math.sin(angle) + p.b * Math.cos(angle),
  });

  if (style.layout === 'cluster') {
    // No streets, only tracks radiating from the common ground.
    const spokes = 3 + Math.min(3, tier);
    for (let i = 0; i < spokes; i++) {
      const a = turn + (i / spokes) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const len = radius * rng.range(0.75, 1.15);
      streets.push({
        points: wander(
          { a: Math.cos(a) * radius * 0.16, b: Math.sin(a) * radius * 0.16 },
          { a: Math.cos(a) * len, b: Math.sin(a) * len },
          radius * 0.1,
          5,
          rng,
        ),
        width: main,
        grade: 0,
        frontage: true,
      });
    }
    // The ring of dwellings faces inwards onto the common, which is what makes
    // a cluster of huts read as a village rather than as scattered huts.
    const ring: Local[] = [];
    const rr = radius * 0.38;
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      ring.push({ a: Math.cos(a) * rr, b: Math.sin(a) * rr });
    }
    streets.push({ points: ring, width: main * 0.8, grade: 0, frontage: true });
    return streets;
  }

  if (style.layout === 'grid' || style.layout === 'avenue') {
    // Blocks scale with the town. A fixed block size gives a metropolis a
    // sensible grid and a hamlet a single crossroads with nowhere to build.
    const ideal = style.layout === 'avenue' ? 32 : 26;
    const block = Math.min(ideal, Math.max(15, radius / 2.4));
    const n = Math.ceil(radius / block);
    for (let i = -n; i <= n; i++) {
      const off = i * block + rng.range(-2, 2);
      const half = Math.sqrt(Math.max(0, radius * radius - off * off));
      if (half < 12) continue;
      const wide = i === 0 ? main * 1.5 : main;
      streets.push({
        points: clipToDisc(
          densify([{ a: -half, b: off }, { a: half, b: off }], 10).map((p) => rotate(p, turn)),
          radius,
        ),
        width: wide,
        grade: i === 0 ? 2 : 1,
        frontage: true,
      });
      streets.push({
        points: clipToDisc(
          densify([{ a: off, b: -half }, { a: off, b: half }], 10).map((p) => rotate(p, turn)),
          radius,
        ),
        width: i === 0 ? main * 1.2 : lane,
        grade: 1,
        frontage: true,
      });
    }
    return streets.filter((s) => s.points.length > 2);
  }

  // Organic: one route through, lanes hanging off it, and a ring once the town
  // is big enough to have needed a wall.
  const spine = wander(
    rotate({ a: -radius * 1.05, b: 0 }, turn),
    rotate({ a: radius * 1.05, b: 0 }, turn),
    radius * 0.22,
    9,
    rng,
  );
  streets.push({ points: densify(spine, 9), width: main, grade: 1, frontage: true });

  const cross = wander(
    rotate({ a: 0, b: -radius * 0.95 }, turn + rng.range(-0.4, 0.4)),
    rotate({ a: 0, b: radius * 0.95 }, turn + rng.range(-0.4, 0.4)),
    radius * 0.2,
    7,
    rng,
  );
  streets.push({ points: densify(cross, 9), width: main * 0.9, grade: 1, frontage: true });

  const lanes = 2 + tier * 2;
  for (let i = 0; i < lanes; i++) {
    const host = streets[rng.int(0, streets.length)];
    const at = host.points[rng.int(1, host.points.length - 1)];
    const angle = rng.next() * Math.PI * 2;
    const len = radius * rng.range(0.3, 0.7);
    const end = { a: at.a + Math.cos(angle) * len, b: at.b + Math.sin(angle) * len };
    if (Math.hypot(end.a, end.b) > radius) continue;
    streets.push({
      points: densify(wander(at, end, radius * 0.12, 5, rng), 8),
      width: lane,
      grade: 1,
      frontage: true,
    });
  }

  if (tier >= 3) {
    const ring: Local[] = [];
    const rr = radius * 0.78;
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = rr * (1 + Math.sin(a * 3 + turn) * 0.07);
      ring.push({ a: Math.cos(a) * r, b: Math.sin(a) * r });
    }
    streets.push({ points: ring, width: lane, grade: 1, frontage: true });
  }

  return streets;
}

/** Scratch state shared across one plan, so nothing allocates per candidate. */
class Site {
  readonly up = new THREE.Vector3();
  readonly east = new THREE.Vector3();
  readonly north = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(
    private field: PlanetField,
    centre: THREE.Vector3,
  ) {
    this.up.copy(centre).normalize();
    basisAt(this.up, this.east, this.north);
  }

  /** Unit direction for a local point, in metres from the town centre. */
  direction(a: number, b: number, out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(this.up)
      .addScaledVector(this.east, a / PLANET_RADIUS)
      .addScaledVector(this.north, b / PLANET_RADIUS)
      .normalize();
  }

  height(a: number, b: number): number {
    const d = this.direction(a, b, this.dir);
    return this.field.height(d.x, d.y, d.z, SAMPLE_SPACING);
  }

  /** World position of a local point, at a given height above the terrain. */
  world(a: number, b: number, lift: number, out: THREE.Vector3): number {
    const d = this.direction(a, b, out);
    const h = this.field.height(d.x, d.y, d.z, SAMPLE_SPACING);
    out.multiplyScalar(PLANET_RADIUS + h + lift);
    return h;
  }
}

interface Occupied {
  a: number;
  b: number;
  r: number;
}

/**
 * Plan one town.
 *
 * Cost is dominated by terrain sampling — three samples per candidate building
 * plus one per road point — so it is measured and budgeted by the caller rather
 * than run for every settlement every frame.
 */
export function planTown(req: TownRequest, field: PlanetField, worldSeed: number): TownPlan {
  const models = archetypes();
  const style = townStyle(req.era, req.culture);
  const rng = makeRng(mixSeed(worldSeed, req.cell * 7919 + req.era * 31 + req.tier));

  const tier = Math.min(TIER_RADIUS.length - 1, Math.max(0, req.tier));
  const radius = TIER_RADIUS[tier] * style.spread;
  const wanted = Math.round(TIER_BUILDINGS[tier] * (req.capital ? 1.18 : 1));

  const centreDir = req.unit.clone().normalize();
  const centreHeight = field.height(centreDir.x, centreDir.y, centreDir.z, SAMPLE_SPACING);
  const centre = centreDir.clone().multiplyScalar(PLANET_RADIUS + centreHeight);
  const site = new Site(field, centre);

  const buildings: Placement[] = [];
  const roads: RoadPath[] = [];
  const props: PropPlacement[] = [];
  const people: PersonPlacement[] = [];
  const taken: Occupied[] = [];

  const scratch = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const bEast = new THREE.Vector3();
  const bNorth = new THREE.Vector3();

  const free = (a: number, b: number, r: number): boolean => {
    for (let i = 0; i < taken.length; i++) {
      const o = taken[i];
      const dx = o.a - a;
      const dy = o.b - b;
      if (dx * dx + dy * dy < (o.r + r) * (o.r + r)) return false;
    }
    return true;
  };

  /**
   * Try to put one building down.
   *
   * Rejects water and anything genuinely cliff-like, and sinks the base by
   * enough that no corner of the footprint floats. Sinking is the cheap half of
   * the problem terrain-conforming buildings have; the expensive half — cutting
   * a level platform into the hillside — is not worth it at these sizes.
   *
   * The tolerances here were the first thing this file got badly wrong. An
   * eleven-degree slope limit and a metre of freeboard above sea level sound
   * conservative and are in fact brutal: settlements go where habitability is
   * highest, habitability rewards coasts, and coasts are exactly the low, uneven
   * ground those two rules throw away. The first version of this planner built
   * beautiful empty streets.
   */
  const place = (
    name: ArchetypeName,
    a: number,
    b: number,
    facingA: number,
    facingB: number,
    scale: number,
    forced = false,
  ): boolean => {
    const model = models[name];
    const half = Math.max(model.width, model.depth) * 0.5 * scale;
    if (!forced && !free(a, b, half * 0.78)) return false;

    const h0 = site.height(a, b);
    if (h0 < 0.55) return false;
    const probe = Math.max(3, half);
    const hA = site.height(a + probe, b);
    const hB = site.height(a, b + probe);
    const slope = Math.hypot(hA - h0, hB - h0) / probe;
    if (!forced && slope > 0.38) return false;
    if (slope > 0.62) return false;

    // Bury the base deep enough that the downhill corner still meets ground.
    const sink = 0.28 + slope * half * 1.25;
    const dir = site.direction(a, b, scratch);
    const origin = dir.clone().multiplyScalar(PLANET_RADIUS + h0 - sink);

    const up = dir.clone();
    basisAt(up, bEast, bNorth);
    facing
      .copy(site.east)
      .multiplyScalar(facingA)
      .addScaledVector(site.north, facingB)
      .normalize();
    const rot = Math.atan2(-facing.dot(bEast), facing.dot(bNorth));

    const shade = rng.next();
    const jitter = rng.range(-0.06, 0.06);
    buildings.push({
      archetype: name,
      origin,
      rot,
      scale: new THREE.Vector3(
        scale * rng.range(0.95, 1.06),
        scale * rng.range(0.94, 1.12),
        scale * rng.range(0.95, 1.06),
      ),
      wall: samplePalette(style.wallA, style.wallB, shade, jitter),
      roof: samplePalette(style.roofA, style.roofB, rng.next(), jitter * 0.5),
      style: style.courses * rng.range(0.8, 1.15),
    });
    taken.push({ a, b, r: half * 0.82 });
    return true;
  };

  // --- Ruins: nothing standing, only what the weather has not taken --------

  if (req.ruined) {
    // The great work outlasts the town. Weathered along with everything else
    // below, but standing, and at full size — that is the whole point of it.
    if (req.wonder) {
      const angle = rng.next() * Math.PI * 2;
      place(req.wonder, 0, 0, Math.cos(angle), Math.sin(angle), 1, true);
    }
    const count = 4 + tier * 3;
    for (let i = 0; i < count; i++) {
      const angle = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * radius * 0.7;
      place(
        'ruin',
        Math.cos(angle) * r,
        Math.sin(angle) * r,
        Math.cos(angle + 1.2),
        Math.sin(angle + 1.2),
        rng.range(0.8, 1.3),
      );
    }
    for (const b of buildings) {
      // Weathered: greyer, and the roof colour went with the roof.
      b.wall = [b.wall[0] * 0.72 + 0.06, b.wall[1] * 0.74 + 0.07, b.wall[2] * 0.7 + 0.06];
      b.roof = b.wall;
    }
    return {
      cell: req.cell,
      tier: req.tier,
      era: req.era,
      signature: signatureOf(req),
      centre,
      radius,
      buildings,
      roads,
      props,
      people,
    };
  }

  // --- Streets ------------------------------------------------------------

  const streets = planStreets(style, radius, tier, rng);

  for (const street of streets) {
    if (street.points.length < 2) continue;
    // Streets are planned on a flat disc and the disc does not know where the
    // sea is. A coastal town's grid runs straight off the beach otherwise —
    // and takes the people walking on it with it, which is how this was found.
    // Cut the polyline at the waterline instead of clamping it: a road that
    // stops at the shore is right, and one that hugs the waterline is not.
    let run: THREE.Vector3[] = [];
    const flush = (): void => {
      if (run.length >= 2) roads.push({ points: run, width: street.width, grade: street.grade });
      run = [];
    };
    for (const p of densify(street.points, 6)) {
      const v = new THREE.Vector3();
      const h = site.world(p.a, p.b, 0, v);
      if (h < 0.5) flush();
      else run.push(v);
    }
    flush();
  }

  // --- The centre: civic buildings and the great work ----------------------

  let centreClear = 0;
  if (req.wonder || tier >= 4 || req.capital) {
    // A real great work if the simulation raised one here; otherwise a large
    // town still builds *something* for itself, it just is not history.
    const monument = style.monuments[rng.int(0, style.monuments.length)];
    const chosen =
      req.wonder ?? (req.coastal && rng.chance(0.35) ? 'lighthouse' : monument);
    const model = models[chosen];
    const angle = rng.next() * Math.PI * 2;
    if (place(chosen, 0, 0, Math.cos(angle), Math.sin(angle), 1, true)) {
      centreClear = Math.max(model.width, model.depth) * 0.75;
      taken[taken.length - 1].r = centreClear;
    }
  }
  if (tier >= 2) {
    const civic = style.civic[rng.int(0, style.civic.length)];
    const r = centreClear + 14;
    const angle = rng.next() * Math.PI * 2;
    place(
      civic,
      Math.cos(angle) * r,
      Math.sin(angle) * r,
      -Math.cos(angle),
      -Math.sin(angle),
      1,
      false,
    );
  }

  // --- Frontage: buildings hung off the streets ----------------------------

  const order: { street: Street; index: number; side: number }[] = [];
  for (const street of streets) {
    if (!street.frontage) continue;
    const dense = densify(street.points, style.frontage * 0.55);
    street.points = dense;
    for (let i = 1; i < dense.length - 1; i++) {
      for (const side of [-1, 1]) order.push({ street, index: i, side });
    }
  }
  // Shuffle so a town that runs out of budget is thinned everywhere rather than
  // built completely along the first street and not at all along the last.
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }

  const wantWorks = Math.max(1, Math.round(wanted * 0.16));
  let works = 0;
  let placed = buildings.length;

  // Candidates are tried until the town is full, or until enough have been
  // rejected that the ground is clearly against it. The list is shuffled, so a
  // town that runs out of usable ground is thinned evenly rather than built
  // solid along the first street — and the attempt cap bounds the worst case,
  // which is a metropolis planned on a mountainside where almost every
  // candidate costs three terrain samples and fails.
  const attempts = Math.min(order.length, Math.max(40, wanted * 5));
  for (let k = 0; k < attempts && placed < wanted; k++) {
    const { street, index, side } = order[k];
    const p = street.points[index];
    const prev = street.points[index - 1];
    const next = street.points[index + 1];
    let ta = next.a - prev.a;
    let tb = next.b - prev.b;
    const tl = Math.hypot(ta, tb) || 1;
    ta /= tl;
    tb /= tl;
    // The street's normal, on the chosen side.
    const na = -tb * side;
    const nb = ta * side;

    const dist = Math.hypot(p.a, p.b);
    // Working buildings want the edge of town; dwellings want the middle.
    const edge = dist / radius;
    const useWorks = works < wantWorks && edge > 0.55 && rng.chance(0.5);
    const name = useWorks
      ? pickWeighted(style.works, rng.next())
      : pickWeighted(style.houses, rng.next());
    const model = models[name];

    // Hard against the street. A wide verge is what turns a town into a
    // business park: buildings should crowd the road they were built for.
    const setback = street.width * 0.5 + rng.range(0.7, 2.0) + model.depth * 0.5;
    const a = p.a + na * setback;
    const b = p.b + nb * setback;
    if (Math.hypot(a, b) > radius * 1.2) continue;

    // Facing the street means facing back along the normal.
    const scale = rng.range(0.88, 1.14) * (edge > 0.7 ? 0.94 : 1);
    if (place(name, a, b, -na, -nb, scale)) {
      placed++;
      if (useWorks) works++;
    }
  }

  // --- Fields and orchards -------------------------------------------------

  {
    const farmed = tier >= 1;
    const count = farmed ? 40 + tier * 34 : 24;
    const outer = radius * 1.55;
    for (let i = 0; i < count; i++) {
      const angle = rng.next() * Math.PI * 2;
      const r = radius * 0.55 + Math.sqrt(rng.next()) * (outer - radius * 0.55);
      const a = Math.cos(angle) * r;
      const b = Math.sin(angle) * r;
      if (!free(a, b, 2.5)) continue;
      const dir = site.direction(a, b, scratch);
      const ground = field.sample(dir.x, dir.y, dir.z, SAMPLE_SPACING);
      if (ground.height < 1.4) continue;

      // Crops close in where the ground has been cleared, wild growth further
      // out — and what grows out there is whatever the climate already says
      // grows there, so a town's edge matches the biome it was built in.
      const crop = r < radius * 1.05 && farmed;
      let kind = 0;
      if (crop) kind = 1;
      else if (ground.temperature < 0.36) kind = 2;
      else if (ground.moisture < 0.34) kind = 3;
      else if (ground.temperature > 0.72 && ground.moisture < 0.5) kind = 3;

      const lush = 0.55 + ground.moisture * 0.7;
      props.push({
        origin: dir.clone().multiplyScalar(PLANET_RADIUS + ground.height - 0.25),
        rot: rng.next() * Math.PI,
        size: kind === 1
          ? rng.range(1.5, 2.3)
          : kind === 3
            ? rng.range(1.6, 2.8)
            : rng.range(3.4, 6.4),
        kind,
        tint:
          kind === 1
            ? [rng.range(0.34, 0.50), rng.range(0.34, 0.46), rng.range(0.09, 0.17)]
            : [
                rng.range(0.09, 0.20) * lush,
                rng.range(0.19, 0.34) * lush,
                rng.range(0.06, 0.15) * lush,
              ],
      });
    }
  }

  // --- People --------------------------------------------------------------
  // Only ever seen in the last few metres of a descent, so they are planned
  // cheaply: a start point on a street, a direction, and a distance to walk.

  if (roads.length > 0) {
    const count = Math.min(64, 6 + tier * 11);
    const skin: Rgb[] = [
      [0.44, 0.31, 0.22],
      [0.62, 0.46, 0.34],
      [0.31, 0.21, 0.15],
      [0.74, 0.60, 0.48],
    ];
    // Undyed wool, madder, woad, ochre, and the black everyone owns one of.
    // A crowd all in the flag's colour reads as a parade rather than a town.
    const cloth: Rgb[] = [
      [0.42, 0.38, 0.31],
      [0.34, 0.15, 0.12],
      [0.16, 0.20, 0.34],
      [0.46, 0.35, 0.14],
      [0.13, 0.12, 0.13],
      [0.28, 0.30, 0.22],
    ];
    for (let i = 0; i < count; i++) {
      const road = roads[rng.int(0, roads.length)];
      if (road.points.length < 3) continue;
      const j = rng.int(1, road.points.length - 1);
      const p = road.points[j];
      const along = road.points[j + 1].clone().sub(road.points[j - 1]).normalize();
      const up = p.clone().normalize();
      along.addScaledVector(up, -along.dot(up)).normalize();
      const lateral = new THREE.Vector3().crossVectors(up, along);
      const origin = p
        .clone()
        .addScaledVector(lateral, rng.range(-road.width * 0.35, road.width * 0.35));
      people.push({
        origin,
        along,
        speed: rng.range(0.8, 1.5),
        phase: rng.next(),
        span: rng.range(12, 34),
        tint: skin[rng.int(0, skin.length)],
        cloth: cloth[rng.int(0, cloth.length)],
      });
    }
  }

  return {
    cell: req.cell,
    tier: req.tier,
    era: req.era,
    signature: signatureOf(req),
    centre,
    radius,
    buildings,
    roads,
    props,
    people,
  };
}

export { TIER_RADIUS };

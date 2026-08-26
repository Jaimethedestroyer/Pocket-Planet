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
 * The work is split three ways. `layout.ts` draws the street network and hands
 * out plots along it, in flat metres, knowing nothing about the terrain or the
 * settlement's size. `plot.ts` holds the footprint arithmetic. This file is the
 * half that touches the ground: it puts that layout on real terrain, decides
 * how much of it is standing, and produces the fields and the people.
 *
 * Three properties the result has to hold, and each of them cost a rewrite to
 * get:
 *
 * **Growth is additive.** The plan is seeded from the *cell alone*. It used to
 * carry the tier, so the moment a village became a town every street moved and
 * every building was redrawn somewhere else — which is what the "a whole
 * quarter vanishes and a different one appears" pop-in actually was. Now the
 * layout is drawn once, at the largest size the town could ever reach, and the
 * tier only decides how much of it is standing. Nothing that exists at tier 2
 * moves at tier 3; there is simply more of it. `tools/probe-town.ts` asserts
 * that, because no single screenshot can show it.
 *
 * **Buildings are rectangles.** Plots are allocated as runs of frontage and
 * tested against each other with a separating-axis test on rotated rectangles
 * (see `plot.ts`), not as circles around their centres. That is what lets the
 * margins be small without walls passing through walls.
 *
 * **The terrain shapes the streets.** A street holds an elevation where it can,
 * and slides laterally onto its contour where the ground falls away — weighted
 * so that a street already running down the fall line is left to climb, because
 * that is what the streets of a hill town actually do.
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
import { Stream, makeRng, mixSeed } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { PlanetField } from '../../planet/heightfield';
import { archetypes } from './archetypes';
import type { ArchetypeName } from './archetypes';
import { foliageTint, samplePalette, townStyle } from './style';
import type { Rgb } from './style';
import { Occupancy, footprint } from './plot';
import type { Local } from './plot';
import { NEIGHBOUR_GAP, allocatePlots, densify, lerp, planStreets } from './layout';
import type { Plot, Street } from './layout';

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
  /**
   * How far out this road is drawn, as a multiple of the road layer's range.
   *
   * Roads are the first ground detail to appear on a descent because a road
   * reads from far higher than the buildings beside it — but that is only true
   * of a *route*. A back lane between two rows of houses is three metres wide
   * and, from six hundred metres up, contributes nothing but a pale thread, and
   * a region full of them reads as haze rather than as settlement. So the
   * ranges are nested inside the layer's own range, in the same spirit as the
   * layers are nested inside each other.
   */
  reach?: number;
}

/**
 * An open paved space, as a draped fan.
 *
 * Where several streets converge the ribbons used to simply overlap, and the
 * result was an undifferentiated slab whose shape was an accident of how many
 * roads happened to meet. A square is a piece of geometry with a boundary: the
 * civic building and the great work stand *on* it, and the streets run into it
 * rather than through each other.
 */
export interface Plaza {
  centre: THREE.Vector3;
  /** Rim points in order, closed implicitly. */
  rim: THREE.Vector3[];
  /** As for a road: 0 is beaten earth, 2 is paved. */
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

/**
 * A fire, a torch or a plume of chimney smoke.
 *
 * Planned with the town rather than spawned at draw time, for the same reason
 * everything else here is: a hearth that moved when the settlement grew would
 * be a hearth somebody put out and relit next door.
 */
export interface FirePlacement {
  /** World position of the foot of the flame. */
  origin: THREE.Vector3;
  /** Metres tall. */
  size: number;
  /** 0 campfire, 1 torch, 2 brazier, 3 chimney smoke. */
  kind: number;
  /** Offsets the flicker, so a row of torches is not one torch six times. */
  phase: number;
}

/**
 * A pennant on a mast, over something civic.
 *
 * The colour is not here. A town that changes hands keeps its streets and its
 * buildings — see `signatureOf` — and it must keep its banners too, or conquest
 * would replan the whole settlement to repaint a flag. The polity's colour is
 * applied at upload instead, which is why conquest is free.
 */
export interface BannerPlacement {
  /** World position of the foot of the mast. */
  origin: THREE.Vector3;
  /** Mast height above that point, in metres. */
  mast: number;
  /** Height of the cloth, in metres. */
  size: number;
  phase: number;
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
  /**
   * Per-person modulation of the sheet, about one.
   *
   * The era sheets are one pre-rendered figure walking one cycle, so without
   * this a street is that figure repeated. Varying what each of them catches of
   * the light breaks the row up at the distance people are actually seen from,
   * which is thirty metres and thirty pixels tall.
   */
  tone: Rgb;
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
  plazas: Plaza[];
  props: PropPlacement[];
  people: PersonPlacement[];
  fires: FirePlacement[];
  banners: BannerPlacement[];
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
const MAX_TIER = TIER_RADIUS.length - 1;

/** Vertex spacing to sample the terrain at. Fine: buildings sit on the detail. */
const SAMPLE_SPACING = 0.5;

/** How far a street may slide sideways to hold its contour, in metres. */
const MAX_CONTOUR_SHIFT = 5;

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

/**
 * How far sideways a point should move to sit on a target elevation.
 *
 * Two samples, either side of the street. The naive answer is
 * `(target - here) / gradient`, which is right when the ground falls away
 * across the street — the street is running along a contour and can slide onto
 * it — and explodes when it does not, because then the lateral direction *is*
 * the contour and no sideways movement changes anything. Damping the divide
 * turns that singularity into exactly the behaviour wanted: a street running
 * across the slope is pulled onto its contour, and a street running down the
 * fall line is left alone to climb, which is what the streets of a hill town
 * genuinely do.
 */
function contourShift(
  site: Site,
  a: number,
  b: number,
  ta: number,
  tb: number,
  target: number,
): number {
  const na = -tb;
  const nb = ta;
  const probe = 5;
  const hp = site.height(a + na * probe, b + nb * probe);
  const hm = site.height(a - na * probe, b - nb * probe);
  const grad = (hp - hm) / (2 * probe);
  const here = (hp + hm) * 0.5;
  const shift = ((target - here) * grad) / (grad * grad + 0.02);
  return Math.max(-MAX_CONTOUR_SHIFT, Math.min(MAX_CONTOUR_SHIFT, shift)) * 0.75;
}

/**
 * Plan one town.
 *
 * Cost is dominated by terrain sampling — two samples per street point for the
 * contour, one per road vertex for the drape, three per building — so it is
 * measured and budgeted by the caller rather than run for every settlement
 * every frame.
 */
export function planTown(req: TownRequest, field: PlanetField, worldSeed: number): TownPlan {
  const models = archetypes();
  const style = townStyle(req.era, req.culture);
  // The cell, and nothing else. Not the tier — that is what used to move every
  // building in the town the moment it grew — and not the era, so that a town
  // rebuilding itself in a new material rebuilds on its own streets.
  const geomSeed = mixSeed(worldSeed, req.cell * 7919);
  const rng = makeRng(geomSeed);

  const tier = Math.min(MAX_TIER, Math.max(0, req.tier));
  const radius = TIER_RADIUS[tier] * style.spread;
  const full = TIER_RADIUS[MAX_TIER] * style.spread;

  /**
   * The built radius in a given direction.
   *
   * A town whose buildings stop dead on a circle reads as a circle, however
   * organic the streets inside it are — the boundary is the shape the eye
   * actually picks up from four hundred metres. Two low harmonics break it
   * into lobes, which is what a settlement growing along its good ground
   * looks like from above.
   */
  const lobeA = rng.next() * Math.PI * 2;
  const lobeB = rng.next() * Math.PI * 2;
  const lobe = (a: number, b: number): number => {
    const theta = Math.atan2(b, a);
    return 1 + 0.2 * Math.sin(theta * 2 + lobeA) + 0.12 * Math.sin(theta * 3 + lobeB);
  };
  const radiusAt = (a: number, b: number): number => radius * lobe(a, b);

  const centreDir = req.unit.clone().normalize();
  const centreHeight = field.height(centreDir.x, centreDir.y, centreDir.z, SAMPLE_SPACING);
  const centre = centreDir.clone().multiplyScalar(PLANET_RADIUS + centreHeight);
  const site = new Site(field, centre);

  const buildings: Placement[] = [];
  const roads: RoadPath[] = [];
  const plazas: Plaza[] = [];
  const props: PropPlacement[] = [];
  const people: PersonPlacement[] = [];
  const fires: FirePlacement[] = [];
  const banners: BannerPlacement[] = [];
  const taken = new Occupancy(26);

  const scratch = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const bEast = new THREE.Vector3();
  const bNorth = new THREE.Vector3();

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
    prng: Rng,
    // 'normal' tests against everything already standing. 'planned' skips that
    // test because the master plan already resolved this building against its
    // neighbours — repeating it here would let a building vanish when the one
    // beside it is finally built, which is the pop-in this file exists to
    // avoid. 'forced' is the great work: it goes where it goes.
    mode: 'normal' | 'planned' | 'forced' = 'normal',
  ): boolean => {
    const model = models[name];
    const fl = Math.hypot(facingA, facingB) || 1;
    const fa = facingA / fl;
    const fb = facingB / fl;
    const foot = footprint(a, b, model.width * scale, model.depth * scale, fa, fb);
    if (mode === 'normal' && !taken.free(foot, NEIGHBOUR_GAP)) return false;

    const h0 = site.height(a, b);
    // Freeboard, not merely "above sea level". The sea is not a plane: it has
    // three bands of wave geometry and a surf line that runs up to three metres
    // of depth, so ground half a metre proud of the datum is ground the water
    // is standing on. A town planned to that threshold does not look coastal,
    // it looks flooded — a scatter of roofs across a tidal flat with surf
    // breaking between the houses.
    if (h0 < 1.8) return false;
    const probe = Math.max(3, foot.br);
    const hA = site.height(a + probe, b);
    const hB = site.height(a, b + probe);
    const slope = Math.hypot(hA - h0, hB - h0) / probe;
    if (mode !== 'forced' && slope > 0.38) return false;
    if (slope > 0.62) return false;

    // Bury the base deep enough that the downhill corner still meets ground.
    const sink = 0.28 + slope * foot.br * 1.25;
    const dir = site.direction(a, b, scratch);
    const origin = dir.clone().multiplyScalar(PLANET_RADIUS + h0 - sink);

    const up = dir.clone();
    basisAt(up, bEast, bNorth);
    facing
      .copy(site.east)
      .multiplyScalar(fa)
      .addScaledVector(site.north, fb)
      .normalize();
    const rot = Math.atan2(-facing.dot(bEast), facing.dot(bNorth));

    const shade = prng.next();
    const jitter = prng.range(-0.06, 0.06);
    buildings.push({
      archetype: name,
      origin,
      rot,
      scale: new THREE.Vector3(
        scale,
        scale * prng.range(0.94, 1.12),
        scale,
      ),
      wall: samplePalette(style.wallA, style.wallB, shade, jitter),
      roof: samplePalette(style.roofA, style.roofB, prng.next(), jitter * 0.5),
      style: style.courses * prng.range(0.8, 1.15),
    });
    taken.add(foot);
    return true;
  };

  /**
   * A banner over a building, flying from a mast on its ridge.
   *
   * Scaled off the building rather than fixed, so a flag on a great hall is a
   * flag and a flag on a cathedral is a flag on a cathedral. The mast stands
   * proud of the roof by about a fifth of the building's own height, which is
   * enough to clear a spire's finial without looking like a radio antenna.
   */
  const raiseBanner = (name: ArchetypeName, prng: Rng): void => {
    if (req.ruined) return;
    const built = buildings[buildings.length - 1];
    const height = models[name].height * built.scale.y;
    const up = built.origin.clone().normalize();
    banners.push({
      origin: built.origin.clone().addScaledVector(up, height * 0.94),
      mast: Math.max(2.2, height * 0.22) + prng.range(0, 0.8),
      size: Math.max(1.5, Math.min(4.5, height * 0.16)),
      phase: prng.next(),
    });
  };

  /**
   * Light and smoke, hung off a building that actually got built.
   *
   * Called with the same stream `place` was handed, immediately after it
   * succeeded, which is what keeps a hearth attached to *its* house: the stream
   * is seeded from the plot rather than drawn in sequence, so a village that
   * grows into a city relights the same fires in the same yards instead of
   * redealing them across the whole town.
   *
   * A ruin gets nothing. Nobody is home. Nor does a great work: a ziggurat is
   * not heated, and a cathedral with a smoking chimney is a factory.
   */
  const lightUp = (
    name: ArchetypeName,
    a: number,
    b: number,
    prng: Rng,
    chimney = true,
  ): void => {
    if (req.ruined) return;
    const model = models[name];
    const built = buildings[buildings.length - 1];
    const hearths = style.hearths;
    const up = built.origin.clone().normalize();

    // On the roof. The one that reads by day, and the only reason an industrial
    // city looks like it is working rather than merely standing there.
    const top = model.height * built.scale.y;
    if (chimney && prng.chance(hearths.chimney)) {
      fires.push({
        origin: built.origin
          .clone()
          .addScaledVector(up, top * 0.92)
          .addScaledVector(site.east, prng.range(-0.25, 0.25) * model.width)
          .addScaledVector(site.north, prng.range(-0.25, 0.25) * model.depth),
        // Capped, because the plume is smoke from a hearth rather than from the
        // building: a hall four times the height of a house does not burn four
        // times as much wood.
        size: prng.range(0.9, 1.5) * (3.0 + Math.min(top, 14) * 0.3),
        kind: 3,
        phase: prng.next(),
      });
    }

    // On the ground beside it, or up the wall. Drawn from one roll rather than
    // three, so a house that keeps a fire in the yard is not also carrying a
    // torch and a brazier.
    const roll = prng.next();
    let kind = -1;
    if (roll < hearths.campfire) kind = 0;
    else if (roll < hearths.campfire + hearths.torch) kind = 1;
    else if (roll < hearths.campfire + hearths.torch + hearths.brazier) kind = 2;
    if (kind < 0) return;

    const angle = prng.next() * Math.PI * 2;
    const reach = Math.max(model.width, model.depth) * 0.5 + prng.range(1.1, 2.4);
    const spot = new THREE.Vector3();
    // Never on water, and never on the ground the neighbours are standing on.
    if (site.world(a + Math.cos(angle) * reach, b + Math.sin(angle) * reach, 0, spot) < 1.5) {
      return;
    }
    // A torch is in a bracket on the wall; the other two sit on the ground.
    if (kind === 1) spot.addScaledVector(up, prng.range(1.9, 2.6));
    fires.push({
      origin: spot,
      size:
        kind === 0
          ? prng.range(1.3, 1.9)
          : kind === 1
            ? prng.range(0.8, 1.1)
            : prng.range(1.1, 1.6),
      kind,
      phase: prng.next(),
    });
  };

  const finish = (): TownPlan => ({
    cell: req.cell,
    tier: req.tier,
    era: req.era,
    signature: signatureOf(req),
    centre,
    radius,
    buildings,
    roads,
    plazas,
    props,
    people,
    fires,
    banners,
  });

  // --- Ruins: nothing standing, only what the weather has not taken --------

  if (req.ruined) {
    // The great work outlasts the town. Weathered along with everything else
    // below, but standing, and at full size — that is the whole point of it.
    if (req.wonder) {
      const angle = rng.next() * Math.PI * 2;
      place(req.wonder, 0, 0, Math.cos(angle), Math.sin(angle), 1, rng, 'forced');
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
        rng,
      );
    }
    for (const b of buildings) {
      // Weathered: greyer, and the roof colour went with the roof.
      b.wall = [b.wall[0] * 0.72 + 0.06, b.wall[1] * 0.74 + 0.07, b.wall[2] * 0.7 + 0.06];
      b.roof = b.wall;
    }
    return finish();
  }

  // --- Streets ------------------------------------------------------------

  // How far out anything is drawn. A little past the built radius, so the
  // roads leave town rather than stopping at the last house.
  const emit = radius * 1.16;

  /**
   * Everything this town can possibly touch, in metres.
   *
   * One number, because three separate almost-right thresholds is how a
   * building ends up interpolating a contour that was never computed. It has to
   * cover the furthest road drawn, the furthest plot allocated (the built
   * radius at its widest lobe, plus the deepest setback), and the street points
   * bracketing that plot, which can be another segment further out again.
   */
  const window = radius * 1.5 + 40;

  const streets = planStreets(style, full, window, rng);

  /**
   * Is this site steep enough for the contour pass to be worth paying for?
   *
   * Six probes, against about two per street point over the whole built area —
   * and most settlements are on gentle ground, because that is where the
   * simulation puts them. On a site with four metres of relief across the whole
   * town every shift comes out under a metre and nothing about the streets
   * reads differently, so the cheapest correct answer is not to look.
   *
   * Measured across the town's *ultimate* radius, never its current one. A town
   * judged flat at one size and hilly at the next would move every street it
   * already had, which is exactly the thing this file exists to prevent.
   */
  let relief = 0;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = full * (i % 2 === 0 ? 0.5 : 0.95);
    relief = Math.max(relief, Math.abs(site.height(Math.cos(a) * r, Math.sin(a) * r) - centreHeight));
  }
  const contoured = relief > 5;

  // Put each street on its contour, but only over the stretch that will
  // actually be drawn: sampling the whole ultimate network for a hamlet would
  // cost four times what the hamlet does.
  for (const street of contoured ? streets : []) {
    const pts = street.points;
    if (pts.length < 3) continue;
    // The elevation the street holds to: the terrain at the point of the
    // street nearest the town centre. Chosen by index, so it does not move as
    // the town grows.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = pts[i].a * pts[i].a + pts[i].b * pts[i].b;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const target = site.height(pts[best].a, pts[best].b);
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      if (Math.hypot(p.a, p.b) > window) continue;
      const prev = pts[i - 1];
      const next = pts[i + 1];
      const dx = next.a - prev.a;
      const dy = next.b - prev.b;
      const len = Math.hypot(dx, dy) || 1;
      street.shift[i] = contourShift(site, p.a, p.b, dx / len, dy / len, target);
    }
  }

  /** A street point, contour-shifted. */
  const shifted = (street: Street, i: number, out: Local): Local => {
    const pts = street.points;
    const p = pts[i];
    const s = street.shift[i];
    if (s === 0) {
      out.a = p.a;
      out.b = p.b;
      return out;
    }
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next.a - prev.a;
    const dy = next.b - prev.b;
    const len = Math.hypot(dx, dy) || 1;
    out.a = p.a + (-dy / len) * s;
    out.b = p.b + (dx / len) * s;
    return out;
  };

  /** The lateral offset a plot inherits from the street it fronts onto. */
  const shiftAt = (street: Street, arc: number): number => {
    const table = street.arc;
    let lo = 0;
    let hi = table.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (table[mid] <= arc) lo = mid;
      else hi = mid;
    }
    const span = table[hi] - table[lo] || 1;
    const t = (arc - table[lo]) / span;
    return lerp(street.shift[lo], street.shift[hi], t);
  };

  const scratchLocal: Local = { a: 0, b: 0 };
  for (const street of streets) {
    if (street.points.length < 2) continue;
    // Clip to what this town has actually grown to, then drape. Streets are
    // planned on a flat disc and the disc does not know where the sea is: a
    // coastal town's grid runs straight off the beach otherwise — and takes the
    // people walking on it with it, which is how this was found. Cut the
    // polyline at the waterline instead of clamping it: a road that stops at
    // the shore is right, and one that hugs the waterline is not.
    let run: THREE.Vector3[] = [];
    const flush = (): void => {
      if (run.length >= 2) {
        roads.push({
          points: run,
          width: street.width,
          grade: street.grade,
          reach: street.reach,
        });
      }
      run = [];
    };
    const line: Local[] = [];
    for (let i = 0; i < street.points.length; i++) {
      const p = street.points[i];
      if (Math.hypot(p.a, p.b) > emit) {
        if (line.length >= 2) {
          for (const q of densify(line, 6)) {
            const v = new THREE.Vector3();
            if (site.world(q.a, q.b, 0, v) < 1.5) flush();
            else run.push(v);
          }
        }
        flush();
        line.length = 0;
        continue;
      }
      const s = shifted(street, i, scratchLocal);
      line.push({ a: s.a, b: s.b });
    }
    if (line.length >= 2) {
      for (const q of densify(line, 6)) {
        const v = new THREE.Vector3();
        if (site.world(q.a, q.b, 0, v) < 1.5) flush();
        else run.push(v);
      }
    }
    flush();
  }

  // --- The centre: a square, the civic buildings and the great work ---------
  //
  // Everything here is *chosen* unconditionally and *built* conditionally. The
  // choices come off one stream in a fixed order, and each building draws its
  // own detail from its own seed, so a town that grows large enough to raise a
  // cathedral does not thereby shift which civic hall it built four hundred
  // years earlier — and the space both of them stand on is kept clear from the
  // start, at every tier, so growing into them displaces nothing.

  const centreRng = makeRng(mixSeed(geomSeed, 4409));
  const monument = style.monuments[centreRng.int(0, style.monuments.length)];
  // A lighthouse is a navigation *tower*, which is an ancient invention and
  // later. A primitive fishing village wanting a light on the headland lights a
  // fire on it; it does not build the Pharos.
  const canLight = req.coastal && req.era >= Era.Ancient;
  const wantsLight = centreRng.chance(0.35);
  const monumentAngle = centreRng.next() * Math.PI * 2;
  const monumentName = req.wonder ?? (canLight && wantsLight ? 'lighthouse' : monument);

  const civicName = style.civic[centreRng.int(0, style.civic.length)];
  const civicAngle = centreRng.next() * Math.PI * 2;
  const plazaWobble = centreRng.next() * Math.PI * 2;

  /**
   * The open ground at the centre, in metres.
   *
   * Deliberately modest and deliberately free of the tier: it is the exclusion
   * the master plan is built around, and anything here that changed as the town
   * grew would move houses that are already standing.
   */
  const courtRadius = Math.max(style.roadWidth * 1.8, 6);
  const civicRadius = courtRadius + models[civicName].depth * 0.5 + 1.5;

  /** The ground the centre reserves, whether or not it is standing on it yet. */
  const reserve = (occupancy: Occupancy): void => {
    const m = models[monumentName];
    occupancy.add(
      footprint(
        0,
        0,
        Math.max(m.width, courtRadius * 2),
        Math.max(m.depth, courtRadius * 2),
        Math.cos(monumentAngle),
        Math.sin(monumentAngle),
      ),
    );
    const c = models[civicName];
    occupancy.add(
      footprint(
        Math.cos(civicAngle) * civicRadius,
        Math.sin(civicAngle) * civicRadius,
        c.width,
        c.depth,
        -Math.cos(civicAngle),
        -Math.sin(civicAngle),
      ),
    );
  };
  reserve(taken);

  let centreClear = 0;
  if (req.wonder || tier >= 4 || req.capital) {
    // A real great work if the simulation raised one here; otherwise a large
    // town still builds *something* for itself, it just is not history.
    const monumentRng = makeRng(mixSeed(geomSeed, 4410));
    if (place(
      monumentName,
      0,
      0,
      Math.cos(monumentAngle),
      Math.sin(monumentAngle),
      1,
      monumentRng,
      'forced',
    )) {
      lightUp(monumentName, 0, 0, monumentRng, false);
      // The great work flies one whether or not the town is a capital: it is
      // the tallest thing for a mile and the only place a flag would be seen.
      raiseBanner(monumentName, monumentRng);
    }
    const m = models[monumentName];
    centreClear = Math.max(m.width, m.depth) * 0.75;
  }

  if (tier >= 2) {
    // The civic building stands on the edge of the square, facing in.
    const civicRng = makeRng(mixSeed(geomSeed, 4411));
    const civicA = Math.cos(civicAngle) * civicRadius;
    const civicB = Math.sin(civicAngle) * civicRadius;
    if (place(
      civicName,
      civicA,
      civicB,
      -Math.cos(civicAngle),
      -Math.sin(civicAngle),
      1,
      civicRng,
      'forced',
    )) {
      lightUp(civicName, civicA, civicB, civicRng);
      raiseBanner(civicName, civicRng);
    }
  }

  // The square itself: the court, widened to hold whatever ended up standing in
  // the middle of it, and to give the streets somewhere to arrive.
  const plazaRadius = Math.min(
    Math.max(courtRadius, centreClear + 5),
    Math.max(courtRadius, radius * 0.55),
  );
  {
    const rim: THREE.Vector3[] = [];
    const segments = 18;
    let dry = true;
    const centreWorld = new THREE.Vector3();
    site.world(0, 0, 0, centreWorld);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      // Not a disc: a square is bounded by whatever was built around it.
      const r = plazaRadius * (1 + 0.14 * Math.sin(a * 2 + plazaWobble) + 0.07 * Math.sin(a * 5));
      const v = new THREE.Vector3();
      if (site.world(Math.cos(a) * r, Math.sin(a) * r, 0, v) < 1.5) dry = false;
      rim.push(v);
    }
    // A primitive common is beaten earth; anything later has paved it.
    if (dry) plazas.push({ centre: centreWorld, rim, grade: req.era === Era.Primitive ? 0 : 2 });

    // And what burns in the middle of it. The square is the one place in a
    // settlement that is *civic* rather than somebody's yard, so this is the
    // fire that says which century the town is in: a common bonfire, then a
    // brazier, and then nothing at all once the streets have lamps of their
    // own. Off centre by half the square, because the great work is at nought.
    if (dry && style.squareFire >= 0) {
      const angle = centreRng.next() * Math.PI * 2;
      const r = Math.max(plazaRadius * 0.55, centreClear + 2.5);
      const spot = new THREE.Vector3();
      if (site.world(Math.cos(angle) * r, Math.sin(angle) * r, 0, spot) >= 1.5) {
        fires.push({
          origin: spot,
          size: style.squareFire === 0 ? 3.0 : 2.1,
          kind: style.squareFire,
          phase: centreRng.next(),
        });
      }
    }
  }

  // --- Frontage: which of the town's plots are standing yet -----------------

  // The furthest out a building can stand: the built radius at its widest lobe,
  // with a little slack. Everything past it is layout that this town has not
  // grown into yet.
  const reach = radius * 1.33;
  const plots = allocatePlots(streets, style, models, full, reach, geomSeed);
  // Slide each plot onto its street's contour *before* resolving the plan, so
  // that what the collision pass sees is where the building actually ends up.
  // The shift costs nothing here — the terrain was sampled once for the street
  // and every plot along it interpolates that — and doing it afterwards would
  // mean neighbours resolved against positions neither of them occupies.
  for (const plot of plots) {
    const shift = shiftAt(streets[plot.street], plot.arc);
    if (shift !== 0) {
      plot.a += plot.la * shift;
      plot.b += plot.lb * shift;
      plot.dist = Math.hypot(plot.a, plot.b);
    }
  }
  // Nearest first, which is stable and puts the collision resolution where the
  // town is densest. This order does not depend on the tier, so the set of
  // plots that survive collision is the same at every size — growth reveals
  // more of one fixed master plan rather than drawing a new one.
  plots.sort((p, q) => p.dist - q.dist || p.seed - q.seed);

  const survivors: Plot[] = [];
  const master = new Occupancy(26);
  reserve(master);
  for (const plot of plots) {
    const foot = footprint(plot.a, plot.b, plot.width, plot.depth, plot.fa, plot.fb);
    if (!master.free(foot, NEIGHBOUR_GAP)) continue;
    master.add(foot);
    survivors.push(plot);
  }

  /**
   * What fraction of the master plan is standing at this tier.
   *
   * Derived rather than authored, because the number of plots inside a given
   * radius depends on the layout, the era's frontage and how much of the disc
   * is buildable. Taking a running maximum guarantees the fraction never falls
   * as the town grows, which is the invariant that makes growth additive: a
   * building that exists at one tier exists at every tier above it.
   */
  let fill = 0;
  for (let t = 0; t <= tier; t++) {
    const r = TIER_RADIUS[t] * style.spread;
    let inside = 0;
    for (const plot of survivors) if (plot.dist <= r) inside++;
    const want = Math.round(TIER_BUILDINGS[t] * (req.capital ? 1.18 : 1));
    fill = Math.max(fill, inside > 0 ? Math.min(1, (want * 1.15) / inside) : 1);
  }

  // No cap on the count. A hard stop once `wanted` buildings are standing reads
  // as an obvious optimisation and is a subtle correctness bug: the fraction
  // grows with the tier, so the plots that fill in ahead of a late one push it
  // past the cap, and a house that was standing last century is gone. The
  // fraction is the only thing deciding how much is built.
  const plotRng = new Stream();
  for (const plot of survivors) {
    if (plot.u >= fill) continue;
    const here = radiusAt(plot.a, plot.b);
    if (plot.dist > here) continue;
    // Thin out towards the boundary. A town that is solid to its last house and
    // then bare ground has an edge you can trace with a finger; a real one
    // frays into its fields. The probability only ever falls as the town grows,
    // so this fringe fills in rather than moving.
    const edge = plot.dist / here;
    if (edge > 0.72 && plot.fringe < (edge - 0.72) * 2.6) continue;
    plotRng.reseed(plot.seed ^ 0x5bf03635);
    if (place(plot.name, plot.a, plot.b, plot.fa, plot.fb, plot.scale, plotRng, 'planned')) {
      lightUp(plot.name, plot.a, plot.b, plotRng);
    }
  }

  // --- Fields and orchards -------------------------------------------------

  {
    const fieldRng = makeRng(mixSeed(geomSeed, 911));
    const farmed = tier >= 1;
    const count = farmed ? 40 + tier * 34 : 24;
    const outer = radius * 1.55;
    for (let i = 0; i < count; i++) {
      const angle = fieldRng.next() * Math.PI * 2;
      const r = radius * 0.55 + Math.sqrt(fieldRng.next()) * (outer - radius * 0.55);
      const a = Math.cos(angle) * r;
      const b = Math.sin(angle) * r;
      if (!taken.free(footprint(a, b, 5, 5, 1, 0), 0)) continue;
      const dir = site.direction(a, b, scratch);
      const ground = field.sample(dir.x, dir.y, dir.z, SAMPLE_SPACING);
      if (ground.height < 1.8) continue;

      // Crops close in where the ground has been cleared, wild growth further
      // out — and what grows out there is whatever the climate already says
      // grows there, so a town's edge matches the biome it was built in.
      const crop = r < radius * 1.05 && farmed;
      let kind = 0;
      if (crop) kind = 1;
      else if (ground.temperature < 0.36) kind = 2;
      else if (ground.moisture < 0.34) kind = 3;
      else if (ground.temperature > 0.72 && ground.moisture < 0.5) kind = 3;

      props.push({
        origin: dir.clone().multiplyScalar(PLANET_RADIUS + ground.height - 0.25),
        rot: fieldRng.next() * Math.PI,
        size: kind === 1
          ? fieldRng.range(1.5, 2.3)
          : kind === 3
            ? fieldRng.range(1.6, 2.8)
            : fieldRng.range(3.4, 6.4),
        kind,
        tint: foliageTint(fieldRng, kind, ground.moisture),
      });
    }
  }

  // --- People --------------------------------------------------------------
  // Only ever seen in the last few metres of a descent, so they are planned
  // cheaply: a start point on a street, a direction, and a distance to walk.

  if (roads.length > 0) {
    const walkRng = makeRng(mixSeed(geomSeed, 1327));
    const count = Math.min(64, 6 + tier * 11);
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
      const road = roads[walkRng.int(0, roads.length)];
      if (road.points.length < 3) continue;
      const j = walkRng.int(1, road.points.length - 1);
      const p = road.points[j];
      const along = road.points[j + 1].clone().sub(road.points[j - 1]).normalize();
      const up = p.clone().normalize();
      along.addScaledVector(up, -along.dot(up)).normalize();
      const lateral = new THREE.Vector3().crossVectors(up, along);
      const origin = p
        .clone()
        .addScaledVector(lateral, walkRng.range(-road.width * 0.35, road.width * 0.35));
      people.push({
        origin,
        along,
        speed: walkRng.range(0.8, 1.5),
        phase: walkRng.next(),
        span: walkRng.range(12, 34),
        tone: [
          walkRng.range(0.84, 1.14),
          walkRng.range(0.84, 1.12),
          walkRng.range(0.82, 1.10),
        ],
        cloth: cloth[walkRng.int(0, cloth.length)],
      });
    }
  }

  return finish();
}

export { TIER_RADIUS };

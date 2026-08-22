/**
 * The two-dimensional layout of a town: its streets, and the plots along them.
 *
 * Nothing in this file knows that the world is a sphere, that there is terrain
 * under it, or what tier the settlement is. It takes an era's style and the
 * radius of the largest the town could ever become, and returns a street
 * network and a set of building plots in metres.
 *
 * That ignorance is the point, twice over.
 *
 * It is what makes the layout **cheap**: laying out the whole ultimate network
 * costs arithmetic and no terrain samples at all, so `plan.ts` can walk it in
 * full for a hamlet and pay only for the handful of buildings the hamlet
 * actually stands up.
 *
 * And it is what makes growth **additive**: every dimension here is either
 * absolute or a fraction of the town's ultimate size, never of its size now, so
 * a village is the middle of the same network the city eventually fills. Ring
 * roads sit at fixed distances for the same reason — a town that outgrows one
 * gets the next one out, which is what a town outgrowing its wall looks like.
 * The moment anything in this file starts depending on the current tier, every
 * street in every growing town moves, and the player watches a quarter of a
 * city be replaced by a different quarter of a city.
 */

import { Stream, mixSeed } from '../../core/rng';
import type { Rng } from '../../core/rng';
import type { archetypes } from './archetypes';
import type { ArchetypeName } from './archetypes';
import { pickWeighted } from './style';
import type { TownStyle } from './style';
import { along, arcLengths } from './plot';
import type { Local } from './plot';

/**
 * Clear ground demanded between two neighbouring buildings, in metres.
 *
 * Small on purpose. With a correct overlap test this is a *gap*, not a fudge
 * factor covering an approximation, and a terrace of houses on a medieval
 * street is separated by a hand's breadth and a drip line, not by a garden.
 */
export const NEIGHBOUR_GAP = 0.7;

export interface Street {
  points: Local[];
  width: number;
  grade: number;
  /** How far out this street is drawn. See `RoadPath.reach`. */
  reach: number;
  /** Whether buildings may front onto it. */
  frontage: boolean;
  /**
   * Lateral displacement per point, in metres, that puts the street on its
   * contour. Filled in once the terrain is known; zero outside the built area,
   * where nothing is drawn and nothing needs sampling.
   */
  shift: Float64Array;
  /** Cumulative arc length at each point, for allocating frontage. */
  arc: number[];
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Resample a polyline so its points are at most `step` apart. */
export function densify(points: Local[], step: number): Local[] {
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

/**
 * Trim a street to the window the town can actually reach.
 *
 * A street is drawn at the town's ultimate length — a metropolis's high street
 * is a quarter of a kilometre — and a hamlet touches thirty metres of it. Every
 * point outside that window is a densify, an arc length and a distance test
 * spent on geometry nothing will ever ask about, twenty times over per town.
 *
 * Safe to do only because the frontage walk is anchored at the street's nearest
 * point to the town centre, not at its end: the window keeps that point, so arc
 * lengths shift by a constant and every plot lands exactly where it landed at
 * the tier before. Anchoring at the end instead would make this optimisation
 * silently renumber every building in the town.
 */
function clipToWindow(points: Local[], window: number): Local[] {
  const limit = window * window;
  let anchor = 0;
  let nearest = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = points[i].a * points[i].a + points[i].b * points[i].b;
    if (d < nearest) {
      nearest = d;
      anchor = i;
    }
  }
  if (nearest > limit) return [];

  const inside = (i: number): boolean =>
    points[i].a * points[i].a + points[i].b * points[i].b <= limit;
  let lo = anchor;
  let hi = anchor;
  while (lo > 0 && inside(lo - 1)) lo--;
  while (hi < points.length - 1 && inside(hi + 1)) hi++;
  // One point past each end, so the polyline still crosses the boundary rather
  // than stopping exactly on it.
  if (lo > 0) lo--;
  if (hi < points.length - 1) hi++;
  return lo === 0 && hi === points.length - 1 ? points : points.slice(lo, hi + 1);
}

/**
 * Build the street network for one town, at its ultimate size.
 *
 * Every dimension here is either absolute or a fraction of `full`, which is the
 * radius of the largest this town could ever be — never of its radius *now*.
 * That is the whole trick behind additive growth: a hamlet is the middle of
 * this network with everything past twenty metres not yet built, and when it
 * becomes a village the same streets simply extend. Ring roads sit at fixed
 * distances for the same reason, and a town that outgrows one gets the next
 * one out, which is what a town outgrowing its wall looks like.
 *
 * `window` is how much of that ultimate network this town can touch. Streets
 * are laid out in full and then trimmed to it — the layout is decided at the
 * ultimate size, the *geometry* is only built where it is needed. Everything
 * one street derives from another is taken from the untrimmed line, because the
 * trim depends on the tier and nothing about the layout may.
 */
export function planStreets(
  style: TownStyle,
  full: number,
  window: number,
  rng: Rng,
): Street[] {
  const streets: Street[] = [];
  const main = style.roadWidth;
  const lane = main * 0.72;
  const turn = rng.next() * Math.PI * 2;

  const add = (
    points: Local[],
    width: number,
    grade: number,
    reach = 0.7,
  ): void => {
    const clipped = clipToWindow(points, window);
    streets.push({
      points: clipped,
      width,
      grade,
      reach,
      frontage: true,
      shift: new Float64Array(clipped.length),
      arc: clipped.length > 1 ? arcLengths(clipped) : [0],
    });
  };

  const rotate = (p: Local, angle: number): Local => ({
    a: p.a * Math.cos(angle) - p.b * Math.sin(angle),
    b: p.a * Math.sin(angle) + p.b * Math.cos(angle),
  });

  const ringAt = (rr: number, waves: number, amp: number): Local[] => {
    const ring: Local[] = [];
    const segments = Math.max(16, Math.round(rr * 0.5));
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const r = rr * (1 + Math.sin(a * waves + turn) * amp);
      ring.push({ a: Math.cos(a) * r, b: Math.sin(a) * r });
    }
    return ring;
  };

  if (style.layout === 'cluster') {
    // No streets, only tracks radiating from the common ground.
    const spokes = 6;
    for (let i = 0; i < spokes; i++) {
      const a = turn + (i / spokes) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const len = full * rng.range(0.5, 0.78);
      add(
        densify(
          wander(
            { a: Math.cos(a) * 9, b: Math.sin(a) * 9 },
            { a: Math.cos(a) * len, b: Math.sin(a) * len },
            full * 0.07,
            6,
            rng,
          ),
          9,
        ),
        main,
        0,
        0.85,
      );
    }
    // Dwellings face inwards onto the common, which is what makes a cluster of
    // huts read as a village rather than as scattered huts. Later rings are
    // the village growing outwards around the same common.
    for (const rr of [13, 30, 52, 80]) {
      const r = rr * style.spread;
      if (r > full) break;
      add(ringAt(r, 3, 0.06), main * 0.8, 0, 0.65);
    }
    return streets;
  }

  if (style.layout === 'grid' || style.layout === 'avenue') {
    // A fixed block size, so the grid a hamlet sits in the middle of is the
    // same grid the city eventually fills. Sizing blocks by the current radius
    // is what used to redraw the whole town on every tier change.
    const block = style.layout === 'avenue' ? 32 : 26;
    const n = Math.ceil(full / block);
    for (let i = -n; i <= n; i++) {
      const off = i * block + rng.range(-2, 2);
      const half = Math.sqrt(Math.max(0, full * full - off * off));
      if (half < 12) continue;
      add(
        densify([{ a: -half, b: off }, { a: half, b: off }], 10).map((p) => rotate(p, turn)),
        i === 0 ? main * 1.5 : main,
        i === 0 ? 2 : 1,
        i === 0 ? 1 : 0.7,
      );
      add(
        densify([{ a: off, b: -half }, { a: off, b: half }], 10).map((p) => rotate(p, turn)),
        i === 0 ? main * 1.2 : lane,
        1,
        i === 0 ? 0.9 : 0.62,
      );
    }
    return streets;
  }

  // Organic: one route through, lanes hanging off it, and rings at the
  // distances a town has historically stopped and walled itself at.
  const spine = densify(
    wander(
      rotate({ a: -full * 1.05, b: 0 }, turn),
      rotate({ a: full * 1.05, b: 0 }, turn),
      full * 0.22,
      11,
      rng,
    ),
    9,
  );
  add(spine, main, 1, 0.95);

  const cross = densify(
    wander(
      rotate({ a: 0, b: -full * 0.95 }, turn + rng.range(-0.4, 0.4)),
      rotate({ a: 0, b: full * 0.95 }, turn + rng.range(-0.4, 0.4)),
      full * 0.2,
      9,
      rng,
    ),
    9,
  );
  add(cross, main * 0.9, 1, 0.85);

  // Hung off the *untrimmed* spine and cross. Reading a host's stored points
  // instead would make the choice depend on how much of it this town happens to
  // have trimmed away, and every lane in the town would move as it grew.
  const hosts = [spine, cross];
  const lanes = 16;
  for (let i = 0; i < lanes; i++) {
    const host = hosts[rng.int(0, hosts.length)];
    const at = host[rng.int(1, host.length - 1)];
    const angle = rng.next() * Math.PI * 2;
    const len = full * rng.range(0.22, 0.5);
    const end = { a: at.a + Math.cos(angle) * len, b: at.b + Math.sin(angle) * len };
    if (Math.hypot(end.a, end.b) > full) continue;
    add(densify(wander(at, end, full * 0.1, 5, rng), 8), lane, 1, 0.55);
  }

  for (const rr of [46, 92]) {
    const r = rr * style.spread;
    if (r > full) break;
    add(ringAt(r, 3, 0.07), lane, 1, 0.72);
  }

  return streets;
}

/** One allocated building plot, before anything is known about the ground. */
export interface Plot {
  /**
   * Centre of the footprint, on flat ground. `plan.ts` slides this sideways
   * onto its street's contour before anything is resolved against it.
   */
  a: number;
  b: number;
  /** Facing: back across the street the plot fronts onto. */
  fa: number;
  fb: number;
  name: ArchetypeName;
  scale: number;
  width: number;
  depth: number;
  /** Metres from the town centre. What decides whether this plot is built yet. */
  dist: number;
  /** Host street, where along it the frontage sits, and the street's lateral. */
  street: number;
  arc: number;
  la: number;
  lb: number;
  /** Stable draws: which plots are built yet, and how they fray at the edge. */
  u: number;
  fringe: number;
  /** Seed for everything else about this building. */
  seed: number;
}

/**
 * Walk the frontage and hand out plots.
 *
 * The old planner sampled points along the streets, shuffled them, and tested a
 * circle at each. Allocating a *run* of frontage per building instead is both
 * cheaper — no rejections — and produces the thing a street actually looks
 * like: houses shoulder to shoulder along a line, with the odd yard or alley
 * between them, rather than a scatter that happens to be near a road.
 *
 * The walk starts at the point of each street nearest the town centre and runs
 * *outwards* in both directions, rather than from one end to the other. That
 * anchor is where a settlement grows from, and it is also what keeps the cost
 * of planning proportional to the size of the town rather than to the size of
 * the network it will one day fill: walking a metropolis's frontage from end to
 * end to build a hamlet made planning a hamlet cost seven times what it should.
 * The anchor is chosen by distance and so does not move as the town grows,
 * which is what lets the walk be stopped early without shifting anything.
 *
 * Nothing here touches the terrain, and nothing here depends on the tier.
 */
export function allocatePlots(
  streets: Street[],
  style: TownStyle,
  models: ReturnType<typeof archetypes>,
  full: number,
  reach: number,
  baseSeed: number,
): Plot[] {
  const plots: Plot[] = [];
  const cursor = { a: 0, b: 0, ta: 0, tb: 0 };
  const prng = new Stream();
  // A plot outside the built area is not worth allocating, and — less obviously
  // — cannot matter. The master plan resolves plots nearest-first, so a plot
  // beyond the built radius can only ever be *rejected* by one inside it, never
  // reject one; and it is never revealed. It has no effect on anything, at any
  // tier, so not allocating it changes nothing but the bill.
  //
  // The *street* margin is a different matter, and is not decoration. A plot
  // sits back from its street by up to about eighteen metres for the deepest
  // working building, and on either side, so a street thirty metres outside the
  // built area can still hand out a plot inside it. Skipping such a street would
  // remove a plot the master plan had resolved against, and a building somewhere
  // else would take its ground — the additive-growth invariant broken, silently,
  // in one town in a hundred.
  const cutoff = reach;
  const streetCutoff = reach + 30;

  for (let si = 0; si < streets.length; si++) {
    const street = streets[si];
    if (!street.frontage || street.points.length < 2) continue;
    const points = street.points;
    const arc = street.arc;
    if (arc[arc.length - 1] < 6) continue;

    let anchor = 0;
    let nearest = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = points[i].a * points[i].a + points[i].b * points[i].b;
      if (d < nearest) {
        nearest = d;
        anchor = i;
      }
    }
    if (Math.sqrt(nearest) > streetCutoff) continue;
    const anchorArc = arc[anchor];

    for (const side of [-1, 1]) {
      for (const dir of [1, -1]) {
        let s = anchorArc + dir * 0.5;
        let slot = 0;
        // A street can leave the built area and come back — a ring road cutting
        // a corner, a lane that loops. Three empty plots in a row is the point
        // at which it is not coming back.
        let missed = 0;
        for (let guard = 0; guard < 200; guard++) {
          const seed = mixSeed(
            baseSeed,
            si * 6151 + (side > 0 ? 3079 : 0) + (dir > 0 ? 1543 : 0) + slot * 97,
          );
          prng.reseed(seed);
          slot++;

          if (!along(points, arc, s, cursor)) break;
          // Working buildings want the edge of town, dwellings the middle — and
          // the test is against the town's *ultimate* size, so a mill built at
          // the edge of a village is still a mill when the city has grown past
          // it, which is what happens to real mills.
          const outward = Math.hypot(cursor.a, cursor.b) / full;
          const worksP = 0.09 + 0.42 * smoothstep(0.28, 0.8, outward);
          const name =
            prng.next() < worksP
              ? pickWeighted(style.works, prng.next())
              : pickWeighted(style.houses, prng.next());
          const model = models[name];
          const scale = prng.range(0.9, 1.12);
          const width = model.width * scale;
          const depth = model.depth * scale;

          // Sit the building on the middle of its own run of frontage.
          const mid = s + dir * width * 0.5;
          if (!along(points, arc, mid, cursor)) break;
          const na = -cursor.tb * side;
          const nb = cursor.ta * side;
          const setback = street.width * 0.5 + prng.range(0.4, 1.5) + depth * 0.5;
          const a = cursor.a + na * setback;
          const b = cursor.b + nb * setback;
          const dist = Math.hypot(a, b);

          // Drawn whether or not this plot is kept. Everything a slot takes off
          // its own generator has to be taken unconditionally, because the walk
          // advances from the same generator: skipping two draws here shifts
          // every building further along the street, and the town silently
          // stops being the same town it was one tier ago.
          const u = prng.next();
          const fringe = prng.next();

          if (dist < cutoff) {
            missed = 0;
            plots.push({
              a,
              b,
              fa: -na,
              fb: -nb,
              name,
              scale,
              width,
              depth,
              dist,
              street: si,
              arc: mid,
              la: -cursor.tb,
              lb: cursor.ta,
              u,
              fringe,
              seed,
            });
          } else if (++missed >= 3) {
            break;
          }

          // A party wall, and now and then a yard or an alley. Without the
          // second term a long street reads as one extruded building with lines
          // on it.
          s = mid + dir * (width * 0.5 + NEIGHBOUR_GAP);
          s += dir * (prng.chance(0.18) ? prng.range(2.5, 9) : prng.range(0.1, 1.3));
        }
      }
    }
  }

  return plots;
}


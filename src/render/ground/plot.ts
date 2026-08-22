/**
 * Footprints: the two-dimensional half of town planning.
 *
 * Everything here works in the town's local tangent frame, in metres, and knows
 * nothing about the sphere or the terrain. That separation is deliberate — plot
 * allocation and collision are the parts that run over the *whole* street
 * network, hundreds of candidates at a time, and they have to be cheap enough
 * that the expensive half (three terrain samples per building) only ever runs
 * for buildings that are actually going to be built.
 *
 * A building is a rectangle, not a circle. The planner used to test a circle at
 * 78% of `max(width, depth) / 2`, which is a reasonable approximation for a hut
 * and a very poor one for anything else: a warehouse is 13.5 x 21 and a terrace
 * 13.6 x 8, so the circle is far larger than the building across one axis and
 * far smaller along the other. Both failure modes are visible at once in a
 * dense quarter — buildings that are genuinely clear get rejected, leaving
 * gaps, and buildings that genuinely overlap get accepted, so walls pass
 * through walls. Separating-axis on two rotated rectangles is fifteen lines and
 * is simply correct, which lets the margins come *down*: real streets are
 * tight, and what made the old towns look bad was overlap, not density.
 */

/** A 2D point in a town's local frame, in metres from its centre. */
export interface Local {
  a: number;
  b: number;
}

/**
 * A building's footprint on the ground.
 *
 * `fa, fb` is the unit vector the building faces along — which, for a building
 * on a street, points back across the carriageway. Depth runs along it and
 * width across it, matching how the models are authored and how the planner
 * sets buildings back from the kerb.
 */
export interface Footprint {
  a: number;
  b: number;
  /** Half the model's width, across the facing axis. */
  ha: number;
  /** Half the model's depth, along the facing axis. */
  hb: number;
  fa: number;
  fb: number;
  /** Bounding circle, for the broad phase. */
  br: number;
}

export function footprint(
  a: number,
  b: number,
  width: number,
  depth: number,
  fa: number,
  fb: number,
): Footprint {
  const ha = width * 0.5;
  const hb = depth * 0.5;
  return { a, b, ha, hb, fa, fb, br: Math.hypot(ha, hb) };
}

/** How far a footprint reaches along an axis, from its own centre. */
function extent(f: Footprint, ax: number, ay: number): number {
  // The facing axis carries the depth; its perpendicular carries the width.
  return (
    Math.abs(f.hb * (f.fa * ax + f.fb * ay)) + Math.abs(f.ha * (-f.fb * ax + f.fa * ay))
  );
}

/**
 * Do two footprints overlap, allowing for a gap between them?
 *
 * Separating-axis: two convex shapes are disjoint if and only if some axis
 * exists on which their projections do not meet, and for rectangles only the
 * four edge normals need testing. The `gap` widens both, so a positive value
 * asks for clear ground between neighbours rather than merely for walls that do
 * not intersect — which is the difference between a terrace of houses and one
 * long smeared building.
 */
export function overlaps(p: Footprint, q: Footprint, gap: number): boolean {
  const dx = q.a - p.a;
  const dy = q.b - p.b;
  const reach = p.br + q.br + gap;
  if (dx * dx + dy * dy > reach * reach) return false;

  const axes = [p.fa, p.fb, -p.fb, p.fa, q.fa, q.fb, -q.fb, q.fa];
  for (let i = 0; i < 8; i += 2) {
    const ax = axes[i];
    const ay = axes[i + 1];
    const dist = Math.abs(dx * ax + dy * ay);
    if (dist >= extent(p, ax, ay) + extent(q, ax, ay) + gap) return false;
  }
  return true;
}

/**
 * A uniform grid over the built area, so collision does not go quadratic.
 *
 * A metropolis allocates something like eight hundred plots and every one is
 * tested against everything already standing. At the cell size used here — a
 * little wider than the largest building — that is a handful of comparisons
 * each instead of four hundred.
 */
export class Occupancy {
  private cells = new Map<number, Footprint[]>();
  private readonly inv: number;
  private widest: number;

  constructor(cellSize = 24) {
    this.inv = 1 / cellSize;
    this.widest = cellSize;
  }

  private key(ia: number, ib: number): number {
    // Both indices fit comfortably in 16 bits for any town-sized area.
    return ((ia + 2048) << 12) | (ib + 2048);
  }

  /** Is this footprint clear of everything already placed? */
  free(f: Footprint, gap: number): boolean {
    // Buckets hold whole footprints by their centre, so the search has to reach
    // out by the largest thing stored as well as by the thing being tested. A
    // cathedral is wider than a cell, and using the cell size here instead —
    // which is nearly always enough — is the kind of nearly that produces one
    // house inside a cathedral in one town in fifty.
    const reach = f.br + gap + this.widest;
    const a0 = Math.floor((f.a - reach) * this.inv);
    const a1 = Math.floor((f.a + reach) * this.inv);
    const b0 = Math.floor((f.b - reach) * this.inv);
    const b1 = Math.floor((f.b + reach) * this.inv);
    for (let ia = a0; ia <= a1; ia++) {
      for (let ib = b0; ib <= b1; ib++) {
        const bucket = this.cells.get(this.key(ia, ib));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          if (overlaps(f, bucket[i], gap)) return false;
        }
      }
    }
    return true;
  }

  add(f: Footprint): void {
    if (f.br > this.widest) this.widest = f.br;
    const ia = Math.floor(f.a * this.inv);
    const ib = Math.floor(f.b * this.inv);
    const k = this.key(ia, ib);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(f);
    else this.cells.set(k, [f]);
  }
}

/** Length of a polyline, and the cumulative arc length at each point. */
export function arcLengths(points: Local[]): number[] {
  const out = new Array<number>(points.length);
  out[0] = 0;
  for (let i = 1; i < points.length; i++) {
    out[i] = out[i - 1] + Math.hypot(points[i].a - points[i - 1].a, points[i].b - points[i - 1].b);
  }
  return out;
}

/**
 * The point and unit tangent at a given arc length along a polyline.
 *
 * Returns false past either end, which is what stops a frontage walk from
 * running off the end of its street.
 */
export function along(
  points: Local[],
  lengths: number[],
  s: number,
  out: { a: number; b: number; ta: number; tb: number },
): boolean {
  const total = lengths[lengths.length - 1];
  if (s < 0 || s > total) return false;
  let lo = 0;
  let hi = lengths.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = lengths[hi] - lengths[lo] || 1;
  const t = (s - lengths[lo]) / span;
  const p = points[lo];
  const q = points[hi];
  out.a = p.a + (q.a - p.a) * t;
  out.b = p.b + (q.b - p.b) * t;
  const dx = q.a - p.a;
  const dy = q.b - p.b;
  const len = Math.hypot(dx, dy) || 1;
  out.ta = dx / len;
  out.tb = dy / len;
  return true;
}

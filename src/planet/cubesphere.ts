/**
 * Cube-sphere addressing.
 *
 * The planet is six quadtrees, one per cube face, each projected onto the
 * sphere. This is what lets terrain be continuous smooth geometry rather than
 * a visible tiling — there are no cells and no seams in the shading, only a
 * subdivision scheme the player never sees.
 */

export interface CubeFace {
  /** Outward face normal. */
  readonly n: readonly [number, number, number];
  /** Face-local +u axis. */
  readonly r: readonly [number, number, number];
  /** Face-local +v axis. Chosen so that cross(r, v) === n, giving outward winding. */
  readonly u: readonly [number, number, number];
}

export const FACES: readonly CubeFace[] = [
  { n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1] }, // +X
  { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] }, // -X
  { n: [0, 1, 0], r: [0, 0, 1], u: [1, 0, 0] }, // +Y
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] }, // -Y
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] }, // +Z
  { n: [0, 0, -1], r: [0, 1, 0], u: [1, 0, 0] }, // -Z
];

/**
 * Map a point on the cube face to the unit sphere.
 *
 * Uses the "spherified cube" mapping rather than a plain normalise. Plain
 * normalisation bunches vertices badly towards the face centres; this
 * distributes them almost evenly, which matters a great deal once we are
 * relying on uniform vertex spacing for LOD band-limiting.
 */
export function spherify(
  x: number,
  y: number,
  z: number,
  out: Float64Array | number[],
  offset = 0,
): void {
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  out[offset] = x * Math.sqrt(1 - y2 * 0.5 - z2 * 0.5 + (y2 * z2) / 3);
  out[offset + 1] = y * Math.sqrt(1 - z2 * 0.5 - x2 * 0.5 + (z2 * x2) / 3);
  out[offset + 2] = z * Math.sqrt(1 - x2 * 0.5 - y2 * 0.5 + (x2 * y2) / 3);
}

/** Face-local (u, v) in [-1, 1] to a point on the unit sphere. */
export function faceUvToUnit(
  faceIndex: number,
  u: number,
  v: number,
  out: Float64Array | number[],
  offset = 0,
): void {
  const f = FACES[faceIndex];
  spherify(
    f.n[0] + f.r[0] * u + f.u[0] * v,
    f.n[1] + f.r[1] * u + f.u[1] * v,
    f.n[2] + f.r[2] * u + f.u[2] * v,
    out,
    offset,
  );
}

/** Which cube face a direction belongs to, and where on it. */
export function unitToFaceUv(
  x: number,
  y: number,
  z: number,
): { face: number; u: number; v: number } {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;

  const f = FACES[face];
  // Project onto the cube plane, then read off the face-local coordinates.
  const denom = x * f.n[0] + y * f.n[1] + z * f.n[2];
  const px = x / denom;
  const py = y / denom;
  const pz = z / denom;
  return {
    face,
    u: px * f.r[0] + py * f.r[1] + pz * f.r[2],
    v: px * f.u[0] + py * f.u[1] + pz * f.u[2],
  };
}

/** Longitude/latitude in radians from a unit direction. Y is the polar axis. */
export function unitToLonLat(x: number, y: number, z: number): { lon: number; lat: number } {
  return { lon: Math.atan2(z, x), lat: Math.asin(Math.max(-1, Math.min(1, y))) };
}

/** Unit direction from longitude/latitude in radians. */
export function lonLatToUnit(lon: number, lat: number, out: Float64Array | number[], offset = 0): void {
  const c = Math.cos(lat);
  out[offset] = c * Math.cos(lon);
  out[offset + 1] = Math.sin(lat);
  out[offset + 2] = c * Math.sin(lon);
}

/** Build an orthonormal tangent basis around a unit direction. */
export function tangentBasis(
  nx: number,
  ny: number,
  nz: number,
  out: Float64Array | number[],
): void {
  // Pick the world axis least aligned with the normal to avoid a degenerate cross product.
  let ax = 0, ay = 0, az = 0;
  const absX = Math.abs(nx);
  const absY = Math.abs(ny);
  const absZ = Math.abs(nz);
  if (absX <= absY && absX <= absZ) ax = 1;
  else if (absY <= absZ) ay = 1;
  else az = 1;

  // t = normalize(cross(a, n))
  let tx = ay * nz - az * ny;
  let ty = az * nx - ax * nz;
  let tz = ax * ny - ay * nx;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;

  // b = cross(n, t)
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;

  out[0] = tx; out[1] = ty; out[2] = tz;
  out[3] = bx; out[4] = by; out[5] = bz;
}

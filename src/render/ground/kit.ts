/**
 * The parts kit: procedural building geometry, built once at start-up.
 *
 * Every structure in the world is assembled here from boxes, prisms, cones and
 * roofs, in metres, at its nominal size — a house is built 6 m wide because it
 * *is* six metres wide, not because it is one unit wide and scaled later. That
 * matters more than it sounds: an eave overhangs by 30 cm and a windowsill is
 * 90 cm off the floor, and those numbers only stay right if the model is
 * authored at the size it will be seen at. Per-instance scale then only ever
 * varies a model by a fraction, which is variety rather than distortion.
 *
 * Winding is never specified by hand. Every face is emitted with a reference
 * point inside the solid, and the builder flips the triangle and its normal if
 * the face came out facing inwards. Roughly half of all hand-authored geometry
 * bugs are a quad wound the wrong way; this makes them unrepresentable.
 *
 * Ambient occlusion is baked per vertex at the end of the build, from height
 * above the model's base and from how far the normal points downwards. It costs
 * one float per vertex and it is the single thing that stops a town of untextured
 * boxes reading as a pile of untextured boxes: buildings gain a contact shadow
 * where they meet the ground, and eaves darken the wall beneath them.
 */

import * as THREE from 'three';

export const PART_WALL = 0;
export const PART_ROOF = 1;
export const PART_TRIM = 2;
export const PART_WINDOW = 3;
export const PART_BANNER = 4;

export type Vec3 = readonly [number, number, number];

/** One finished archetype: geometry, plus what the planner needs to place it. */
export interface Model {
  geometry: THREE.BufferGeometry;
  /** Footprint in metres, for collision and setback. */
  width: number;
  depth: number;
  height: number;
  triangles: number;
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): Vec3 {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export class MeshBuilder {
  private position: number[] = [];
  private normal: number[] = [];
  private part: number[] = [];
  private shade: number[] = [];
  private index: number[] = [];

  /** Interior reference point. Faces are oriented away from it. */
  private refX = 0;
  private refY = 0;
  private refZ = 0;

  /** Move the interior reference. Set it inside whatever part is being built. */
  ref(x: number, y: number, z: number): void {
    this.refX = x;
    this.refY = y;
    this.refZ = z;
  }

  private push(p: Vec3, n: Vec3, part: number, shade: number): number {
    const i = this.position.length / 3;
    this.position.push(p[0], p[1], p[2]);
    this.normal.push(n[0], n[1], n[2]);
    this.part.push(part);
    this.shade.push(shade);
    return i;
  }

  /**
   * A planar quad, corners in order around the perimeter. Winding is corrected
   * against the interior reference point, so the caller only has to get the
   * *cycle* right, not its direction.
   */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, part: number, shade = 1): void {
    let n = cross(b[0] - a[0], b[1] - a[1], b[2] - a[2], d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) return;
    n = [n[0] / len, n[1] / len, n[2] / len];

    const cx = (a[0] + b[0] + c[0] + d[0]) * 0.25 - this.refX;
    const cy = (a[1] + b[1] + c[1] + d[1]) * 0.25 - this.refY;
    const cz = (a[2] + b[2] + c[2] + d[2]) * 0.25 - this.refZ;
    const flip = n[0] * cx + n[1] * cy + n[2] * cz < 0;
    if (flip) n = [-n[0], -n[1], -n[2]];

    const i0 = this.push(a, n, part, shade);
    const i1 = this.push(b, n, part, shade);
    const i2 = this.push(c, n, part, shade);
    const i3 = this.push(d, n, part, shade);
    if (flip) {
      this.index.push(i0, i3, i2, i0, i2, i1);
    } else {
      this.index.push(i0, i1, i2, i0, i2, i3);
    }
  }

  tri(a: Vec3, b: Vec3, c: Vec3, part: number, shade = 1): void {
    let n = cross(b[0] - a[0], b[1] - a[1], b[2] - a[2], c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) return;
    n = [n[0] / len, n[1] / len, n[2] / len];

    const cx = (a[0] + b[0] + c[0]) / 3 - this.refX;
    const cy = (a[1] + b[1] + c[1]) / 3 - this.refY;
    const cz = (a[2] + b[2] + c[2]) / 3 - this.refZ;
    const flip = n[0] * cx + n[1] * cy + n[2] * cz < 0;
    if (flip) n = [-n[0], -n[1], -n[2]];

    const i0 = this.push(a, n, part, shade);
    const i1 = this.push(b, n, part, shade);
    const i2 = this.push(c, n, part, shade);
    if (flip) this.index.push(i0, i2, i1);
    else this.index.push(i0, i1, i2);
  }

  /** An axis-aligned box. `y` is the base, not the centre. */
  box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    part: number,
    opts: { top?: boolean; bottom?: boolean; shade?: number } = {},
  ): void {
    const { top = true, bottom = false, shade = 1 } = opts;
    const x0 = x - w / 2, x1 = x + w / 2;
    const z0 = z - d / 2, z1 = z + d / 2;
    const y0 = y, y1 = y + h;
    const prevRef: Vec3 = [this.refX, this.refY, this.refZ];
    this.ref(x, y + h / 2, z);

    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part, shade);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], part, shade);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], part, shade);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part, shade);
    if (top) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], part, shade);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], part, shade);

    this.ref(prevRef[0], prevRef[1], prevRef[2]);
  }

  /**
   * A box rotated about its own centre, around the z axis.
   *
   * Only one axis, because only one thing needs it: a windmill's sails, and the
   * diagonal braces that read as timber framing. A general transform stack
   * would be the wrong trade for two callers.
   */
  boxRotZ(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    angle: number,
    part: number,
    shade = 1,
  ): void {
    const c = Math.cos(angle), s = Math.sin(angle);
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const at = (u: number, v: number, k: number): Vec3 => [
      x + u * hw * c - v * hh * s,
      y + u * hw * s + v * hh * c,
      z + k * hd,
    ];
    const prevRef: Vec3 = [this.refX, this.refY, this.refZ];
    this.ref(x, y, z);
    const p000 = at(-1, -1, -1), p100 = at(1, -1, -1), p110 = at(1, 1, -1), p010 = at(-1, 1, -1);
    const p001 = at(-1, -1, 1), p101 = at(1, -1, 1), p111 = at(1, 1, 1), p011 = at(-1, 1, 1);
    this.quad(p001, p101, p111, p011, part, shade);
    this.quad(p100, p000, p010, p110, part, shade);
    this.quad(p101, p100, p110, p111, part, shade);
    this.quad(p000, p001, p011, p010, part, shade);
    this.quad(p011, p111, p110, p010, part, shade);
    this.quad(p000, p100, p101, p001, part, shade);
    this.ref(prevRef[0], prevRef[1], prevRef[2]);
  }

  /**
   * A regular n-gon prism. `taper` is the top radius as a fraction of the
   * bottom, which is what turns a chimney into a windmill.
   */
  prism(
    sides: number,
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    part: number,
    opts: { taper?: number; phase?: number; top?: boolean; shade?: number } = {},
  ): void {
    const { taper = 1, phase = 0, top = true, shade = 1 } = opts;
    const prevRef: Vec3 = [this.refX, this.refY, this.refZ];
    this.ref(x, y + height / 2, z);

    const rTop = radius * taper;
    for (let i = 0; i < sides; i++) {
      const a0 = phase + (i / sides) * Math.PI * 2;
      const a1 = phase + ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.quad(
        [x + c0 * radius, y, z + s0 * radius],
        [x + c1 * radius, y, z + s1 * radius],
        [x + c1 * rTop, y + height, z + s1 * rTop],
        [x + c0 * rTop, y + height, z + s0 * rTop],
        part,
        shade,
      );
    }
    if (top && rTop > 1e-4) {
      for (let i = 1; i < sides - 1; i++) {
        const a0 = phase;
        const a1 = phase + (i / sides) * Math.PI * 2;
        const a2 = phase + ((i + 1) / sides) * Math.PI * 2;
        this.tri(
          [x + Math.cos(a0) * rTop, y + height, z + Math.sin(a0) * rTop],
          [x + Math.cos(a1) * rTop, y + height, z + Math.sin(a1) * rTop],
          [x + Math.cos(a2) * rTop, y + height, z + Math.sin(a2) * rTop],
          part,
          shade,
        );
      }
    }
    this.ref(prevRef[0], prevRef[1], prevRef[2]);
  }

  /** A cone, with a closed underside so an overhanging eave is not see-through. */
  cone(
    sides: number,
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    part: number,
    opts: { phase?: number; shade?: number } = {},
  ): void {
    const { phase = 0, shade = 1 } = opts;
    const prevRef: Vec3 = [this.refX, this.refY, this.refZ];
    this.ref(x, y + height * 0.3, z);
    for (let i = 0; i < sides; i++) {
      const a0 = phase + (i / sides) * Math.PI * 2;
      const a1 = phase + ((i + 1) / sides) * Math.PI * 2;
      this.tri(
        [x + Math.cos(a0) * radius, y, z + Math.sin(a0) * radius],
        [x + Math.cos(a1) * radius, y, z + Math.sin(a1) * radius],
        [x, y + height, z],
        part,
        shade,
      );
    }
    for (let i = 1; i < sides - 1; i++) {
      const a0 = phase;
      const a1 = phase + (i / sides) * Math.PI * 2;
      const a2 = phase + ((i + 1) / sides) * Math.PI * 2;
      this.tri(
        [x + Math.cos(a0) * radius, y, z + Math.sin(a0) * radius],
        [x + Math.cos(a1) * radius, y, z + Math.sin(a1) * radius],
        [x + Math.cos(a2) * radius, y, z + Math.sin(a2) * radius],
        part,
        shade * 0.55,
      );
    }
    this.ref(prevRef[0], prevRef[1], prevRef[2]);
  }

  /**
   * A gable roof: a solid triangular prism, ridge running along z.
   *
   * The eave sits `fascia` *below* the wall top rather than flush with it, so
   * the roof has a visible edge thickness where it overhangs. Without that the
   * roof is a knife edge, and a knife edge is the tell that a building was made
   * of two boxes.
   */
  gable(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    part: number,
    opts: { overhang?: number; fascia?: number; shade?: number; ridgeAlongX?: boolean } = {},
  ): void {
    const { overhang = 0.35, fascia = 0.18, shade = 1, ridgeAlongX = false } = opts;
    const prevRef: Vec3 = [this.refX, this.refY, this.refZ];
    this.ref(x, y + h * 0.35, z);

    const ex = w / 2 + overhang;
    const ez = d / 2 + overhang;
    const yb = y - fascia;
    const yt = y + h;

    if (!ridgeAlongX) {
      // Ridge along z: sloped faces look ±x, gable triangles look ±z.
      const A: Vec3 = [x - ex, yb, z - ez];
      const B: Vec3 = [x - ex, yb, z + ez];
      const C: Vec3 = [x + ex, yb, z + ez];
      const D: Vec3 = [x + ex, yb, z - ez];
      const R0: Vec3 = [x, yt, z - ez];
      const R1: Vec3 = [x, yt, z + ez];
      this.quad(A, B, R1, R0, part, shade);
      this.quad(C, D, R0, R1, part, shade);
      this.tri(A, R0, D, part, shade * 0.94);
      this.tri(B, C, R1, part, shade * 0.94);
      this.quad(A, D, C, B, part, shade * 0.5);
    } else {
      const A: Vec3 = [x - ex, yb, z - ez];
      const B: Vec3 = [x + ex, yb, z - ez];
      const C: Vec3 = [x + ex, yb, z + ez];
      const D: Vec3 = [x - ex, yb, z + ez];
      const R0: Vec3 = [x - ex, yt, z];
      const R1: Vec3 = [x + ex, yt, z];
      this.quad(A, B, R1, R0, part, shade);
      this.quad(C, D, R0, R1, part, shade);
      this.tri(A, R0, D, part, shade * 0.94);
      this.tri(B, C, R1, part, shade * 0.94);
      this.quad(A, D, C, B, part, shade * 0.5);
    }
    this.ref(prevRef[0], prevRef[1], prevRef[2]);
  }

  /** A four-sided hipped roof: no gable ends, so it reads as stone rather than timber. */
  hip(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    part: number,
    opts: { overhang?: number; fascia?: number; ridge?: number; shade?: number } = {},
  ): void {
    const { overhang = 0.3, fascia = 0.16, ridge = 0.35, shade = 1 } = opts;
    const prevRef: Vec3 = [this.refX, this.refY, this.refZ];
    this.ref(x, y + h * 0.35, z);

    const ex = w / 2 + overhang;
    const ez = d / 2 + overhang;
    const rz = (d / 2) * ridge;
    const yb = y - fascia;
    const yt = y + h;

    const A: Vec3 = [x - ex, yb, z - ez];
    const B: Vec3 = [x + ex, yb, z - ez];
    const C: Vec3 = [x + ex, yb, z + ez];
    const D: Vec3 = [x - ex, yb, z + ez];
    const R0: Vec3 = [x, yt, z - rz];
    const R1: Vec3 = [x, yt, z + rz];

    this.quad(A, R0, R1, D, part, shade);
    this.quad(B, C, R1, R0, part, shade);
    this.tri(A, B, R0, part, shade * 0.92);
    this.tri(C, D, R1, part, shade * 0.92);
    this.quad(A, D, C, B, part, shade * 0.5);

    this.ref(prevRef[0], prevRef[1], prevRef[2]);
  }

  /**
   * A row of windows on one wall face, inset outward by a hair so they never
   * z-fight the wall they sit on.
   */
  windowRow(
    face: 'x+' | 'x-' | 'z+' | 'z-',
    x: number,
    z: number,
    wallHalf: number,
    y: number,
    count: number,
    span: number,
    ww: number,
    wh: number,
    part = PART_WINDOW,
  ): void {
    if (count <= 0) return;
    const eps = 0.02;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i / (count - 1) - 0.5) * span;
      let a: Vec3, b: Vec3, c: Vec3, d: Vec3;
      if (face === 'z+') {
        const zz = z + wallHalf + eps;
        a = [x + t - ww / 2, y, zz]; b = [x + t + ww / 2, y, zz];
        c = [x + t + ww / 2, y + wh, zz]; d = [x + t - ww / 2, y + wh, zz];
      } else if (face === 'z-') {
        const zz = z - wallHalf - eps;
        a = [x + t + ww / 2, y, zz]; b = [x + t - ww / 2, y, zz];
        c = [x + t - ww / 2, y + wh, zz]; d = [x + t + ww / 2, y + wh, zz];
      } else if (face === 'x+') {
        const xx = x + wallHalf + eps;
        a = [xx, y, z + t + ww / 2]; b = [xx, y, z + t - ww / 2];
        c = [xx, y + wh, z + t - ww / 2]; d = [xx, y + wh, z + t + ww / 2];
      } else {
        const xx = x - wallHalf - eps;
        a = [xx, y, z + t - ww / 2]; b = [xx, y, z + t + ww / 2];
        c = [xx, y + wh, z + t + ww / 2]; d = [xx, y + wh, z + t - ww / 2];
      }
      const prevRef: Vec3 = [this.refX, this.refY, this.refZ];
      this.ref(x, y + wh / 2, z);
      this.quad(a, b, c, d, part);
      this.ref(prevRef[0], prevRef[1], prevRef[2]);
    }
  }

  get triangleCount(): number {
    return this.index.length / 3;
  }

  /**
   * Bake ambient occlusion and hand back a geometry.
   *
   * Two terms, both cheap and both doing real work. Height above the base
   * darkens the bottom of every wall, which is the contact shadow that stops a
   * building looking pasted onto the ground. Downward-facing normals darken,
   * which shades the underside of every eave and overhang without anything
   * having to know an eave is what it is.
   */
  finish(): { geometry: THREE.BufferGeometry; height: number; triangles: number } {
    const count = this.position.length / 3;
    let maxY = 0;
    for (let i = 0; i < count; i++) maxY = Math.max(maxY, this.position[i * 3 + 1]);
    const contact = Math.max(0.7, maxY * 0.45);

    const ao = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const y = this.position[i * 3 + 1];
      const ny = this.normal[i * 3 + 1];
      let t = Math.min(1, Math.max(0, y / contact));
      t = t * t * (3 - 2 * t);
      let a = 0.42 + 0.58 * t;
      if (ny < -0.2) a *= 0.58 + 0.42 * (1 + ny);
      ao[i] = Math.min(1.15, a * this.shade[i]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    geometry.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
    geometry.setIndex(this.index);
    return { geometry, height: maxY, triangles: this.index.length / 3 };
  }
}

/**
 * The building catalogue.
 *
 * Twenty-eight structures, four eras, built from the kit in kit.ts and nothing
 * else — no meshes ship with this game. Each one is authored at real size and
 * exists in exactly one variant; variety comes from the town planner choosing
 * among them, from per-instance scale and rotation, and from the culture's
 * palette, which together give a town of forty houses forty different-looking
 * houses out of four models.
 *
 * The rule for what earns detail: silhouette first, then the things that catch
 * a low sun. A chimney, a spire, a windmill's sails and a crenellated parapet
 * are worth their triangles because they change the shape against the sky. A
 * doorknob is not.
 */

import {
  MeshBuilder,
  PART_BANNER,
  PART_ROOF,
  PART_TRIM,
  PART_WALL,
  PART_WINDOW,
} from './kit';
import type { Model } from './kit';

export type ArchetypeName =
  // Primitive
  | 'hut'
  | 'longhut'
  | 'granary'
  | 'greathall'
  | 'stonecircle'
  // Ancient
  | 'mudhouse'
  | 'courtyard'
  | 'temple'
  | 'ziggurat'
  | 'obelisk'
  // Medieval
  | 'cottage'
  | 'timberhouse'
  | 'shophouse'
  | 'workshop'
  | 'windmill'
  | 'watchtower'
  | 'keep'
  | 'cathedral'
  // Industrial
  | 'terrace'
  | 'tenement'
  | 'warehouse'
  | 'factory'
  | 'clocktower'
  | 'station'
  // Any era
  | 'lighthouse'
  | 'colossus'
  | 'well'
  | 'stall'
  | 'ruin';

type Builder = (b: MeshBuilder) => { width: number; depth: number };

/** A ring of crenellations around a rectangular parapet. */
function crenellate(
  b: MeshBuilder,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: number,
  step: number,
  part: number,
): void {
  const nx = Math.max(2, Math.round(w / step));
  const nz = Math.max(2, Math.round(d / step));
  const sx = w / nx;
  const sz = d / nz;
  for (let i = 0; i < nx; i++) {
    if (i % 2 === 1) continue;
    const px = x - w / 2 + sx * (i + 0.5);
    b.box(px, y, z - d / 2 + 0.25, sx * 0.9, h, 0.5, part);
    b.box(px, y, z + d / 2 - 0.25, sx * 0.9, h, 0.5, part);
  }
  for (let i = 0; i < nz; i++) {
    if (i % 2 === 1) continue;
    const pz = z - d / 2 + sz * (i + 0.5);
    b.box(x - w / 2 + 0.25, y, pz, 0.5, h, sz * 0.9, part);
    b.box(x + w / 2 - 0.25, y, pz, 0.5, h, sz * 0.9, part);
  }
}

/** A flight of steps, climbing along +z. */
function steps(
  b: MeshBuilder,
  x: number,
  y: number,
  z: number,
  w: number,
  rise: number,
  run: number,
  count: number,
  part: number,
): void {
  for (let i = 0; i < count; i++) {
    b.box(x, y, z + run * (i + 0.5), w, rise * (count - i), run, part, { shade: 0.94 });
  }
}

const BUILDERS: Record<ArchetypeName, Builder> = {
  // --- Primitive ----------------------------------------------------------

  /** A round hut: earth walls, a deep conical thatch, a dark doorway. */
  hut: (b) => {
    b.prism(9, 0, 0, 0, 2.5, 2.0, PART_WALL, { phase: 0.2 });
    b.cone(9, 0, 1.95, 0, 3.25, 2.7, PART_ROOF, { phase: 0.2 });
    // Ridge pole poking through the thatch: two triangles, and the hut stops
    // reading as a traffic cone.
    b.prism(4, 0, 4.4, 0, 0.16, 0.7, PART_TRIM);
    b.box(0, 0, 2.45, 1.0, 1.6, 0.14, PART_TRIM);
    return { width: 6.5, depth: 6.5 };
  },

  /** A longhouse: the same construction, stretched, for a chief or a herd. */
  longhut: (b) => {
    b.box(0, 0, 0, 4.4, 1.9, 9.0, PART_WALL);
    b.gable(0, 1.9, 0, 4.4, 2.9, 9.0, PART_ROOF, { overhang: 0.6, fascia: 0.22 });
    b.box(0, 0, 4.5, 1.1, 1.7, 0.16, PART_TRIM);
    b.boxRotZ(-2.35, 2.6, -3.2, 3.4, 0.16, 0.16, 0.72, PART_TRIM);
    b.boxRotZ(2.35, 2.6, -3.2, 3.4, 0.16, 0.16, -0.72, PART_TRIM);
    return { width: 5.6, depth: 10.2 };
  },

  /** A raised granary: stilts keep the grain off wet ground and away from rats. */
  granary: (b) => {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.box(sx * 1.2, 0, sz * 1.2, 0.34, 1.5, 0.34, PART_TRIM);
      }
    }
    b.box(0, 1.5, 0, 3.4, 2.0, 3.4, PART_WALL, { bottom: true });
    b.cone(6, 0, 3.5, 0, 2.6, 1.9, PART_ROOF, { phase: 0.5 });
    return { width: 4.4, depth: 4.4 };
  },

  /** The great hall: the one building a primitive settlement builds to be seen. */
  greathall: (b) => {
    b.box(0, 0, 0, 8.0, 3.2, 17.0, PART_WALL);
    b.gable(0, 3.2, 0, 8.0, 4.6, 17.0, PART_ROOF, { overhang: 0.9, fascia: 0.3 });
    b.box(0, 0, 8.6, 2.0, 2.6, 0.2, PART_TRIM);
    // Carved posts along the eaves.
    for (let i = -3; i <= 3; i++) {
      b.box(-4.3, 0, i * 2.4, 0.36, 3.6, 0.36, PART_TRIM);
      b.box(4.3, 0, i * 2.4, 0.36, 3.6, 0.36, PART_TRIM);
    }
    b.prism(4, 0, 7.7, -8.7, 0.3, 2.2, PART_TRIM);
    b.box(0, 8.4, -8.7, 0.1, 1.4, 1.9, PART_BANNER);
    return { width: 10.4, depth: 18.5 };
  },

  /** Standing stones. The oldest thing a planet keeps. */
  stonecircle: (b) => {
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 7.5;
      const h = 3.4 + ((i * 37) % 11) * 0.16;
      b.prism(5, Math.cos(a) * r, 0, Math.sin(a) * r, 0.75, h, PART_TRIM, { phase: a });
      if (i % 3 === 0) {
        b.box(Math.cos(a) * r, h, Math.sin(a) * r, 2.0, 0.5, 1.2, PART_TRIM);
      }
    }
    b.prism(6, 0, 0, 0, 1.4, 0.5, PART_TRIM);
    return { width: 17, depth: 17 };
  },

  // --- Ancient ------------------------------------------------------------

  /** Flat-roofed mudbrick, a parapet, an outside stair to the roof. */
  mudhouse: (b) => {
    b.box(0, 0, 0, 6.2, 3.3, 6.6, PART_WALL);
    b.box(0, 3.3, 0, 6.4, 0.55, 6.8, PART_TRIM);
    b.windowRow('z+', 0, 0, 3.3, 1.6, 2, 3.0, 0.7, 1.0);
    b.windowRow('x+', 0, 0, 3.1, 1.6, 2, 3.2, 0.7, 1.0);
    b.box(0, 0, 3.3, 1.1, 2.1, 0.14, PART_TRIM);
    steps(b, 3.6, 0, -3.0, 1.2, 0.55, 0.6, 6, PART_TRIM);
    return { width: 7.4, depth: 7.6 };
  },

  /** A courtyard house: two wings and a wall, which is how a hot city is built. */
  courtyard: (b) => {
    b.box(-3.0, 0, 0, 4.4, 3.4, 10.0, PART_WALL);
    b.box(0, 0, -4.0, 6.0, 3.4, 4.0, PART_WALL);
    b.box(-3.0, 3.4, 0, 4.6, 0.5, 10.2, PART_TRIM);
    b.box(0, 3.4, -4.0, 6.2, 0.5, 4.2, PART_TRIM);
    // The wall that closes the yard, lower than the house.
    b.box(2.4, 0, 2.4, 0.4, 2.3, 5.2, PART_WALL, { shade: 0.9 });
    b.box(0.6, 0, 4.9, 4.0, 2.3, 0.4, PART_WALL, { shade: 0.9 });
    b.windowRow('x-', -3.0, 0, 2.2, 1.8, 3, 6.0, 0.7, 1.1);
    b.prism(8, 1.6, 0, 1.4, 0.6, 0.7, PART_TRIM);
    return { width: 8.2, depth: 11.0 };
  },

  /** A peripteral temple: podium, colonnade, entablature, pediments. */
  temple: (b) => {
    const w = 10.0, d = 16.0;
    for (let i = 0; i < 3; i++) {
      const k = (3 - i) * 0.8;
      b.box(0, i * 0.5, 0, w + k, 0.5, d + k, PART_TRIM, { shade: 0.95 });
    }
    const podium = 1.5;
    b.box(0, podium, 0, w - 3.4, 5.4, d - 3.4, PART_WALL);
    const colH = 5.6;
    const cols = 7;
    for (let i = 0; i < cols; i++) {
      const z = -d / 2 + 1.1 + (i / (cols - 1)) * (d - 2.2);
      b.prism(10, -w / 2 + 1.1, podium, z, 0.46, colH, PART_TRIM);
      b.prism(10, w / 2 - 1.1, podium, z, 0.46, colH, PART_TRIM);
    }
    for (const z of [-d / 2 + 1.1, d / 2 - 1.1]) {
      for (const x of [-1.9, 0, 1.9]) b.prism(10, x, podium, z, 0.46, colH, PART_TRIM);
    }
    b.box(0, podium + colH, 0, w, 1.0, d, PART_TRIM);
    b.gable(0, podium + colH + 1.0, 0, w, 2.3, d, PART_ROOF, { overhang: 0.4, fascia: 0.2 });
    return { width: w + 2.4, depth: d + 2.4 };
  },

  /** A ziggurat: four tiers, a processional stair, a shrine at the top. */
  ziggurat: (b) => {
    let w = 30, d = 30, y = 0;
    for (let i = 0; i < 4; i++) {
      b.box(0, y, 0, w, 3.6, d, PART_WALL, { shade: 1 - i * 0.02 });
      b.box(0, y + 3.6, 0, w + 0.5, 0.4, d + 0.5, PART_TRIM);
      y += 4.0;
      w -= 6;
      d -= 6;
    }
    steps(b, 0, 0, d / 2 + 3.0, 5.0, 0.5, 1.25, 12, PART_TRIM);
    b.box(0, y, 0, 7.0, 3.4, 7.0, PART_WALL);
    b.box(0, y + 3.4, 0, 7.6, 0.5, 7.6, PART_TRIM);
    b.windowRow('z+', 0, 0, 3.5, y + 1.0, 1, 0, 1.4, 2.0);
    b.prism(4, 0, y + 3.9, 0, 0.35, 3.0, PART_TRIM);
    b.box(0, y + 5.2, 0, 0.1, 1.6, 2.2, PART_BANNER);
    return { width: 32, depth: 38 };
  },

  obelisk: (b) => {
    b.box(0, 0, 0, 3.4, 1.0, 3.4, PART_TRIM);
    b.prism(4, 0, 1.0, 0, 1.15, 13.0, PART_WALL, { taper: 0.62, phase: Math.PI / 4 });
    b.cone(4, 0, 14.0, 0, 0.72, 1.6, PART_BANNER, { phase: Math.PI / 4 });
    return { width: 4.0, depth: 4.0 };
  },

  // --- Medieval -----------------------------------------------------------

  /** A one-and-a-half storey cottage under a steep tiled roof. */
  cottage: (b) => {
    b.box(0, 0, 0, 5.4, 2.7, 6.6, PART_WALL);
    b.gable(0, 2.7, 0, 5.4, 3.0, 6.6, PART_ROOF, { overhang: 0.45, fascia: 0.2 });
    b.box(1.4, 2.7, 0, 0.9, 3.6, 0.9, PART_TRIM);
    b.windowRow('z+', 0, 0, 3.3, 1.1, 2, 2.6, 0.75, 1.0);
    b.windowRow('x-', 0, 0, 2.7, 1.1, 2, 3.0, 0.75, 1.0);
    b.box(-1.4, 0, 3.35, 1.0, 1.95, 0.12, PART_TRIM);
    return { width: 6.4, depth: 7.6 };
  },

  /** Two storeys, the upper jettied out over the street, timber framing. */
  timberhouse: (b) => {
    b.box(0, 0, 0, 5.2, 2.6, 6.2, PART_WALL, { shade: 0.94 });
    b.box(0, 2.6, 0, 5.9, 2.8, 6.9, PART_WALL);
    b.gable(0, 5.4, 0, 5.9, 3.2, 6.9, PART_ROOF, { overhang: 0.5, fascia: 0.22 });
    // Framing: corner posts, a sill beam, and two braces per gable.
    for (const x of [-2.85, 2.85]) b.box(x, 2.6, 0, 0.22, 2.8, 6.9, PART_TRIM, { shade: 0.9 });
    b.box(0, 2.5, 3.45, 5.9, 0.3, 0.26, PART_TRIM);
    b.box(0, 5.3, 3.45, 5.9, 0.28, 0.26, PART_TRIM);
    b.boxRotZ(-1.5, 4.0, 3.5, 2.6, 0.2, 0.2, 0.9, PART_TRIM);
    b.boxRotZ(1.5, 4.0, 3.5, 2.6, 0.2, 0.2, -0.9, PART_TRIM);
    b.box(1.6, 5.4, -1.0, 0.85, 3.4, 0.85, PART_TRIM);
    b.windowRow('z+', 0, 0, 3.45, 3.2, 3, 3.8, 0.68, 1.15);
    b.windowRow('z+', 0, 0, 3.1, 0.9, 2, 2.6, 0.7, 1.0);
    b.box(1.5, 0, 3.15, 1.0, 2.0, 0.12, PART_TRIM);
    return { width: 6.6, depth: 7.6 };
  },

  /** Three storeys on a narrow plot: the shape a walled city forces. */
  shophouse: (b) => {
    b.box(0, 0, 0, 4.4, 8.1, 6.0, PART_WALL);
    b.gable(0, 8.1, 0, 4.4, 2.6, 6.0, PART_ROOF, { overhang: 0.35, fascia: 0.18 });
    for (let s = 0; s < 3; s++) {
      b.box(0, 2.6 + s * 2.7 - 0.15, 0, 4.6, 0.24, 6.2, PART_TRIM, { shade: 0.9 });
      b.windowRow('z+', 0, 0, 3.0, 0.9 + s * 2.7, 2, 2.2, 0.7, 1.2);
    }
    b.box(-1.1, 8.1, 0, 0.7, 2.9, 0.7, PART_TRIM);
    b.box(0, 2.35, 3.3, 4.6, 0.5, 1.1, PART_TRIM);
    return { width: 5.2, depth: 6.8 };
  },

  /** A smith or a tannery: low, wide, and always smoking. */
  workshop: (b) => {
    b.box(0, 0, 0, 7.0, 2.9, 5.6, PART_WALL);
    b.gable(0, 2.9, 0, 7.0, 1.9, 5.6, PART_ROOF, {
      overhang: 0.7,
      fascia: 0.2,
      ridgeAlongX: true,
    });
    b.prism(6, 2.4, 2.9, 0, 0.72, 4.4, PART_TRIM, { taper: 0.8 });
    b.box(-1.0, 0, 2.85, 2.6, 2.4, 0.14, PART_WINDOW);
    b.box(0, 0, -3.2, 4.0, 0.5, 1.6, PART_TRIM);
    return { width: 8.4, depth: 7.0 };
  },

  /** A tower mill. Four sails, and the whole town knows where north is. */
  windmill: (b) => {
    b.prism(12, 0, 0, 0, 3.3, 9.0, PART_WALL, { taper: 0.66 });
    b.cone(12, 0, 9.0, 0, 2.5, 2.4, PART_ROOF);
    b.windowRow('z+', 0, 0, 2.6, 3.0, 1, 0, 0.7, 1.0);
    b.windowRow('z+', 0, 0, 2.2, 6.2, 1, 0, 0.7, 1.0);
    b.box(0, 0, 2.9, 1.1, 2.1, 0.16, PART_TRIM);
    // The stock, and four sails clear of the cap.
    b.box(0, 9.4, 2.4, 0.4, 0.4, 1.4, PART_TRIM);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.35;
      const r = 4.6;
      b.boxRotZ(Math.cos(a) * r, 9.4 + Math.sin(a) * r, 3.1, 8.6, 1.5, 0.18, a, PART_TRIM);
    }
    return { width: 8.0, depth: 8.0 };
  },

  watchtower: (b) => {
    b.box(0, 0, 0, 4.6, 10.5, 4.6, PART_WALL);
    b.box(0, 10.5, 0, 5.4, 0.7, 5.4, PART_TRIM);
    crenellate(b, 0, 11.2, 0, 5.4, 5.4, 1.1, 1.1, PART_TRIM);
    b.windowRow('z+', 0, 0, 2.3, 3.4, 1, 0, 0.5, 1.4);
    b.windowRow('z+', 0, 0, 2.3, 7.0, 1, 0, 0.5, 1.4);
    b.windowRow('x+', 0, 0, 2.3, 7.0, 1, 0, 0.5, 1.4);
    b.box(0, 12.4, 0, 0.16, 2.0, 1.4, PART_BANNER);
    return { width: 6.0, depth: 6.0 };
  },

  /** A castle: keep, curtain wall, four corner towers, a gate. */
  keep: (b) => {
    const R = 17;
    // Curtain wall, in four runs so the gate can break one of them.
    b.box(0, 0, -R, R * 2, 6.5, 2.0, PART_WALL, { shade: 0.95 });
    b.box(-R, 0, 0, 2.0, 6.5, R * 2, PART_WALL, { shade: 0.95 });
    b.box(R, 0, 0, 2.0, 6.5, R * 2, PART_WALL, { shade: 0.95 });
    for (const sx of [-1, 1]) {
      b.box(sx * (R / 2 + 2.5), 0, R, R - 5, 6.5, 2.0, PART_WALL, { shade: 0.95 });
    }
    crenellate(b, 0, 6.5, 0, R * 2 + 2, R * 2 + 2, 1.2, 1.6, PART_TRIM);
    // Gatehouse.
    b.box(0, 0, R, 9.0, 9.5, 3.4, PART_WALL);
    b.box(0, 0, R + 1.8, 3.2, 4.4, 0.2, PART_TRIM);
    crenellate(b, 0, 9.5, R, 9.6, 4.0, 1.2, 1.2, PART_TRIM);
    // Corner towers.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * R, z = sz * R;
        b.prism(10, x, 0, z, 3.4, 11.0, PART_WALL);
        b.prism(10, x, 11.0, z, 4.0, 0.8, PART_TRIM);
        b.cone(10, x, 11.8, z, 4.0, 4.6, PART_ROOF);
      }
    }
    // The keep itself.
    b.box(0, 0, -3, 13.0, 17.0, 13.0, PART_WALL);
    b.box(0, 17.0, -3, 14.2, 0.9, 14.2, PART_TRIM);
    crenellate(b, 0, 17.9, -3, 14.2, 14.2, 1.4, 1.5, PART_TRIM);
    b.windowRow('z+', 0, -3, 6.5, 5.0, 3, 8.0, 0.6, 1.6);
    b.windowRow('z+', 0, -3, 6.5, 10.5, 3, 8.0, 0.6, 1.6);
    b.windowRow('x+', 0, -3, 6.5, 10.5, 3, 8.0, 0.6, 1.6);
    b.prism(4, 5.0, 18.0, -8.0, 0.22, 4.0, PART_TRIM);
    b.box(5.0, 20.0, -8.0, 0.14, 2.0, 2.6, PART_BANNER);
    return { width: 40, depth: 40 };
  },

  /** A cathedral: nave, transept, buttresses, a spire that outlives the state. */
  cathedral: (b) => {
    const naveW = 11, naveD = 30;
    b.box(0, 0, 0, naveW, 13.0, naveD, PART_WALL);
    b.gable(0, 13.0, 0, naveW, 6.0, naveD, PART_ROOF, { overhang: 0.5, fascia: 0.25 });
    // Aisles.
    for (const sx of [-1, 1]) {
      b.box(sx * (naveW / 2 + 2.4), 0, 0, 4.8, 7.0, naveD - 4, PART_WALL, { shade: 0.96 });
      b.gable(sx * (naveW / 2 + 2.4), 7.0, 0, 4.8, 2.0, naveD - 4, PART_ROOF, { overhang: 0.4 });
    }
    // Transept.
    b.box(0, 0, -4.0, 26.0, 11.0, 9.0, PART_WALL);
    b.gable(0, 11.0, -4.0, 26.0, 4.6, 9.0, PART_ROOF, { overhang: 0.5, ridgeAlongX: true });
    // Buttresses.
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      for (const sx of [-1, 1]) {
        const x = sx * (naveW / 2 + 5.0);
        b.box(x, 0, i * 3.6, 1.4, 8.5, 1.2, PART_TRIM);
        b.prism(4, x, 8.5, i * 3.6, 0.75, 1.6, PART_TRIM, { taper: 0.3, phase: Math.PI / 4 });
      }
    }
    // Tall lancets down the nave, a rose window over the west door.
    for (const face of ['x+', 'x-'] as const) {
      b.windowRow(face, 0, 0, naveW / 2, 8.5, 7, 24, 0.9, 3.4);
    }
    b.windowRow('z+', 0, 0, naveD / 2, 8.0, 1, 0, 4.4, 4.4, PART_WINDOW);
    b.box(0, 0, naveD / 2 + 0.05, 3.0, 5.0, 0.2, PART_TRIM);
    // West tower and spire.
    b.box(-8.5, 0, naveD / 2 - 3.0, 7.0, 26.0, 7.0, PART_WALL);
    b.box(-8.5, 26.0, naveD / 2 - 3.0, 7.8, 1.0, 7.8, PART_TRIM);
    b.windowRow('z+', -8.5, naveD / 2 - 3.0, 3.5, 18.0, 2, 3.4, 0.8, 3.0);
    b.cone(8, -8.5, 27.0, naveD / 2 - 3.0, 4.4, 14.0, PART_ROOF);
    b.prism(4, -8.5, 41.0, naveD / 2 - 3.0, 0.2, 2.2, PART_BANNER);
    return { width: 30, depth: 34 };
  },

  // --- Industrial ---------------------------------------------------------

  /** A brick terrace: three units, one roof, three chimneys. */
  terrace: (b) => {
    const unit = 4.2;
    b.box(0, 0, 0, unit * 3, 6.4, 7.0, PART_WALL);
    b.gable(0, 6.4, 0, unit * 3, 2.4, 7.0, PART_ROOF, { overhang: 0.28, fascia: 0.18 });
    for (let i = -1; i <= 1; i++) {
      b.box(i * unit, 6.4, -1.2, 1.0, 3.2, 1.0, PART_TRIM);
      b.box(i * unit - 1.1, 0, 3.55, 1.0, 2.1, 0.12, PART_TRIM);
      b.windowRow('z+', i * unit + 0.9, 0, 3.5, 0.9, 1, 0, 1.2, 1.4);
      b.windowRow('z+', i * unit, 0, 3.5, 3.9, 2, 2.2, 0.85, 1.4);
      b.windowRow('z-', i * unit, 0, 3.5, 3.9, 2, 2.2, 0.85, 1.4);
    }
    b.box(0, 6.3, 0, unit * 3 + 0.4, 0.3, 7.2, PART_TRIM);
    return { width: unit * 3 + 1, depth: 8.0 };
  },

  /** Four storeys of tenement, a light well, and washing lines nobody models. */
  tenement: (b) => {
    b.box(0, 0, 0, 9.0, 12.6, 8.5, PART_WALL);
    b.box(0, 12.6, 0, 9.6, 0.6, 9.1, PART_TRIM);
    b.gable(0, 13.2, 0, 9.0, 1.8, 8.5, PART_ROOF, { overhang: 0.3, fascia: 0.16 });
    for (let s = 0; s < 4; s++) {
      const y = 0.9 + s * 3.0;
      b.windowRow('z+', 0, 0, 4.25, y, 3, 6.0, 0.9, 1.6);
      b.windowRow('z-', 0, 0, 4.25, y, 3, 6.0, 0.9, 1.6);
      b.windowRow('x+', 0, 0, 4.5, y, 2, 4.4, 0.9, 1.6);
      if (s > 0) b.box(0, y - 0.55, 0, 9.3, 0.22, 8.8, PART_TRIM, { shade: 0.88 });
    }
    b.box(0, 0, 4.3, 1.4, 2.5, 0.2, PART_TRIM);
    b.box(1.4, 13.2, -2.0, 1.1, 3.6, 1.1, PART_TRIM);
    b.box(-1.4, 13.2, -2.0, 1.1, 3.6, 1.1, PART_TRIM);
    return { width: 10, depth: 9.5 };
  },

  warehouse: (b) => {
    b.box(0, 0, 0, 12.0, 7.5, 20.0, PART_WALL);
    b.gable(0, 7.5, 0, 12.0, 2.6, 20.0, PART_ROOF, { overhang: 0.5, fascia: 0.2 });
    for (let i = -2; i <= 2; i++) {
      b.box(-6.05, 0, i * 3.6, 0.3, 7.5, 1.0, PART_TRIM, { shade: 0.9 });
      b.box(6.05, 0, i * 3.6, 0.3, 7.5, 1.0, PART_TRIM, { shade: 0.9 });
    }
    b.box(0, 0, 10.1, 4.4, 5.2, 0.2, PART_TRIM);
    b.windowRow('x+', 0, 0, 6.0, 5.4, 4, 14, 1.0, 1.4);
    b.windowRow('x-', 0, 0, 6.0, 5.4, 4, 14, 1.0, 1.4);
    // Hoist beam over the loading door.
    b.box(0, 8.6, 11.4, 0.4, 0.4, 2.8, PART_TRIM);
    return { width: 13.5, depth: 21 };
  },

  /** A mill: sawtooth glazing facing away from the sun, and a stack. */
  factory: (b) => {
    const w = 22, d = 16;
    b.box(0, 0, 0, w, 8.0, d, PART_WALL);
    // Sawtooth roof: a vertical glazed face and a shallow slope, five bays.
    const bays = 5;
    const bw = w / bays;
    for (let i = 0; i < bays; i++) {
      const x = -w / 2 + bw * (i + 0.5);
      b.box(x - bw * 0.32, 8.0, 0, bw * 0.36, 2.6, d, PART_WINDOW);
      b.quad(
        [x - bw * 0.14, 10.6, -d / 2],
        [x - bw * 0.14, 10.6, d / 2],
        [x + bw * 0.5, 8.0, d / 2],
        [x + bw * 0.5, 8.0, -d / 2],
        PART_ROOF,
      );
      b.box(x + bw * 0.09, 10.5, 0, bw * 0.1, 0.2, d + 0.2, PART_TRIM);
    }
    b.windowRow('z+', 0, 0, d / 2, 2.0, 6, 17, 1.3, 2.6);
    b.windowRow('z-', 0, 0, d / 2, 2.0, 6, 17, 1.3, 2.6);
    b.box(0, 0, d / 2 + 0.05, 5.0, 5.0, 0.2, PART_TRIM);
    b.prism(10, -w / 2 + 2.4, 0, -d / 2 + 2.4, 1.5, 26.0, PART_TRIM, { taper: 0.72 });
    b.prism(10, -w / 2 + 2.4, 26.0, -d / 2 + 2.4, 1.25, 0.9, PART_TRIM, { taper: 1.2 });
    return { width: w + 2, depth: d + 2 };
  },

  /** A clocktower, because an industrial city measures itself. */
  clocktower: (b) => {
    b.box(0, 0, 0, 8.0, 3.0, 8.0, PART_TRIM);
    b.box(0, 3.0, 0, 6.4, 22.0, 6.4, PART_WALL);
    for (let s = 0; s < 4; s++) {
      b.box(0, 6.0 + s * 4.6, 0, 6.7, 0.3, 6.7, PART_TRIM, { shade: 0.9 });
    }
    b.box(0, 25.0, 0, 7.6, 1.2, 7.6, PART_TRIM);
    for (const face of ['z+', 'z-', 'x+', 'x-'] as const) {
      b.windowRow(face, 0, 0, 3.25, 21.0, 1, 0, 3.2, 3.2);
    }
    b.box(0, 26.2, 0, 5.6, 1.6, 5.6, PART_WALL);
    crenellate(b, 0, 27.8, 0, 6.2, 6.2, 1.0, 1.2, PART_TRIM);
    b.cone(4, 0, 27.8, 0, 3.0, 6.0, PART_ROOF, { phase: Math.PI / 4 });
    b.prism(4, 0, 33.8, 0, 0.14, 2.0, PART_BANNER);
    return { width: 9, depth: 9 };
  },

  /** A train shed: an arched roof over a long platform. */
  station: (b) => {
    b.box(0, 0, 8.0, 20.0, 8.5, 8.0, PART_WALL);
    b.box(0, 8.5, 8.0, 21.0, 0.8, 8.8, PART_TRIM);
    b.windowRow('z+', 0, 8.0, 4.0, 2.0, 5, 15, 1.4, 3.0);
    b.box(0, 0, 12.1, 4.6, 5.0, 0.2, PART_TRIM);
    // The shed itself, as a coarse barrel vault.
    const segs = 7;
    for (let i = 0; i < segs; i++) {
      const a0 = Math.PI * (i / segs);
      const a1 = Math.PI * ((i + 1) / segs);
      const r = 10.5;
      const y0 = 4.0 + Math.sin(a0) * r, x0 = -Math.cos(a0) * r;
      const y1 = 4.0 + Math.sin(a1) * r, x1 = -Math.cos(a1) * r;
      b.ref(0, 6.0, -6.0);
      b.quad([x0, y0, -20.0], [x0, y0, 4.0], [x1, y1, 4.0], [x1, y1, -20.0], PART_ROOF);
      b.ref(0, 0, 0);
    }
    for (const z of [-20.0, 4.0]) {
      for (let i = 0; i <= segs; i++) {
        const a = Math.PI * (i / segs);
        b.box(-Math.cos(a) * 10.5, 4.0 + Math.sin(a) * 10.5 - 0.5, z, 0.5, 1.0, 0.5, PART_TRIM);
      }
    }
    return { width: 22, depth: 32 };
  },

  // --- Any era ------------------------------------------------------------

  /** A lighthouse. The one building whose whole point is the light. */
  lighthouse: (b) => {
    b.prism(12, 0, 0, 0, 5.0, 2.0, PART_TRIM);
    b.prism(12, 0, 2.0, 0, 3.6, 17.0, PART_WALL, { taper: 0.55 });
    b.prism(12, 0, 19.0, 0, 2.6, 0.8, PART_TRIM);
    b.prism(8, 0, 19.8, 0, 1.9, 2.8, PART_WINDOW);
    b.cone(8, 0, 22.6, 0, 2.3, 2.2, PART_ROOF);
    b.windowRow('z+', 0, 0, 2.6, 8.0, 1, 0, 0.6, 1.1);
    b.box(0, 0, 4.9, 1.1, 2.1, 0.16, PART_TRIM);
    return { width: 10, depth: 10 };
  },

  /** A colossus on a plinth: the crudest silhouette that still reads as a person. */
  colossus: (b) => {
    b.box(0, 0, 0, 7.0, 1.2, 7.0, PART_TRIM);
    b.box(0, 1.2, 0, 5.0, 3.6, 5.0, PART_WALL);
    b.box(0, 4.8, 0, 5.6, 0.5, 5.6, PART_TRIM);
    const y = 5.3;
    b.prism(6, -0.85, y, 0, 0.62, 5.4, PART_BANNER, { taper: 0.85 });
    b.prism(6, 0.85, y, 0, 0.62, 5.4, PART_BANNER, { taper: 0.85 });
    b.prism(8, 0, y + 5.4, 0, 1.75, 5.6, PART_BANNER, { taper: 0.72 });
    b.prism(8, 0, y + 11.0, 0, 0.85, 0.7, PART_BANNER);
    b.prism(8, 0, y + 11.7, 0, 1.15, 1.9, PART_BANNER, { taper: 0.9 });
    b.boxRotZ(-2.3, y + 8.4, 0, 5.0, 0.75, 0.75, 1.15, PART_BANNER);
    b.boxRotZ(2.1, y + 7.6, 0, 4.6, 0.75, 0.75, -0.5, PART_BANNER);
    b.prism(6, 3.9, y + 9.6, 0, 0.3, 3.4, PART_TRIM);
    return { width: 8, depth: 8 };
  },

  well: (b) => {
    b.prism(10, 0, 0, 0, 1.15, 0.9, PART_TRIM);
    b.box(-1.0, 0.9, 0, 0.22, 2.1, 0.22, PART_TRIM);
    b.box(1.0, 0.9, 0, 0.22, 2.1, 0.22, PART_TRIM);
    b.gable(0, 3.0, 0, 2.6, 0.75, 1.7, PART_ROOF, { overhang: 0.25, fascia: 0.12 });
    return { width: 2.8, depth: 2.2 };
  },

  /** A market stall: an awning, a bench, and a splash of the polity's colour. */
  stall: (b) => {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) b.box(sx * 1.5, 0, sz * 1.0, 0.14, 2.2, 0.14, PART_TRIM);
    }
    b.box(0, 0.85, -0.6, 3.1, 0.16, 1.0, PART_TRIM);
    b.gable(0, 2.2, 0, 3.4, 0.5, 2.4, PART_BANNER, {
      overhang: 0.3,
      fascia: 0.08,
      ridgeAlongX: true,
    });
    return { width: 4.0, depth: 3.0 };
  },

  /** What is left after a collapse: three walls and a chimney, going green. */
  ruin: (b) => {
    b.box(-2.1, 0, 0, 0.5, 2.6, 5.2, PART_WALL, { shade: 0.82 });
    b.box(0, 0, -2.5, 4.6, 1.5, 0.5, PART_WALL, { shade: 0.82 });
    b.box(1.6, 0, 1.4, 0.5, 0.8, 2.2, PART_WALL, { shade: 0.82 });
    b.box(-2.1, 0, -2.0, 0.9, 4.6, 0.9, PART_TRIM, { shade: 0.85 });
    b.box(0.4, 0, -0.4, 1.3, 0.35, 1.1, PART_TRIM, { shade: 0.8 });
    return { width: 6.0, depth: 6.5 };
  },
};

export const ARCHETYPE_NAMES = Object.keys(BUILDERS) as ArchetypeName[];

let cache: Record<ArchetypeName, Model> | null = null;

/** Build every model once. Around 4 ms, at start-up, on the main thread. */
export function archetypes(): Record<ArchetypeName, Model> {
  if (cache) return cache;
  const out = {} as Record<ArchetypeName, Model>;
  for (const name of ARCHETYPE_NAMES) {
    const b = new MeshBuilder();
    const { width, depth } = BUILDERS[name](b);
    const { geometry, height, triangles } = b.finish();
    geometry.name = `building:${name}`;
    out[name] = { geometry, width, depth, height, triangles };
  }
  cache = out;
  return out;
}

export function disposeArchetypes(): void {
  if (!cache) return;
  for (const name of ARCHETYPE_NAMES) cache[name].geometry.dispose();
  cache = null;
}

/** Total triangles across the whole kit. Used by the HUD and the shot tool. */
export function kitTriangles(): number {
  const all = archetypes();
  let total = 0;
  for (const name of ARCHETYPE_NAMES) total += all[name].triangles;
  return total;
}

export type { Model };

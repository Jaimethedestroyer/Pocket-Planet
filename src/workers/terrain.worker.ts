/**
 * Terrain patch meshing worker.
 *
 * Builds one cube-sphere quadtree patch per request. Runs entirely off the
 * main thread so that a fast zoom, which can ask for a hundred patches in a
 * few frames, never stalls rendering.
 *
 * Normals come from a one-vertex halo around the patch rather than from extra
 * height samples: evaluating the halo costs about 12% more vertices, where
 * finite-differencing the height field would cost 200% more.
 */

import { PlanetField } from '../planet/heightfield';
import { faceUvToUnit } from '../planet/cubesphere';
import { borderRing } from '../planet/patchTypes';
import type {
  PatchRequestMessage,
  PatchResultMessage,
  PatchWorkerMessage,
} from '../planet/patchTypes';

let field: PlanetField | null = null;
let radius = 1000;

/** Arc length between adjacent vertices, used to band-limit terrain detail. */
function patchSpacing(size: number, grid: number): number {
  // A cube face spans 2 units of face-local space and a quarter turn of the
  // planet, so one unit of face space is (pi/4) * radius of arc.
  return ((size / (grid - 1)) * radius * Math.PI) / 4;
}

self.onmessage = (event: MessageEvent<PatchWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    field = new PlanetField(msg.seed);
    radius = msg.radius;
    return;
  }
  if (msg.type === 'patch') {
    const result = buildPatch(msg);
    (self as unknown as Worker).postMessage(result, [
      result.positions.buffer,
      result.normals.buffer,
      result.data.buffer,
    ]);
  }
};

function buildPatch(req: PatchRequestMessage): PatchResultMessage {
  const f = field;
  if (!f) throw new Error('terrain worker used before init');

  const { grid, size, u0, v0, face } = req;
  const halo = grid + 2;
  const step = size / (grid - 1);
  const spacing = patchSpacing(size, grid);

  // --- Evaluate the halo grid -------------------------------------------
  // haloPos holds absolute world positions; haloData holds height/moisture/temp.
  const haloPos = new Float64Array(halo * halo * 3);
  const haloData = new Float32Array(halo * halo * 3);
  const unit = new Float64Array(3);
  const sample = new Float64Array(3);

  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (let j = 0; j < halo; j++) {
    const v = v0 + (j - 1) * step;
    for (let i = 0; i < halo; i++) {
      const u = u0 + (i - 1) * step;
      faceUvToUnit(face, u, v, unit);
      f.evaluate(unit[0], unit[1], unit[2], spacing, sample);
      const h = sample[0];
      const r = radius + h;
      const o = (j * halo + i) * 3;
      haloPos[o] = unit[0] * r;
      haloPos[o + 1] = unit[1] * r;
      haloPos[o + 2] = unit[2] * r;
      haloData[o] = h;
      haloData[o + 1] = sample[1];
      haloData[o + 2] = sample[2];
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  // --- Patch origin ------------------------------------------------------
  // Vertices are stored relative to the patch centre so their magnitudes stay
  // small; at ground level, absolute coordinates near 1000 would lose
  // centimetre precision in float32.
  faceUvToUnit(face, u0 + size * 0.5, v0 + size * 0.5, unit);
  const centreH = f.height(unit[0], unit[1], unit[2], spacing);
  const cr = radius + centreH;
  const cx = unit[0] * cr;
  const cy = unit[1] * cr;
  const cz = unit[2] * cr;

  // --- Emit the interior grid -------------------------------------------
  const border = 4 * (grid - 1);
  const vertexCount = grid * grid + border;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const data = new Float32Array(vertexCount * 3);

  let boundSq = 0;

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const hi = ((j + 1) * halo + (i + 1)) * 3;
      const oi = (j * grid + i) * 3;

      const px = haloPos[hi] - cx;
      const py = haloPos[hi + 1] - cy;
      const pz = haloPos[hi + 2] - cz;
      positions[oi] = px;
      positions[oi + 1] = py;
      positions[oi + 2] = pz;

      const d2 = px * px + py * py + pz * pz;
      if (d2 > boundSq) boundSq = d2;

      data[oi] = haloData[hi];
      data[oi + 1] = haloData[hi + 1];
      data[oi + 2] = haloData[hi + 2];

      // Central differences across the halo neighbours. Because these are real
      // surface points rather than height samples, the normal automatically
      // accounts for the planet's curvature.
      const left = ((j + 1) * halo + i) * 3;
      const right = ((j + 1) * halo + (i + 2)) * 3;
      const down = (j * halo + (i + 1)) * 3;
      const up = ((j + 2) * halo + (i + 1)) * 3;

      const ax = haloPos[right] - haloPos[left];
      const ay = haloPos[right + 1] - haloPos[left + 1];
      const az = haloPos[right + 2] - haloPos[left + 2];
      const bx = haloPos[up] - haloPos[down];
      const by = haloPos[up + 1] - haloPos[down + 1];
      const bz = haloPos[up + 2] - haloPos[down + 2];

      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // The face basis is right-handed with respect to the outward normal, but
      // guard so a degenerate patch can never invert the lighting.
      if (nx * haloPos[hi] + ny * haloPos[hi + 1] + nz * haloPos[hi + 2] < 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }
      normals[oi] = nx;
      normals[oi + 1] = ny;
      normals[oi + 2] = nz;
    }
  }

  // --- Emit the skirt ----------------------------------------------------
  // Deep enough to cover the worst height disagreement between this patch and
  // a neighbour one LOD level coarser, and no deeper: a skirt is a vertical
  // wall, and at the horizon it is seen edge on, so an over-long one shows up
  // as a staircase along the planet's silhouette.
  const skirtDepth = Math.max(spacing * 2.2, 0.5);
  const ring = borderRing(grid);
  const skirtBase = grid * grid;
  for (let k = 0; k < border; k++) {
    const src = ring[k] * 3;
    const dst = (skirtBase + k) * 3;

    // Drop straight towards the planet centre.
    const wx = positions[src] + cx;
    const wy = positions[src + 1] + cy;
    const wz = positions[src + 2] + cz;
    const wl = Math.hypot(wx, wy, wz) || 1;

    const px = positions[src] - (wx / wl) * skirtDepth;
    const py = positions[src + 1] - (wy / wl) * skirtDepth;
    const pz = positions[src + 2] - (wz / wl) * skirtDepth;
    positions[dst] = px;
    positions[dst + 1] = py;
    positions[dst + 2] = pz;

    const d2 = px * px + py * py + pz * pz;
    if (d2 > boundSq) boundSq = d2;

    normals[dst] = normals[src];
    normals[dst + 1] = normals[src + 1];
    normals[dst + 2] = normals[src + 2];
    data[dst] = data[src];
    data[dst + 1] = data[src + 1];
    data[dst + 2] = data[src + 2];
  }

  return {
    type: 'patch',
    id: req.id,
    positions,
    normals,
    data,
    center: [cx, cy, cz],
    boundRadius: Math.sqrt(boundSq),
    minHeight,
    maxHeight,
  };
}

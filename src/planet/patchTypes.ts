/** Message contract between the main thread and the terrain meshing workers. */

export interface PatchInitMessage {
  type: 'init';
  seed: number;
  radius: number;
}

export interface PatchRequestMessage {
  type: 'patch';
  /** Unique id so responses can be matched to nodes that may have been dropped. */
  id: number;
  face: number;
  level: number;
  /** Minimum corner of the patch in face-local [-1, 1] coordinates. */
  u0: number;
  v0: number;
  /** Extent of the patch in face-local coordinates. */
  size: number;
  /** Vertices per side. */
  grid: number;
}

export type PatchWorkerMessage = PatchInitMessage | PatchRequestMessage;

export interface PatchResultMessage {
  type: 'patch';
  id: number;
  /** Vertex positions relative to `center`, so they stay small and precise. */
  positions: Float32Array;
  normals: Float32Array;
  /** Per-vertex (height, moisture, temperature). */
  data: Float32Array;
  /** World-space origin the positions are relative to. */
  center: [number, number, number];
  /** Bounding sphere radius around `center`, covering the skirt too. */
  boundRadius: number;
  minHeight: number;
  maxHeight: number;
}

/**
 * Every patch of a given grid size shares identical topology, so indices are
 * built once on the main thread and reused by every mesh rather than being
 * generated and transferred per patch.
 *
 * Vertex layout:
 *   [0 .. grid*grid)                 the patch grid, row-major
 *   [grid*grid .. +4*(grid-1))       the skirt ring, one per border vertex
 *
 * The skirt is a short wall dropped from the patch border. It never shows, but
 * it plugs the one-or-two-pixel cracks that would otherwise appear where two
 * patches at different LOD levels meet.
 */
export function buildPatchIndices(grid: number): Uint16Array | Uint32Array {
  const quads = (grid - 1) * (grid - 1);
  const border = 4 * (grid - 1);
  const count = quads * 6 + border * 6;
  const vertexCount = grid * grid + border;
  const idx = vertexCount > 65535 ? new Uint32Array(count) : new Uint16Array(count);

  let w = 0;
  for (let j = 0; j < grid - 1; j++) {
    for (let i = 0; i < grid - 1; i++) {
      const a = j * grid + i;
      const b = a + 1;
      const c = a + grid;
      const d = c + 1;
      // Wound counter-clockwise as seen from outside the planet.
      idx[w++] = a; idx[w++] = b; idx[w++] = c;
      idx[w++] = b; idx[w++] = d; idx[w++] = c;
    }
  }

  const ring = borderRing(grid);
  const skirtBase = grid * grid;
  for (let k = 0; k < border; k++) {
    const b0 = ring[k];
    const b1 = ring[(k + 1) % border];
    const s0 = skirtBase + k;
    const s1 = skirtBase + ((k + 1) % border);
    idx[w++] = b0; idx[w++] = s0; idx[w++] = s1;
    idx[w++] = b0; idx[w++] = s1; idx[w++] = b1;
  }

  return idx;
}

/**
 * Indices of the patch border, traversed counter-clockwise as seen from
 * outside, starting at the (0,0) corner.
 */
export function borderRing(grid: number): Uint32Array {
  const out = new Uint32Array(4 * (grid - 1));
  let w = 0;
  for (let i = 0; i < grid - 1; i++) out[w++] = i; // bottom, +u
  for (let j = 0; j < grid - 1; j++) out[w++] = j * grid + (grid - 1); // right, +v
  for (let i = grid - 1; i > 0; i--) out[w++] = (grid - 1) * grid + i; // top, -u
  for (let j = grid - 1; j > 0; j--) out[w++] = j * grid; // left, -v
  return out;
}

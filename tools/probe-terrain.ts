/**
 * Headless sanity check on the terrain function.
 *
 * Verifies the things that are painful to diagnose by eye later: land
 * coverage, elevation range, that band-limiting actually converges as spacing
 * shrinks, and that evaluation is fast enough to mesh patches in a worker.
 */

import { PlanetField } from '../src/planet/heightfield';
import { MAX_ELEVATION, PLANET_RADIUS } from '../src/planet/config';
import { makeRng, hashSeed } from '../src/core/rng';

const seed = hashSeed(process.argv[2] ?? 'pocket-planet');
const field = new PlanetField(seed);
const rng = makeRng(seed ^ 0xabcdef);

const SAMPLES = 60000;
const spacing = 8; // roughly a mid-LOD patch

let land = 0;
let minH = Infinity;
let maxH = -Infinity;
let sumH = 0;
const histogram = new Array(12).fill(0);

const t0 = performance.now();
for (let i = 0; i < SAMPLES; i++) {
  const p = rng.onSphere();
  const h = field.height(p.x, p.y, p.z, spacing);
  if (h > 0) land++;
  minH = Math.min(minH, h);
  maxH = Math.max(maxH, h);
  sumH += h;
  const bin = Math.max(0, Math.min(11, Math.floor(((h + 40) / 90) * 12)));
  histogram[bin]++;
}
const t1 = performance.now();

console.log(`seed              ${seed >>> 0}`);
console.log(`samples           ${SAMPLES}`);
console.log(`land coverage     ${((land / SAMPLES) * 100).toFixed(1)}%   (target 25-38%)`);
console.log(`elevation range   ${minH.toFixed(1)} .. ${maxH.toFixed(1)}  (cap ${MAX_ELEVATION})`);
console.log(`mean elevation    ${(sumH / SAMPLES).toFixed(2)}`);
console.log(`height eval       ${(((t1 - t0) / SAMPLES) * 1000).toFixed(2)} us/sample`);

console.log('\nelevation histogram (-40 .. +50 m)');
const peak = Math.max(...histogram);
for (let i = 0; i < histogram.length; i++) {
  const lo = -40 + (i * 90) / 12;
  const bar = '#'.repeat(Math.round((histogram[i] / peak) * 46));
  console.log(`${lo.toFixed(0).padStart(4)}  ${bar}`);
}

// Band-limiting must converge: the same point sampled at finer spacing should
// approach a stable value rather than wandering.
console.log('\nband-limit convergence at a fixed point');
const p = rng.onSphere();
let prev = 0;
for (const s of [64, 32, 16, 8, 4, 2, 1, 0.5, 0.25]) {
  const h = field.height(p.x, p.y, p.z, s);
  const delta = prev === 0 ? 0 : h - prev;
  console.log(`  spacing ${String(s).padStart(5)}   h ${h.toFixed(4).padStart(10)}   delta ${delta.toFixed(4)}`);
  prev = h;
}

// Cost of meshing one patch, which is what actually gates the LOD system.
// Meshing evaluates a one-vertex halo around the patch so that normals can be
// taken from neighbouring surface points instead of extra height samples.
const grid = 33;
const halo = grid + 2;
const out = new Float64Array(3);
for (const spacing of [64, 8, 1, 0.2]) {
  const t2 = performance.now();
  for (let j = 0; j < halo; j++) {
    for (let i = 0; i < halo; i++) {
      const a = (i / (halo - 1)) * 0.1;
      const b = (j / (halo - 1)) * 0.1;
      const len = Math.hypot(1, a, b);
      field.evaluate(1 / len, a / len, b / len, spacing, out);
    }
  }
  const t3 = performance.now();
  console.log(
    `patch build       ${(t3 - t2).toFixed(1).padStart(6)} ms  (${halo}x${halo} halo, spacing ${spacing})`,
  );
}
console.log(`(budget: under ~8 ms so a 4-worker pool keeps up with a fast zoom)`);
void PLANET_RADIUS;

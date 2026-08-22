/**
 * Town-planner probe.
 *
 * Screenshots are how this project judges whether a town *looks* right, and
 * they are hopeless at judging whether it is *stable*: the whole point of the
 * pop-in fix is that a building standing at one tier is still standing, in the
 * same place, at the next one, and no single frame can show that.
 *
 * So this plans the same settlement at every tier and reports two things: how
 * much got built, and how much of the previous tier survived unmoved. "Kept"
 * should be 100% at every step. Anything less is a quarter of a town being
 * replaced by a different quarter of a town while the player watches.
 *
 * A number well under 100% usually means an RNG stream has desynchronised, and
 * a number a whisker under it usually means one building was displaced by
 * something the town has only just grown large enough to build. Both are real;
 * see the invariant in `docs/STATUS.md` for the ways this has broken before.
 *
 *   npx tsx tools/probe-town.ts            a spread of cells and eras
 *   npx tsx tools/probe-town.ts 42         one cell, verbose
 */

import * as THREE from 'three';
import { PlanetField } from '../src/planet/heightfield';
import { hashSeed } from '../src/core/rng';
import { Era } from '../src/sim/types';
import { planTown } from '../src/render/ground/plan';
import type { TownRequest } from '../src/render/ground/plan';

const seed = hashSeed('pocket-planet');
const field = new PlanetField(seed);

/** A land point, found by walking a deterministic spiral until one is dry. */
function landPoint(index: number): THREE.Vector3 | null {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < 400; k++) {
    const i = index * 400 + k;
    const y = 1 - (2 * (i % 2000) + 1) / 2000;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const v = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
    if (field.height(v.x, v.y, v.z, 0.5) > 6) return v;
  }
  return null;
}

function key(p: THREE.Vector3): string {
  return `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
}

const only = process.argv[2] ? Number(process.argv[2]) : null;
const cells = only !== null ? [only] : [3, 11, 29, 47, 83, 120];
const eras = only !== null ? [Era.Primitive, Era.Medieval] : [Era.Primitive, Era.Ancient, Era.Medieval, Era.Industrial];

let worstKept = 1;
let totalMs = 0;
let plans = 0;

for (const era of eras) {
  console.log(`\n=== ${Era[era]} ===`);
  console.log('  cell   tier  buildings  roads  plaza  kept from previous tier');
  for (const cell of cells) {
    const unit = landPoint(cell);
    if (!unit) continue;
    let previous: Set<string> | null = null;
    for (let tier = 0; tier <= 5; tier++) {
      const request: TownRequest = {
        cell,
        tier,
        era,
        culture: `culture-${cell}`,
        capital: false,
        coastal: false,
        ruined: false,
        unit,
      };
      const started = performance.now();
      const plan = planTown(request, field, seed);
      totalMs += performance.now() - started;
      plans++;

      const here = new Set(plan.buildings.map((b) => key(b.origin)));
      let kept = '';
      if (previous && previous.size > 0) {
        let survived = 0;
        for (const k of previous) if (here.has(k)) survived++;
        const fraction = survived / previous.size;
        worstKept = Math.min(worstKept, fraction);
        kept = `${(fraction * 100).toFixed(1)}%  (${survived}/${previous.size})`;
      }
      console.log(
        `  ${String(cell).padStart(4)}   ${tier}    ${String(plan.buildings.length).padStart(6)}` +
          `  ${String(plan.roads.length).padStart(5)}  ${String(plan.plazas.length).padStart(5)}  ${kept}`,
      );
      previous = here;
    }
  }
}

console.log(
  `\n${plans} plans in ${totalMs.toFixed(0)} ms (${(totalMs / plans).toFixed(2)} ms each)`,
);
console.log(`worst tier-to-tier retention: ${(worstKept * 100).toFixed(1)}%`);
if (worstKept < 0.999) {
  console.error('\nFAIL: growing a town moved buildings that were already standing.');
  process.exit(1);
}
console.log('growth is additive.');

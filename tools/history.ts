/**
 * Print one world's history as the player would read it.
 *
 * A quick eyeball check that the chronicle grammar produces prose rather than
 * template soup, and that the events it draws on tell a story with threads.
 *
 *   npm run history -- --seed my-world --years 2500
 */

import { Simulation } from '../src/sim/sim';
import { chronicle } from '../src/sim/chronicle';
import { ERA_NAMES } from '../src/sim/types';
import { hashSeed } from '../src/core/rng';

let seedText = 'pocket-planet';
let years = 2500;
let limit = 45;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--seed') seedText = argv[++i];
  else if (argv[i] === '--years') years = Number(argv[++i]);
  else if (argv[i] === '--limit') limit = Number(argv[++i]);
}

const sim = new Simulation({ seed: hashSeed(seedText), startingPolities: 3 });
sim.run(years);

console.log(`\n  A history of ${seedText}, years 1 to ${years}\n`);
for (const line of chronicle(sim, 0, years, limit)) {
  console.log(`  ${String(line.tick).padStart(5)}   ${line.text}`);
}

const stats = sim.stats();
console.log(`\n  ${'-'.repeat(70)}`);
console.log(`  ${stats.livingPolities} living states, ${(stats.population / 1000).toFixed(0)}k people, ${ERA_NAMES[stats.maxEra]} age`);
console.log(`  ${sim.cultures.length} cultures, ${sim.religions.length} faiths, ${stats.collapses} collapses, ${stats.wars} wars\n`);

console.log('  Surviving states:');
for (const p of sim.polities) {
  if (!p.alive) continue;
  console.log(
    `    ${p.name.padEnd(28)} ${ERA_NAMES[p.era].padEnd(11)} ` +
      `${String(Math.round(p.population / 1000)).padStart(4)}k  ` +
      `${p.cellCount} cells  founded ${p.founded}`,
  );
}
console.log('');

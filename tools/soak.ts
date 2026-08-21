/**
 * Balance harness.
 *
 * The hard problem in a long-horizon civilization simulation is not rendering.
 * It is that economies drift into degenerate equilibria: everything grows
 * forever, or everything is dead by year three hundred. Neither shows up in a
 * five-minute play session, and both are fatal.
 *
 * So this runs hundreds of whole planets, headless, for thousands of years each,
 * and asserts on the distribution of what happens. It is the reason the
 * simulation package has no DOM and no three.js dependency.
 *
 *   npm run soak                    default sweep
 *   npm run soak -- --seeds 40      fewer worlds, faster
 *   npm run soak -- --years 6000    longer histories
 *   npm run soak -- --verbose       per-world lines
 */

import { Simulation } from '../src/sim/sim';
import { Era, ERA_NAMES } from '../src/sim/types';
import { hashSeed } from '../src/core/rng';

interface Options {
  seeds: number;
  years: number;
  cells: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { seeds: 120, years: 3000, cells: 4096, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seeds') opts.seeds = Number(argv[++i]);
    else if (a === '--years') opts.years = Number(argv[++i]);
    else if (a === '--cells') opts.cells = Number(argv[++i]);
    else if (a === '--verbose') opts.verbose = true;
  }
  return opts;
}

interface WorldResult {
  seed: number;
  finalPolities: number;
  peakPolities: number;
  peakPopulation: number;
  finalPopulation: number;
  maxEra: Era;
  eraYear: number[];
  collapses: number;
  wars: number;
  settlements: number;
  peakCells: number;
  meanStability: number;
  cultures: number;
  religions: number;
  extinct: boolean;
  extinctAt: number;
  failures: string[];
  tickMs: number;
}

function runWorld(seed: number, opts: Options): WorldResult {
  const sim = new Simulation({ seed, cellCount: opts.cells, startingPolities: 3 });

  const result: WorldResult = {
    seed,
    finalPolities: 0,
    peakPolities: 0,
    peakPopulation: 0,
    finalPopulation: 0,
    maxEra: Era.Primitive,
    eraYear: [0, -1, -1, -1],
    collapses: 0,
    wars: 0,
    settlements: 0,
    peakCells: 0,
    meanStability: 0,
    cultures: 0,
    religions: 0,
    extinct: false,
    extinctAt: -1,
    failures: [],
    tickMs: 0,
  };

  const start = performance.now();
  for (let year = 1; year <= opts.years; year++) {
    sim.step();

    // Invariants. These are the ones that indicate the model is broken rather
    // than merely unbalanced, so they are checked every single tick.
    for (const p of sim.polities) {
      if (!p.alive) continue;
      if (!Number.isFinite(p.population) || p.population < 0) {
        result.failures.push(`year ${year}: ${p.name} population ${p.population}`);
      }
      if (!Number.isFinite(p.tech) || p.tech < 0) {
        result.failures.push(`year ${year}: ${p.name} tech ${p.tech}`);
      }
      if (!Number.isFinite(p.treasury)) {
        result.failures.push(`year ${year}: ${p.name} treasury ${p.treasury}`);
      }
      if (p.stability < -1e-6 || p.stability > 1 + 1e-6) {
        result.failures.push(`year ${year}: ${p.name} stability ${p.stability}`);
      }
      if (result.failures.length > 4) break;
    }

    let stabilitySum = 0;
    let stabilityCount = 0;
    for (const p of sim.polities) {
      if (!p.alive) continue;
      result.peakCells = Math.max(result.peakCells, p.cellCount);
      stabilitySum += p.stability;
      stabilityCount++;
    }
    if (stabilityCount > 0) {
      result.meanStability += stabilitySum / stabilityCount / opts.years;
    }

    const stats = sim.stats();
    result.peakPolities = Math.max(result.peakPolities, stats.livingPolities);
    result.peakPopulation = Math.max(result.peakPopulation, stats.population);
    if (stats.maxEra > result.maxEra) {
      result.maxEra = stats.maxEra;
      if (result.eraYear[stats.maxEra] < 0) result.eraYear[stats.maxEra] = year;
    }
    if (stats.livingPolities === 0 && !result.extinct) {
      result.extinct = true;
      result.extinctAt = year;
    }
    if (result.failures.length > 4) break;
  }
  const elapsed = performance.now() - start;

  const stats = sim.stats();
  result.tickMs = elapsed / opts.years;
  result.finalPolities = stats.livingPolities;
  result.finalPopulation = stats.population;
  result.collapses = stats.collapses;
  result.wars = stats.wars;
  result.settlements = stats.settlements;
  result.cultures = sim.cultures.length;
  result.religions = sim.religions.length;
  return result;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function histogram(values: number[], buckets: number, label: string, format = (n: number) => n.toFixed(0)): void {
  if (values.length === 0) return;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const counts = new Array(buckets).fill(0);
  const span = hi - lo || 1;
  for (const v of values) {
    counts[Math.min(buckets - 1, Math.floor(((v - lo) / span) * buckets))]++;
  }
  const peak = Math.max(...counts);
  console.log(`\n${label}`);
  for (let i = 0; i < buckets; i++) {
    const edge = lo + (span * i) / buckets;
    const bar = '#'.repeat(Math.round((counts[i] / peak) * 40));
    console.log(`  ${format(edge).padStart(10)}  ${bar} ${counts[i] || ''}`);
  }
}

/**
 * Replay determinism. The save format is a seed plus a list of dial changes, so
 * two runs of the same seed must produce bit-identical worlds or every save
 * ever written is worthless.
 */
function checkDeterminism(years: number, cells: number): string | null {
  const seed = hashSeed('determinism');
  const a = new Simulation({ seed, cellCount: cells, startingPolities: 3 });
  const b = new Simulation({ seed, cellCount: cells, startingPolities: 3 });

  // Include a policy change part-way through: player input is part of the
  // replay, and it is the part most likely to introduce order dependence.
  for (let i = 0; i < years; i++) {
    a.step();
    b.step();
    if (i === Math.floor(years / 3)) {
      a.setPolicy(a.playerPolity, 1, 3.2);
      b.setPolicy(b.playerPolity, 1, 3.2);
    }
  }
  const ha = a.hashState();
  const hb = b.hashState();
  return ha === hb ? null : `hash ${ha} != ${hb}`;
}

const opts = parseArgs(process.argv.slice(2));
console.log(
  `soak: ${opts.seeds} worlds x ${opts.years} years x ${opts.cells} cells\n`,
);

const results: WorldResult[] = [];
const t0 = performance.now();
for (let i = 0; i < opts.seeds; i++) {
  const seed = hashSeed(`soak-${i}`);
  const r = runWorld(seed, opts);
  results.push(r);
  if (opts.verbose || r.failures.length > 0) {
    console.log(
      `  world ${String(i).padStart(3)}  ` +
        `polities ${r.finalPolities}  ` +
        `pop ${(r.finalPopulation / 1000).toFixed(0)}k  ` +
        `era ${ERA_NAMES[r.maxEra]}  ` +
        `collapses ${r.collapses}  wars ${r.wars}` +
        (r.failures.length ? `  FAIL ${r.failures[0]}` : ''),
    );
  } else if ((i + 1) % 10 === 0) {
    process.stdout.write(`  ${i + 1}/${opts.seeds}\r`);
  }
}
const wallSeconds = (performance.now() - t0) / 1000;

/* ---------------------------------------------------------------- summary */

const reached = (era: Era): number => results.filter((r) => r.maxEra >= era).length / results.length;
const collapsed = results.filter((r) => r.collapses > 0).length / results.length;
const extinct = results.filter((r) => r.extinct).length / results.length;
const invariantFailures = results.filter((r) => r.failures.length > 0);

const tickTimes = results.map((r) => r.tickMs).sort((a, b) => a - b);
const finalPops = results.map((r) => r.finalPopulation).sort((a, b) => a - b);
const finalPolities = results.map((r) => r.finalPolities).sort((a, b) => a - b);

console.log(`\n${'='.repeat(64)}`);
console.log(`worlds            ${results.length} in ${wallSeconds.toFixed(1)}s`);
console.log(`tick time         median ${percentile(tickTimes, 50).toFixed(3)} ms   p99 ${percentile(tickTimes, 99).toFixed(3)} ms`);
console.log(`final population  median ${(percentile(finalPops, 50) / 1000).toFixed(0)}k   p10 ${(percentile(finalPops, 10) / 1000).toFixed(0)}k   p90 ${(percentile(finalPops, 90) / 1000).toFixed(0)}k`);
console.log(`final polities    median ${percentile(finalPolities, 50)}   range ${finalPolities[0]}–${finalPolities[finalPolities.length - 1]}`);
console.log(`peak empire size  median ${percentile(results.map((r) => r.peakCells).sort((a, b) => a - b), 50)} cells   max ${Math.max(...results.map((r) => r.peakCells))}`);
console.log(`mean stability    median ${percentile(results.map((r) => r.meanStability).sort((a, b) => a - b), 50).toFixed(2)}`);
console.log(`cultures          median ${percentile(results.map((r) => r.cultures).sort((a, b) => a - b), 50)}`);
console.log(`religions         median ${percentile(results.map((r) => r.religions).sort((a, b) => a - b), 50)}`);

console.log('\nera reached');
for (let e = Era.Ancient; e <= Era.Industrial; e++) {
  const years = results.filter((r) => r.eraYear[e] > 0).map((r) => r.eraYear[e]).sort((a, b) => a - b);
  console.log(
    `  ${ERA_NAMES[e].padEnd(12)} ${(reached(e) * 100).toFixed(0).padStart(3)}% of worlds` +
      (years.length ? `   median year ${percentile(years, 50)}` : ''),
  );
}

histogram(results.map((r) => r.finalPopulation / 1000), 10, 'final population (thousands)');
histogram(results.map((r) => r.collapses), 10, 'collapses per world');

/* ------------------------------------------------------------ assertions */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const determinismError = checkDeterminism(Math.min(opts.years, 900), opts.cells);

const checks: Check[] = [
  {
    name: 'replays are deterministic',
    ok: determinismError === null,
    detail: determinismError ?? 'identical state hash after a replayed history',
  },
  {
    name: 'cultures diverge',
    ok: percentile(results.map((r) => r.cultures).sort((a, b) => a - b), 50) > 3,
    detail: `median ${percentile(results.map((r) => r.cultures).sort((a, b) => a - b), 50)} cultures per world (want > 3 starting)`,
  },
  {
    name: 'no invariant failures',
    ok: invariantFailures.length === 0,
    detail: invariantFailures.length
      ? `${invariantFailures.length} worlds: ${invariantFailures[0].failures[0]}`
      : 'all populations, tech and treasuries finite and in range',
  },
  {
    name: 'civilization usually survives',
    ok: extinct <= 0.15,
    detail: `${(extinct * 100).toFixed(0)}% of worlds went extinct (want <= 15%)`,
  },
  {
    name: 'industry is reachable but not certain',
    ok: reached(Era.Industrial) >= 0.2 && reached(Era.Industrial) <= 0.9,
    detail: `${(reached(Era.Industrial) * 100).toFixed(0)}% reached Industrial (want 20-90%)`,
  },
  {
    name: 'history is not static',
    ok: collapsed >= 0.35,
    detail: `${(collapsed * 100).toFixed(0)}% of worlds saw a collapse (want >= 35%)`,
  },
  {
    name: 'populations do not run away',
    ok: percentile(finalPops, 90) < 40_000_000,
    detail: `p90 final population ${(percentile(finalPops, 90) / 1000).toFixed(0)}k`,
  },
  {
    name: 'tick stays within budget',
    ok: percentile(tickTimes, 99) < 4,
    detail: `p99 ${percentile(tickTimes, 99).toFixed(3)} ms (budget 4 ms)`,
  },
];

console.log(`\n${'='.repeat(64)}`);
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(36)} ${c.detail}`);
}
console.log('');

process.exit(failed > 0 ? 1 : 0);

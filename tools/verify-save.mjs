/**
 * End-to-end check that a saved world reloads as the same world.
 *
 * The save format stores a seed and a list of dial changes and nothing else, so
 * "loading" means replaying history from year one. That only works if the
 * simulation is exactly deterministic — the soak harness asserts that property
 * in isolation, and this asserts that the actual save, storage and restore path
 * preserves it in the browser.
 *
 *   npm run verify-save
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4189;
const SEED = 'save-check';

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

console.log('building...');
await run('npx', ['vite', 'build', '--logLevel', 'warn']);

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--logLevel', 'warn'],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill('SIGTERM'));
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/`);
    if (r.ok) break;
  } catch {
    /* not up */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 500, height: 340 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('  page error:', e.message));

// speed=0 pauses from the URL, which matters: pausing with a message after the
// page has loaded leaves a few years of slack, and this test compares exact
// ticks. The worker applies it before its first timer can fire.
const url = `http://localhost:${PORT}/?seed=${SEED}&scale=0.4&autorotate=0&speed=0`;

async function boot() {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.pocketPlanet !== undefined', null, { timeout: 30000 });
  await page.evaluate('window.pocketPlanet.skipBoot()');
  await page.waitForFunction('window.pocketPlanet.app.sim.ready === true', null, { timeout: 60000 });
}

/** Advance history and read back a fingerprint of the resulting world. */
async function fingerprint() {
  return page.evaluate(() => {
    const sim = window.pocketPlanet.app.sim;
    return {
      tick: sim.tick,
      population: Math.round(sim.totalPopulation),
      states: sim.livingPolities,
      settlements: sim.settlements.length,
      player: sim.player()?.name ?? '',
      tech: Number((sim.player()?.tech ?? 0).toFixed(4)),
    };
  });
}

// --- First session: play, change a dial, play some more --------------------

// Storage is per-origin and unavailable on about:blank, so the page has to be
// loaded once before it can be cleared, then loaded again to start fresh.
await page.goto(url, { waitUntil: 'load' });
await page.evaluate('localStorage.clear()');
await boot();

await page.evaluate('window.pocketPlanet.runYears(400)');
await page.waitForTimeout(700);
// A policy change part-way through is the part of the replay most likely to
// drift, because it has to be applied on exactly the tick it was made on.
await page.evaluate(() => window.pocketPlanet.app.sim.setPolicy(3, 3.1));
await page.waitForTimeout(300);
await page.evaluate('window.pocketPlanet.runYears(400)');
await page.waitForTimeout(700);

const before = await fingerprint();
await page.evaluate(() => window.pocketPlanet.app.sim.save());
const saved = await page.evaluate(() => localStorage.getItem('pocket-planet/save/v1'));
console.log(`\n  first session   year ${before.tick}  ${before.states} states  ${before.settlements} towns`);
console.log(`  save size       ${new TextEncoder().encode(saved ?? '').length} bytes`);

// --- Second session: reload and replay -------------------------------------

await boot();
await page.waitForFunction(
  (target) => window.pocketPlanet.app.sim.tick >= target,
  before.tick,
  { timeout: 60000 },
);
await page.waitForTimeout(500);
const after = await fingerprint();
console.log(`  after reload    year ${after.tick}  ${after.states} states  ${after.settlements} towns`);

await browser.close();
server.kill('SIGTERM');

// --- Compare ---------------------------------------------------------------

const keys = ['tick', 'population', 'states', 'settlements', 'player', 'tech'];
const mismatches = keys.filter((k) => before[k] !== after[k]);

console.log('');
for (const k of keys) {
  const ok = before[k] === after[k];
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(12)} ${before[k]}${ok ? '' : `  !=  ${after[k]}`}`);
}
console.log('');

if (mismatches.length > 0) {
  console.error(`replay diverged on: ${mismatches.join(', ')}`);
  process.exit(1);
}
console.log('  a reloaded world is the same world.\n');

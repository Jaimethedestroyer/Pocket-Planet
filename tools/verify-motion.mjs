/**
 * Check that the sea actually moves.
 *
 * The wave stack fades each band out once it is too small to resolve, which is
 * correct but has an obvious failure mode: get the thresholds slightly wrong
 * and the ocean silently becomes a mirror at every altitude a player will ever
 * look at it from. A still screenshot cannot catch that, and neither can a
 * person who has not seen it working.
 *
 * So this pauses history, holds the camera still, and captures the same view
 * twice a second apart. Anything that changes is the water.
 *
 *   npm run verify-motion
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4191;

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
const page = await browser.newPage({ viewport: { width: 460, height: 300 } });
page.on('pageerror', (e) => console.log('  page error:', e.message));

// The camera is frozen and history is paused, so the only thing left that can
// move is the water.
await page.goto(
  `http://localhost:${PORT}/?seed=pocket-planet&autorotate=0&speed=0&lat=30&lon=60&altitude=150&heading=60&sun=20`,
  { waitUntil: 'load' },
);
await page.waitForFunction('window.pocketPlanet !== undefined', null, { timeout: 30000 });
await page.evaluate('window.pocketPlanet.skipBoot()');

// Let the terrain finish building before comparing anything.
for (let i = 0; i < 200; i++) {
  if (await page.evaluate('window.pocketPlanet.isSettled()')) break;
  await page.waitForTimeout(250);
}
await page.waitForTimeout(500);

/** A patch of open ocean, away from the coastline and the interface. */
const clip = { x: 40, y: 120, width: 300, height: 90 };

const a = await page.screenshot({ clip });
await page.waitForTimeout(1400);
const b = await page.screenshot({ clip });

await browser.close();
server.kill('SIGTERM');

// PNG bytes are a coarse signal, but a decisive one: an identical frame
// compresses to an identical file, so any difference at all is movement.
const identical = a.length === b.length && a.equals(b);
const drift = Math.abs(a.length - b.length);

console.log(`\n  frame A         ${a.length} bytes`);
console.log(`  frame B         ${b.length} bytes  (${drift} difference)`);
console.log('');
console.log(`  ${identical ? 'FAIL' : 'PASS'}  the sea moves between frames`);
console.log('');

process.exit(identical ? 1 : 0);

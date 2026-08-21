/**
 * Check that dragging the planet does what a hand expects.
 *
 * The property being tested is the one the arcball exists to guarantee: the
 * point you grab stays under your finger. It is worth a real test because the
 * failure mode is invisible when zoomed in — the old code felt fine up close
 * and spun the planet through roughly 190 degrees in one drag when zoomed out,
 * which is exactly the kind of bug that survives until someone plays with it.
 *
 *   npm run verify-camera
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4193;

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
  } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const W = 800;
const H = 520;
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('  page error:', e.message));

const results = [];

/** Grab a point, drag by (dx, dy), and see where that point ended up. */
async function grabTest(label, altitude, dx, dy, steps = 24, opts = {}) {
  const { maxTurn = 120, requireTracking = true } = opts;
  await page.goto(
    `http://localhost:${PORT}/?seed=pocket-planet&autorotate=0&speed=0&scale=0.5&altitude=${altitude}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction('window.pocketPlanet !== undefined', null, { timeout: 30000 });
  await page.evaluate('window.pocketPlanet.skipBoot()');
  await page.waitForTimeout(1200);

  // Start a little off centre so the drag is a real rotation, not a spin in place.
  const x0 = W / 2 - 60;
  const y0 = H / 2 - 40;

  const grabbed = await page.evaluate(([x, y]) => window.pocketPlanet.pick(x, y), [x0, y0]);
  if (!grabbed) {
    results.push({ label, ok: false, detail: 'the grab point missed the planet' });
    return;
  }

  const before = await page.evaluate('window.pocketPlanet.cameraTarget()');

  await page.mouse.move(x0, y0);
  await page.mouse.down();
  // Many small steps, as a real pointer produces.
  await page.mouse.move(x0 + dx, y0 + dy, { steps });
  await page.waitForTimeout(120);

  const landed = await page.evaluate((v) => window.pocketPlanet.project(v), grabbed);
  const after = await page.evaluate('window.pocketPlanet.cameraTarget()');
  await page.mouse.up();

  const dot = Math.max(-1, Math.min(1, before[0] * after[0] + before[1] * after[1] + before[2] * after[2]));
  const turned = (Math.acos(dot) * 180) / Math.PI;

  if (!Number.isFinite(turned)) {
    results.push({ label, ok: false, detail: 'rotation was not a number' });
    return;
  }

  if (!requireTracking) {
    results.push({
      label,
      ok: turned <= maxTurn,
      detail: `turned ${turned.toFixed(0)} deg (bound ${maxTurn})`,
    });
    return;
  }

  if (!landed) {
    results.push({
      label,
      ok: false,
      detail: `grabbed point left the screen (turned ${turned.toFixed(0)} deg)`,
    });
    return;
  }

  const err = Math.hypot(landed[0] - (x0 + dx), landed[1] - (y0 + dy));
  // A few pixels of slack: the drag is applied incrementally, and the radius
  // the pick uses shifts slightly with the terrain as the camera moves.
  const ok = err < 26 && turned <= maxTurn;
  results.push({
    label,
    ok,
    detail:
      `off by ${err.toFixed(1)} px  ` +
      `(wanted ${(x0 + dx).toFixed(0)},${(y0 + dy).toFixed(0)} ` +
      `got ${landed[0].toFixed(0)},${landed[1].toFixed(0)})  ` +
      `turned ${turned.toFixed(0)} deg`,
  });
}

/**
 * A drag that leaves the planet cannot track a point that is no longer under
 * the pointer, so all that is asked of it is that it stays sane. This is the
 * case the original bug lived in: one flick across a small disc used to spin
 * the world through roughly 190 degrees.
 */
async function boundsTest(label, altitude, dx, dy) {
  await grabTest(label, altitude, dx, dy, 24, { maxTurn: 150, requireTracking: false });
}

console.log('dragging...');
await grabTest('single event, 40 px', 3000, 40, 0, 1);
await grabTest('zoomed out, 40 px', 3000, 40, 0);
await grabTest('zoomed out, 90 px', 3000, 90, 0);
await grabTest('zoomed out, diagonal', 3000, -70, 55);
await grabTest('mid altitude, 220 px', 600, 220, 0);
await grabTest('close in, 160 px', 60, 160, 40);
await boundsTest('drag off the limb', 3000, 320, 0);
await boundsTest('flick across the disc', 3000, -300, 220);

await browser.close();
server.kill('SIGTERM');

console.log('');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(28)} ${r.detail}`);
}
console.log('');
process.exit(failed > 0 ? 1 : 0);

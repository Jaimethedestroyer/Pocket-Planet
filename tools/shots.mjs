/**
 * Headless screenshot harness.
 *
 * Builds the app, serves it, then drives the camera through a fixed set of
 * viewpoints and captures each once the LOD system reports it has nothing left
 * to build. Deterministic seed and a frozen sun mean two runs are comparable,
 * which is what makes this useful for spotting visual regressions rather than
 * just producing pretty pictures.
 *
 *   npm run shot            all shots
 *   npm run shot -- orbit   just the named ones
 */

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const PORT = 4183;
const OUT = 'docs/shots';
const SEED = 'pocket-planet';
// Optional overrides for experiments: LOD=1.5 npm run shot -- coast
const LOD = process.env.LOD ? `&lod=${process.env.LOD}` : '';
const BLOOM = process.env.BLOOM !== undefined ? `&bloom=${process.env.BLOOM}` : '';
const CLOUDS = process.env.CLOUDS !== undefined ? `&clouds=${process.env.CLOUDS}` : '';
const DETAIL = process.env.DETAIL !== undefined ? `&detail=${process.env.DETAIL}` : '';
const KIT = process.env.KIT ? `&kit=${process.env.KIT}` : '';
const SCALE = process.env.SCALE ?? '1';

/**
 * Viewpoints. Altitude is metres above the terrain; the planet radius is 1000.
 *
 * `sunOffset` is degrees of sun angle relative to the viewpoint's own
 * longitude, because the sun tracks longitude: 0 puts it overhead, -75 gives a
 * low morning light, and past about -90 the viewpoint is in night. Specifying
 * an absolute sun angle instead is how the first version of this file ended up
 * shooting a "mountains at dawn" frame on the far side of the planet at
 * midnight.
 */
const SHOTS = [
  { name: 'orbit', lat: 18, lon: 40, altitude: 2600, heading: 0, sunOffset: -20 },
  { name: 'orbit-terminator', lat: 5, lon: 128, altitude: 2100, heading: 0, sunOffset: -78 },
  { name: 'continent', lat: 22, lon: 44, altitude: 620, heading: 0, sunOffset: -30 },
  { name: 'coast', lat: 30, lon: 60, altitude: 150, heading: 60, sunOffset: -40 },
  { name: 'mountains', lat: -14, lon: 200, altitude: 110, heading: 130, sunOffset: -55 },
  { name: 'ground', lat: 22, lon: 44, altitude: 6, heading: 90, sunOffset: -62 },
  { name: 'dusk', lat: 30, lon: 60, altitude: 40, heading: 250, sunOffset: -86 },
  // History shots: `years` advances the simulation before capturing, so these
  // show territory and settlements rather than an empty planet.
  { name: 'civilization', lat: 18, lon: 40, altitude: 1400, heading: 0, sunOffset: -25, years: 900 },
  { name: 'empire', lat: 18, lon: 40, altitude: 2600, heading: 0, sunOffset: -25, years: 1100 },
  { name: 'night-lights', lat: 18, lon: 40, altitude: 1500, heading: 0, sunOffset: -150, years: 0 },
  // Ground detail. `town` aims at a real settlement rather than at fixed
  // coordinates, because where cities end up depends on the seed and the
  // history — a hard-coded latitude photographs an empty hillside.
  // The first of these carries the years so that a filtered run — which is how
  // this gets used ninety per cent of the time — still has a town to look at.
  // The model catalogue, on real ground, in known light. Run with KIT=1.
  { name: 'kit', lat: 3.5, lon: 94.5, altitude: 200, heading: 0, tilt: -0.62, sunOffset: -40, frame: true },
  { name: 'kit-low', lat: 3.5, lon: 94.5, altitude: 95, heading: 0, tilt: -0.62, sunOffset: -50, frame: true },
  { name: 'town', town: 0, altitude: 220, heading: 40, tilt: -0.42, sunOffset: -52, years: 700, frame: true },
  { name: 'town-street', town: 0, altitude: 26, heading: 40, tilt: -0.52, sunOffset: -64, years: 0, frame: true },
  { name: 'town-night', town: 0, altitude: 170, heading: 40, tilt: -0.4, sunOffset: -140, years: 0, frame: true },
  { name: 'town-second', town: 3, altitude: 140, heading: 200, tilt: -0.38, sunOffset: -44, years: 0, frame: true },
  // A grown city, at three altitudes. Eighteen hundred more years gets the
  // largest settlement to a tier where it has streets rather than a clearing.
  { name: 'city', town: 0, altitude: 330, heading: 90, tilt: -0.52, sunOffset: -44, years: 2200, frame: true },
  { name: 'city-close', town: 0, altitude: 120, heading: 25, tilt: -0.5, sunOffset: -56, frame: true },
  { name: 'city-street', town: 0, altitude: 24, heading: 25, tilt: -0.55, sunOffset: -66, frame: true },
  { name: 'city-night', town: 0, altitude: 260, heading: 90, tilt: -0.5, sunOffset: -142, frame: true },
  // Tap to inspect: aim at a town, then tap it and capture the panel.
  { name: 'inspect', town: 0, altitude: 900, heading: 0, tilt: -0.5, sunOffset: -34, tapTown: true, frame: true },
  // Interface shots. `panel` opens the priorities panel before capturing.
  { name: 'interface', lat: 18, lon: 40, altitude: 1800, heading: 0, sunOffset: -30, years: 300 },
  { name: 'priorities', lat: 18, lon: 40, altitude: 1800, heading: 0, sunOffset: -30, panel: true },
].map((s) => ({ ...s, sun: s.lon + s.sunOffset }));

const wanted = process.argv.slice(2);
const suffix = process.env.TAG ? `-${process.env.TAG}` : '';
const shots = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS;

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

console.log('building...');
await run('npx', ['vite', 'build', '--logLevel', 'warn']);

await mkdir(OUT, { recursive: true });

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--logLevel', 'warn'],
  { stdio: 'ignore' },
);
const shutdown = () => server.kill('SIGTERM');
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(1); });

// Wait for the preview server to accept connections.
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`http://localhost:${PORT}/`);
    if (res.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

// The full Chromium build, not headless_shell: swiftshader-backed WebGL2 is
// only available in the complete browser.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

// Always shoot at a 1:1 internal resolution. Rendering smaller and letting the
// browser upscale looked like a free saving, but it puts visible stair-steps
// along the planet's limb — the one place in the image with a hard, bright,
// curved edge — and those are easily mistaken for an LOD bug. Use a smaller
// viewport instead when software rasterisation needs the help.
const VW = Number(process.env.VW ?? 1000);
const VH = Number(process.env.VH ?? 625);
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`  [page ${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

await page.goto(`http://localhost:${PORT}/?seed=${SEED}&hud=1&autorotate=0&speed=0&scale=${SCALE}${LOD}${BLOOM}${CLOUDS}${DETAIL}${KIT}`, {
  waitUntil: 'load',
});
await page.waitForFunction('window.pocketPlanet !== undefined', null, { timeout: 30000 });

/** Spin the frame loop until the terrain reports it has nothing queued. */
async function settle(timeoutMs = Number(process.env.SETTLE_MS ?? 180000)) {
  const start = Date.now();
  let stableFrames = 0;
  while (Date.now() - start < timeoutMs) {
    const settled = await page.evaluate('window.pocketPlanet.isSettled()');
    stableFrames = settled ? stableFrames + 1 : 0;
    // Require several consecutive settled polls: a patch arriving can trigger
    // a fresh round of splits one frame later.
    if (stableFrames >= 6) return true;
    await page.waitForTimeout(220);
  }
  return false;
}

console.log('capturing...');
await page.evaluate('window.pocketPlanet.skipBoot()');

// Simulation speed is driven explicitly by the shots, not by wall clock.
await page.evaluate('window.pocketPlanet.setSpeed(0)');

let simulatedYears = 0;
for (const shot of shots) {
  const { name, years, sunOffset, panel, town, tapTown, ...view } = shot;
  void tapTown;
  void sunOffset;
  if (years) {
    // Advance in bounded chunks: the worker caps a single catch-up so that a
    // long absence cannot block it for seconds on end.
    for (let remaining = years; remaining > 0; remaining -= 500) {
      await page.evaluate((n) => window.pocketPlanet.runYears(n), Math.min(500, remaining));
      await page.waitForTimeout(150);
    }
    simulatedYears += years;
  }
  if (town !== undefined) {
    const list = await page.evaluate(() => window.pocketPlanet.towns());
    if (list.length === 0) {
      console.log(`  ${name.padEnd(18)} SKIPPED (no settlements yet)`);
      continue;
    }
    const target = list[Math.min(town, list.length - 1)];
    view.lat = target.lat;
    view.lon = target.lon;
    view.sun = target.lon + sunOffset;
    console.log(`  ${name.padEnd(18)} aiming at ${target.name} (tier ${target.tier})`);
  }
  await page.evaluate((v) => window.pocketPlanet.setView(v), { ...view, autoRotate: false });
  if (shot.tapTown) {
    // Tap the town at the centre of the view. Its marker is projected rather
    // than guessed, so this works wherever the seed put the city.
    const at = await page.evaluate(() => {
      const target = window.pocketPlanet.cameraTarget();
      return window.pocketPlanet.project(target);
    });
    if (at) {
      const kind = await page.evaluate(([x, y]) => window.pocketPlanet.tap(x, y), at);
      console.log(`  ${name.padEnd(18)} tapped at ${at.map(Math.round).join(',')} -> ${kind}`);
    } else {
      console.log(`  ${name.padEnd(18)} target not on screen, no tap`);
    }
  }
  if (panel) {
    await page.evaluate(() => {
      const toggle = document.getElementById('pp-policy-toggle');
      if (toggle && document.getElementById('pp-policies')?.hasAttribute('hidden')) toggle.click();
    });
  }
  const ok = await settle();
  await page.waitForTimeout(500);
  const stats = await page.evaluate('window.pocketPlanet.stats()');
  await page.screenshot({ path: `${OUT}/${name}${suffix}.png` });
  console.log(
    `  ${name.padEnd(18)} ${ok ? 'settled' : 'TIMEOUT'}  ` +
      `patches ${String(stats.visiblePatches).padStart(4)}  ` +
      `tris ${String(Math.round(stats.triangles / 1000)).padStart(4)}k  ` +
      `lod ${stats.deepestLevel}  ` +
      `draws ${String(stats.drawCalls).padStart(3)}  ` +
      `year ${String(stats.year).padStart(4)}  ` +
      `states ${stats.states}  ` +
      `towns ${stats.settlements}  ` +
      `built ${stats.towns}/${stats.buildings}b/${stats.plants}p/${stats.people}h  ` +
      `plan ${stats.planMs.toFixed(1)}ms`,
  );
}

await browser.close();
server.kill('SIGTERM');
console.log(`\nwrote ${shots.length} shots to ${OUT}/ (${simulatedYears} years simulated)`);

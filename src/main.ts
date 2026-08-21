import { PocketPlanetApp } from './app';
import { Hud } from './ui/hud';
import { Vector3 } from 'three';
import { PLANET_RADIUS } from './planet/config';
import type { ViewState } from './app';
import type { QualityTier } from './planet/config';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const boot = document.getElementById('boot')!;
const bootFill = document.getElementById('boot-fill')!;
const bootStatus = document.getElementById('boot-status')!;
const hud = document.getElementById('hud')!;

const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? 'pocket-planet';
const quality = (params.get('quality') as QualityTier | null) ?? undefined;

const renderScale = params.has('scale') ? Number(params.get('scale')) : undefined;
const pixelError = params.has('lod') ? Number(params.get('lod')) : undefined;

const bloom = params.has('bloom') ? Number(params.get('bloom')) : undefined;

const cellCount = params.has('cells') ? Number(params.get('cells')) : undefined;
const speed = params.has('speed') ? Number(params.get('speed')) : undefined;

const app = new PocketPlanetApp({
  canvas,
  seed,
  quality,
  renderScale,
  pixelError,
  bloom,
  cellCount,
  speed,
});

// Apply any view supplied on the query string. Handy for sharing a viewpoint
// and for driving the screenshot tool.
const view: ViewState = {};
for (const key of ['lat', 'lon', 'altitude', 'heading', 'sun'] as const) {
  const raw = params.get(key);
  if (raw !== null) view[key] = Number(raw);
}
if (params.get('autorotate') === '0') view.autoRotate = false;
if (Object.keys(view).length > 0) app.setView(view);

// --- Game interface --------------------------------------------------------

const gameHud = new Hud(app.sim);
document.body.appendChild(gameHud.root);
const previousOnState = app.sim.onState;
app.sim.onState = () => {
  previousOnState?.();
  gameHud.update();
};
app.sim.onDigest = (lines) => gameHud.showDigest(lines);

app.start();

// --- Boot sequence ---------------------------------------------------------
// The planet is only revealed once the six root patches exist, so the first
// thing the player sees is a whole world rather than one growing in front of
// them.

const bootPhases = ['forming crust', 'raising mountains', 'filling oceans', 'settling climate'];
let bootStart = performance.now();
let booted = false;

function pollBoot(): void {
  if (booted) return;
  const elapsed = performance.now() - bootStart;
  const settled = app.isSettled();
  const progress = settled ? 1 : Math.min(0.92, elapsed / 2600);
  bootFill.setAttribute('style', `width:${(progress * 100).toFixed(0)}%`);
  const phase = Math.min(bootPhases.length - 1, Math.floor(progress * bootPhases.length));
  bootStatus.textContent = bootPhases[phase];

  if (settled && elapsed > 500) {
    booted = true;
    bootFill.setAttribute('style', 'width:100%');
    boot.classList.add('done');
    setTimeout(() => boot.setAttribute('hidden', ''), 800);
    return;
  }
  requestAnimationFrame(pollBoot);
}
requestAnimationFrame(pollBoot);

// --- Debug HUD -------------------------------------------------------------

const hudFields = {
  fps: document.getElementById('hud-fps')!,
  alt: document.getElementById('hud-alt')!,
  patches: document.getElementById('hud-patches')!,
  tris: document.getElementById('hud-tris')!,
  lod: document.getElementById('hud-lod')!,
  pending: document.getElementById('hud-pending')!,
};

function formatAltitude(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(0)} m`;
}

function formatCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
}

let hudVisible = params.get('hud') === '1';
hud.toggleAttribute('hidden', !hudVisible);

setInterval(() => {
  if (!hudVisible) return;
  const s = app.getStats();
  hudFields.fps.textContent = s.fps.toFixed(0);
  hudFields.alt.textContent = formatAltitude(s.altitude);
  hudFields.patches.textContent = `${s.visiblePatches}/${s.liveNodes}`;
  hudFields.tris.textContent = formatCount(s.triangles);
  hudFields.lod.textContent = `${s.deepestLevel}`;
  hudFields.pending.textContent = `${s.pending}+${s.queued}`;
}, 250);

// Press H to toggle the HUD.
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    hudVisible = !hudVisible;
    hud.toggleAttribute('hidden', !hudVisible);
  }
});

// --- Automation hook -------------------------------------------------------
// Exposed so the headless screenshot tool can position the camera and wait for
// the LOD system to settle before capturing.

declare global {
  interface Window {
    pocketPlanet: {
      app: PocketPlanetApp;
      setView(view: ViewState): void;
      isSettled(): boolean;
      stats(): Record<string, number>;
      skipBoot(): void;
      runYears(years: number): void;
      setSpeed(yearsPerSecond: number): void;
      pick(x: number, y: number): [number, number, number] | null;
      project(v: [number, number, number]): [number, number] | null;
      cameraTarget(): [number, number, number];
    };
  }
}

window.pocketPlanet = {
  app,
  setView: (v) => {
    app.setView(v);
    bootStart = performance.now();
  },
  isSettled: () => app.isSettled(),
  stats: () => app.getStats(),
  skipBoot: () => {
    booted = true;
    boot.setAttribute('hidden', '');
  },
  runYears: (years) => app.sim.catchUp(years),
  setSpeed: (yearsPerSecond) => app.sim.setSpeed(yearsPerSecond),
  pick: (x, y) => {
    const v = app.rig.pickWorld(x, y);
    return v ? [v.x, v.y, v.z] : null;
  },
  project: (v) => {
    const world = new Vector3(v[0], v[1], v[2]).multiplyScalar(PLANET_RADIUS);
    // Behind the camera projects to a mirrored position rather than to
    // nothing, so reject it explicitly.
    const toPoint = world.clone().sub(app.camera.position);
    const forward = app.camera.getWorldDirection(new Vector3());
    if (toPoint.dot(forward) <= 0) return null;
    const p = world.project(app.camera);
    if (p.z > 1) return null;
    return [((p.x + 1) / 2) * innerWidth, ((1 - p.y) / 2) * innerHeight];
  },
  cameraTarget: () => [app.rig.target.x, app.rig.target.y, app.rig.target.z],
};

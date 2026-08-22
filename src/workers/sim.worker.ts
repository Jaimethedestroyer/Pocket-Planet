/**
 * Simulation worker.
 *
 * Owns the world outright and drives it on its own clock, so the frame rate and
 * the passage of history are completely independent. The renderer never blocks
 * on a tick, and a catch-up of two thousand years after the app was closed runs
 * here behind a progress state rather than freezing the first frame.
 */

import { Simulation } from '../sim/sim';
import { chronicle, digest } from '../sim/chronicle';
import { TerritoryPainter } from '../sim/territoryPainter';
import { toPolityView } from '../sim/protocol';
import type {
  PolicyChange,
  SimCommand,
  SimReadyMessage,
  SimStateMessage,
} from '../sim/protocol';

let sim: Simulation | null = null;
let painter: TerritoryPainter | null = null;
let yearsPerSecond = 4;
let lastRealTime = 0;
let tickAccumulator = 0;
let lastSentTick = -1;
let lastChronicleTick = 0;
let ownershipDirty = true;
let ownerSignature = 0;
/** Last ruin-set version sent, so an unchanged set costs nothing. */
let lastRuinVersion = -1;
/** Every policy change, in tick order. This plus the seed is the save file. */
let policyLog: PolicyChange[] = [];
let policyLogSent = 0;
let pendingDigest: string[] | null = null;

const post = (message: unknown, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};

self.onmessage = (event: MessageEvent<SimCommand>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init(msg.seed, msg.cellCount, msg.startingPolities);
      break;
    case 'speed':
      yearsPerSecond = Math.max(0, msg.yearsPerSecond);
      break;
    case 'policy':
      if (sim) {
        sim.setPolicy(msg.polity, msg.index, msg.value);
        policyLog.push({
          tick: sim.tick,
          polity: msg.polity,
          index: msg.index,
          value: msg.value,
        });
      }
      break;
    case 'restore':
      restore(msg.targetTick, msg.policyLog, msg.offlineYears);
      break;
    case 'catchup':
      catchUp(msg.years);
      break;
  }
};

function init(seed: number, cellCount: number, startingPolities: number): void {
  const t0 = performance.now();
  sim = new Simulation({ seed, cellCount, startingPolities });
  painter = new TerritoryPainter(cellCount);
  const buildMs = performance.now() - t0;

  // Cell positions and ground heights are constant for the life of the world,
  // so they go across once rather than in every update.
  const positions = sim.graph.position.slice();
  const heights = new Float32Array(sim.graph.height);

  const ready: SimReadyMessage = {
    type: 'ready',
    cellCount,
    positions,
    heights,
    buildMs,
  };
  post(ready, [positions.buffer, heights.buffer]);

  lastRealTime = performance.now();
  ownershipDirty = true;
  sendState();
  loop();
}

/**
 * Ownership changes far less often than population does, and repainting the
 * territory field is the single most expensive thing this worker does. A cheap
 * running signature of the owner array decides whether it is worth redoing.
 */
function ownershipChanged(): boolean {
  if (!sim) return false;
  let h = 0x811c9dc5;
  const owner = sim.owner;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === 0) continue;
    h ^= i + owner[i] * 131071;
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  if (h === ownerSignature) return false;
  ownerSignature = h;
  return true;
}

function sendState(): void {
  if (!sim || !painter) return;

  const repaint = ownershipDirty || ownershipChanged();
  ownershipDirty = false;

  // Population shifts colour weighting even when borders hold, so repaint on a
  // slow heartbeat too rather than only on ownership changes.
  const heartbeat = sim.tick - lastSentTick > 25;
  const territory = repaint || heartbeat ? painter.paint(sim).slice() : null;

  const lines = chronicle(sim, lastChronicleTick + 1, sim.tick, 24);
  lastChronicleTick = sim.tick;

  const stats = sim.stats();
  const message: SimStateMessage = {
    type: 'state',
    tick: sim.tick,
    territory,
    settlements: sim.settlements.map((s) => ({
      cell: s.cell,
      tier: s.tier,
      polity: s.polity,
      population: s.population,
      name: s.name,
      founded: s.founded,
    })),
    ruins: sim.ruinVersion !== lastRuinVersion ? sim.ruins() : null,
    polities: sim.polities
      .filter((p) => p.alive)
      .map((p) =>
        toPolityView(
          p,
          sim!.cultures[p.culture]?.name ?? '',
          sim!.religions[p.religion]?.name ?? '',
        ),
      ),
    playerPolity: sim.playerPolity,
    chronicle: lines,
    totalPopulation: stats.population,
    livingPolities: stats.livingPolities,
  };

  if (policyLog.length !== policyLogSent) {
    message.policyLog = policyLog.slice();
    policyLogSent = policyLog.length;
  }
  if (pendingDigest) {
    message.digest = pendingDigest;
    pendingDigest = null;
  }

  lastSentTick = sim.tick;
  lastRuinVersion = sim.ruinVersion;
  post(message, territory ? [territory.buffer] : []);
}

/**
 * Rebuild a saved world by replaying it, then advance it for the time the
 * player was away.
 *
 * Replay rather than snapshot: at roughly thirty microseconds a tick, even a
 * ten-thousand-year history reconstructs in well under a second, and the save
 * stays a few kilobytes no matter how long the planet has been running.
 */
function restore(targetTick: number, log: PolicyChange[], offlineYears: number): void {
  if (!sim) return;

  policyLog = log.slice().sort((a, b) => a.tick - b.tick);
  policyLogSent = policyLog.length;

  let next = 0;
  const start = performance.now();
  while (sim.tick < targetTick) {
    // Policy changes are applied at the exact tick they were made on, before
    // that tick runs, or the replay diverges from the original history.
    while (next < policyLog.length && policyLog[next].tick <= sim.tick) {
      const change = policyLog[next];
      sim.setPolicy(change.polity, change.index, change.value);
      next++;
    }
    sim.step();
  }
  while (next < policyLog.length) {
    const change = policyLog[next];
    sim.setPolicy(change.polity, change.index, change.value);
    next++;
  }

  const before = sim.tick;
  const away = Math.max(0, Math.min(2000, Math.floor(offlineYears)));
  if (away > 0) sim.run(away);

  lastChronicleTick = before;
  pendingDigest = away > 0 ? digest(sim, before, 5) : null;
  ownershipDirty = true;
  void start;
  sendState();
}

function catchUp(years: number): void {
  if (!sim) return;
  const capped = Math.max(0, Math.min(2000, Math.floor(years)));
  sim.run(capped);
  ownershipDirty = true;
  sendState();
}

function loop(): void {
  if (!sim) return;
  const now = performance.now();
  const dt = Math.min(0.25, (now - lastRealTime) / 1000);
  lastRealTime = now;

  if (yearsPerSecond > 0) {
    tickAccumulator += dt * yearsPerSecond;
    // Bound the work per wake-up: if the worker was descheduled for a second,
    // it should not try to simulate a century in one blocking burst.
    const steps = Math.min(120, Math.floor(tickAccumulator));
    tickAccumulator -= steps;
    for (let i = 0; i < steps; i++) sim.step();
    if (steps > 0) sendState();
  }

  setTimeout(loop, 100);
}

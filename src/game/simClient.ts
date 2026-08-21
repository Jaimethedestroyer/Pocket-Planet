/**
 * Main-thread handle on the simulation worker.
 *
 * Holds the latest snapshot and nothing else. The renderer reads from here; it
 * never waits on the worker, so a slow tick can never cost a frame.
 */

import * as THREE from 'three';
import {
  TERRITORY_HEIGHT,
  TERRITORY_WIDTH,
} from '../sim/protocol';
import type {
  PolicyChange,
  PolityView,
  SettlementView,
  SimCommand,
  SimMessage,
} from '../sim/protocol';
import { hashSeed } from '../core/rng';
import { loadSave, offlineYears, writeSave } from './save';
import type { SaveFile } from './save';

export interface ChronicleLine {
  tick: number;
  text: string;
  weight: number;
}

export class SimClient {
  private worker: Worker;

  /** Equirectangular territory field, sampled by the terrain shader. */
  readonly territoryTexture: THREE.DataTexture;

  cellPositions: Float32Array | null = null;
  cellHeights: Float32Array | null = null;

  tick = 0;
  settlements: SettlementView[] = [];
  polities: PolityView[] = [];
  playerPolity = 0;
  totalPopulation = 0;
  livingPolities = 0;
  worldBuildMs = 0;
  ready = false;

  /** Rolling window of recent history, newest last. */
  chronicle: ChronicleLine[] = [];
  private chronicleLimit = 200;

  onReady: (() => void) | null = null;
  onState: (() => void) | null = null;
  /** Fired once after a restore that advanced time while the game was closed. */
  onDigest: ((lines: string[]) => void) | null = null;

  private seedText: string;
  private cellCount: number;
  private policyLog: PolicyChange[] = [];
  private restored: SaveFile | null = null;
  private saveTimer = 0;

  constructor(seedText: string, cellCount = 4096, startingPolities = 3) {
    this.seedText = seedText;
    this.cellCount = cellCount;

    // A save only applies to the world it came from; changing the seed in the
    // URL should give a new planet, not a corrupted old one.
    const save = loadSave();
    this.restored = save && save.seed === seedText && save.cellCount === cellCount ? save : null;
    const seed = hashSeed(seedText);
    const data = new Uint8Array(TERRITORY_WIDTH * TERRITORY_HEIGHT * 4);
    this.territoryTexture = new THREE.DataTexture(
      data,
      TERRITORY_WIDTH,
      TERRITORY_HEIGHT,
      THREE.RGBAFormat,
    );
    // Longitude wraps; latitude does not. No mipmaps: the seam at the
    // antimeridian would otherwise blur across the whole texture at low levels.
    this.territoryTexture.wrapS = THREE.RepeatWrapping;
    this.territoryTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.territoryTexture.minFilter = THREE.LinearFilter;
    this.territoryTexture.magFilter = THREE.LinearFilter;
    this.territoryTexture.generateMipmaps = false;
    this.territoryTexture.needsUpdate = true;

    this.worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<SimMessage>) => this.onMessage(e.data);
    this.send({ type: 'init', seed, cellCount, startingPolities });

    // Persist on a slow timer and whenever the page is backgrounded, which on
    // a phone is the moment that actually matters: closing the tab, switching
    // apps, or locking the screen all fire visibilitychange, and none of them
    // reliably fire anything else.
    this.saveTimer = window.setInterval(() => this.save(), 15000);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.save();
  };

  private onPageHide = (): void => {
    this.save();
  };

  /** True when this session continued a stored world rather than starting one. */
  get continued(): boolean {
    return this.restored !== null;
  }

  save(): void {
    if (!this.ready || this.tick <= 0) return;
    writeSave({
      version: 1,
      seed: this.seedText,
      cellCount: this.cellCount,
      tick: this.tick,
      policyLog: this.policyLog,
      savedAt: Date.now(),
    });
  }

  private send(command: SimCommand): void {
    this.worker.postMessage(command);
  }

  private onMessage(msg: SimMessage): void {
    if (msg.type === 'ready') {
      this.cellPositions = msg.positions;
      this.cellHeights = msg.heights;
      this.worldBuildMs = msg.buildMs;
      this.ready = true;

      if (this.restored) {
        this.send({
          type: 'restore',
          targetTick: this.restored.tick,
          policyLog: this.restored.policyLog,
          offlineYears: offlineYears(this.restored.savedAt),
        });
      }

      this.onReady?.();
      return;
    }

    this.tick = msg.tick;
    this.settlements = msg.settlements;
    this.polities = msg.polities;
    this.playerPolity = msg.playerPolity;
    this.totalPopulation = msg.totalPopulation;
    this.livingPolities = msg.livingPolities;

    if (msg.territory) {
      this.territoryTexture.image.data.set(msg.territory);
      this.territoryTexture.needsUpdate = true;
    }

    if (msg.policyLog) this.policyLog = msg.policyLog;
    if (msg.digest) this.onDigest?.(msg.digest);

    if (msg.chronicle.length > 0) {
      this.chronicle.push(...msg.chronicle);
      if (this.chronicle.length > this.chronicleLimit) {
        this.chronicle.splice(0, this.chronicle.length - this.chronicleLimit);
      }
    }

    this.onState?.();
  }

  /** Hue lookup for the settlement layer. */
  polityHues(): Map<number, number> {
    const map = new Map<number, number>();
    for (const p of this.polities) map.set(p.id, p.hue);
    return map;
  }

  player(): PolityView | undefined {
    return this.polities.find((p) => p.id === this.playerPolity) ?? this.polities[0];
  }

  setSpeed(yearsPerSecond: number): void {
    this.send({ type: 'speed', yearsPerSecond });
  }

  setPolicy(index: number, value: number): void {
    const player = this.player();
    if (!player) return;
    this.send({ type: 'policy', polity: player.id, index, value });
  }

  catchUp(years: number): void {
    this.send({ type: 'catchup', years });
  }

  dispose(): void {
    this.save();
    window.clearInterval(this.saveTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    this.worker.terminate();
    this.territoryTexture.dispose();
  }
}

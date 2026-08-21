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
  PolityView,
  SettlementView,
  SimCommand,
  SimMessage,
} from '../sim/protocol';

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

  constructor(seed: number, cellCount = 4096, startingPolities = 3) {
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
    this.worker.terminate();
    this.territoryTexture.dispose();
  }
}

/**
 * Message contract between the simulation worker and the renderer.
 *
 * The worker owns the simulation outright. The main thread never reads its
 * state directly — it receives a compact snapshot of only what is drawable,
 * which keeps the frame loop free of simulation work and keeps the same
 * simulation code runnable headless in Node.
 */

import type { Era, Polity, SimEvent } from './types';

/** Resolution of the equirectangular territory texture. */
export const TERRITORY_WIDTH = 512;
export const TERRITORY_HEIGHT = 256;

export interface SimInitMessage {
  type: 'init';
  seed: number;
  cellCount: number;
  startingPolities: number;
}

export interface SimSpeedMessage {
  type: 'speed';
  /** Years per second. Zero pauses. */
  yearsPerSecond: number;
}

export interface SimPolicyMessage {
  type: 'policy';
  polity: number;
  index: number;
  value: number;
}

/** Catch up after the tab was hidden or the app was closed. */
export interface SimCatchUpMessage {
  type: 'catchup';
  years: number;
}

export type SimCommand =
  | SimInitMessage
  | SimSpeedMessage
  | SimPolicyMessage
  | SimCatchUpMessage;

/** Sent once, after the world is generated. */
export interface SimReadyMessage {
  type: 'ready';
  cellCount: number;
  /** Unit positions, three floats per cell. */
  positions: Float32Array;
  /** Terrain height at each cell, so settlements sit on the ground. */
  heights: Float32Array;
  buildMs: number;
}

export interface SettlementView {
  cell: number;
  tier: number;
  polity: number;
  population: number;
  name: string;
}

export interface PolityView {
  id: number;
  name: string;
  alive: boolean;
  hue: number;
  era: Era;
  tech: number;
  stability: number;
  population: number;
  cellCount: number;
  treasury: number;
  policies: number[];
  atWarWith: number;
  culture: string;
  religion: string;
}

/** Sent every update. Everything the renderer and HUD need, and nothing else. */
export interface SimStateMessage {
  type: 'state';
  tick: number;
  /**
   * Equirectangular RGBA territory field, or null when ownership has not
   * changed since the last update. Soft-edged by construction, so borders
   * render as painted curves rather than as the cell graph underneath.
   */
  territory: Uint8ClampedArray | null;
  settlements: SettlementView[];
  polities: PolityView[];
  playerPolity: number;
  /** Events since the previous update, already rendered to text. */
  chronicle: { tick: number; text: string; weight: number }[];
  totalPopulation: number;
  livingPolities: number;
}

export type SimMessage = SimReadyMessage | SimStateMessage;

export function polityColor(hue: number): [number, number, number] {
  // Fixed saturation and lightness: territory colours have to stay legible
  // against terrain that is already green, blue and sand-coloured.
  return hslToRgb(hue, 0.78, 0.55);
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 1) * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

export function toPolityView(p: Polity, culture: string, religion: string): PolityView {
  return {
    id: p.id,
    name: p.name,
    alive: p.alive,
    hue: p.hue,
    era: p.era,
    tech: p.tech,
    stability: p.stability,
    population: p.population,
    cellCount: p.cellCount,
    treasury: p.treasury,
    policies: Array.from(p.policies),
    atWarWith: p.atWarWith,
    culture,
    religion,
  };
}

export type { SimEvent };

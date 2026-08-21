/**
 * Persistence.
 *
 * A save is a seed, a tick, and the list of times the player moved a dial.
 * Nothing else — no world state, no populations, no borders. Replaying that
 * list against the seed reconstructs the planet exactly, which is only sound
 * because the simulation is deterministic, and which is why the soak harness
 * asserts determinism on every run rather than taking it on trust.
 *
 * The practical consequence is that a ten-thousand-year history is a few
 * kilobytes and survives in localStorage indefinitely.
 */

import type { PolicyChange } from '../sim/protocol';

const KEY = 'pocket-planet/save/v1';

/** Real seconds of absence that count as one simulated year. */
export const SECONDS_PER_YEAR = 30;

/** Longest absence that is ever caught up, in years. */
export const MAX_OFFLINE_YEARS = 2000;

export interface SaveFile {
  version: 1;
  seed: string;
  cellCount: number;
  tick: number;
  policyLog: PolicyChange[];
  /** Epoch milliseconds when the save was written. */
  savedAt: number;
}

export function loadSave(): SaveFile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SaveFile;
    if (parsed?.version !== 1 || typeof parsed.seed !== 'string') return null;
    if (!Array.isArray(parsed.policyLog)) return null;
    return parsed;
  } catch {
    // Private browsing, cleared storage, or a save from a future version. A
    // missing save is a new planet, never an error the player has to see.
    return null;
  }
}

export function writeSave(save: SaveFile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* Storage unavailable or full; the game is still playable. */
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Years of history owed for an absence.
 *
 * Clamped at both ends: a negative interval means the device clock moved
 * backwards, and an unbounded one would let someone skip a civilization's whole
 * lifetime by changing the date.
 */
export function offlineYears(savedAt: number, now = Date.now()): number {
  const seconds = (now - savedAt) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_OFFLINE_YEARS, Math.floor(seconds / SECONDS_PER_YEAR));
}

/**
 * Simulation data model.
 *
 * Everything here is plain data. No DOM, no three.js, no I/O — the whole `sim`
 * package has to run unchanged in a Web Worker and in Node, because the balance
 * harness is what keeps the game honest and it runs headless.
 */

/** Policy dials. The player's entire vocabulary. */
export const POLICIES = [
  'trade',
  'war',
  'education',
  'expansion',
  'conservation',
  'culture',
] as const;

export type PolicyName = (typeof POLICIES)[number];
export const POLICY_COUNT = POLICIES.length;

/** Total points a polity may distribute across its dials. */
export const POLICY_BUDGET = 6;

export enum Era {
  Primitive = 0,
  Ancient = 1,
  Medieval = 2,
  Industrial = 3,
}

export const ERA_NAMES = ['Primitive', 'Ancient', 'Medieval', 'Industrial'] as const;

/** Technology needed to enter each era. */
export const ERA_THRESHOLDS = [0, 10, 40, 115];

export enum CellFlag {
  None = 0,
  Land = 1 << 0,
  Coast = 1 << 1,
  Ruins = 1 << 2,
}

export enum CollapseKind {
  Fragmentation = 'fragmentation',
  Wasteland = 'wasteland',
  Conquest = 'conquest',
}

export enum CrisisKind {
  Famine = 'famine',
  Plague = 'plague',
  CivilWar = 'civil-war',
  Ecological = 'ecological',
}

export type EventKind =
  | 'founded'
  | 'era'
  | 'settlement'
  | 'crisis'
  | 'war'
  | 'peace'
  | 'conquest'
  | 'collapse'
  | 'succession'
  | 'religion-born'
  | 'schism'
  | 'culture-born'
  | 'resettled'
  | 'wonder'
  | 'golden-age';

/**
 * A structured record of something a person would notice.
 *
 * Deliberately structured rather than pre-rendered text: the chronicle renders
 * these through a template grammar at display time, which keeps the event log
 * small, keeps it translatable, and keeps the simulation free of prose.
 */
export interface SimEvent {
  tick: number;
  kind: EventKind;
  /** How much this deserves to interrupt the player, 0..1. */
  weight: number;
  polity?: number;
  otherPolity?: number;
  culture?: number;
  religion?: number;
  cell?: number;
  /** Free numeric payload, meaning depends on `kind`. */
  value?: number;
  /** Secondary payload, e.g. successor count. */
  count?: number;
  detail?: string;
}

export interface Culture {
  id: number;
  name: string;
  parent: number;
  born: number;
  died: number;
  /** Drives naming and a mild bias in the policies its polities favour. */
  seed: number;
}

export interface Religion {
  id: number;
  name: string;
  parent: number;
  born: number;
  died: number;
  /** Low tolerance makes schisms and religious unrest more likely. */
  tolerance: number;
  fervour: number;
  seed: number;
}

/**
 * A great work.
 *
 * Deliberately owned by the *cell*, not by the settlement or the state that
 * paid for it. That is the whole point of a wonder: it outlives both. A city
 * that empties leaves its ziggurat standing over the ruins, and a resettlement
 * nine centuries later inherits it — which is exactly the kind of thing a
 * player should be able to find and wonder about.
 */
export interface Wonder {
  cell: number;
  /** Index into the era's catalogue; the renderer maps it to a model. */
  kind: string;
  built: number;
  /** Who built it. May be long dead. */
  builder: number;
  /** The polity's name at the time, kept because the polity may be gone. */
  builderName: string;
  name: string;
}

export interface Settlement {
  cell: number;
  polity: number;
  founded: number;
  /** 0 hamlet … 5 metropolis. */
  tier: number;
  population: number;
  name: string;
}

export interface Polity {
  id: number;
  name: string;
  culture: number;
  religion: number;
  founded: number;
  ended: number;
  alive: boolean;
  capital: number;
  /** Hue in [0, 1), used for territory colour. */
  hue: number;

  treasury: number;
  tech: number;
  era: Era;
  /** 0 collapse, 1 content. */
  stability: number;
  /** How accepted the current regime is; low after a succession. */
  legitimacy: number;
  warWeariness: number;

  policies: Float32Array;

  /**
   * Cached each tick by the population phase, so the rest of the tick never
   * has to sweep every cell again per polity.
   */
  cellCount: number;
  population: number;
  /** Total population the polity's land can currently support. */
  capacity: number;
  /** Mean pollution across its land. */
  pollution: number;
  /** Polity id it is at war with, or -1. */
  atWarWith: number;
  warSince: number;
  /** Successor polities inherit this to keep the chronicle's threads legible. */
  predecessor: number;
}

export interface WorldSnapshot {
  tick: number;
  cellCount: number;
  owner: Uint16Array;
  population: Float32Array;
  polities: Polity[];
  settlements: Settlement[];
}

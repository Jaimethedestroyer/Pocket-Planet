/**
 * How a town looks, given who built it and when.
 *
 * Two inputs, and they do different jobs. The **era** decides what the town is
 * made of — what shapes exist at all, how the streets run, what the roads are
 * paved with. That is the axis the player is meant to read: a settlement should
 * announce its age from a hundred metres up without a label. The **culture**
 * only shifts the palette and a couple of proportions, because two neighbouring
 * kingdoms in the same century should look related, not alien.
 *
 * Everything here is derived, not authored per culture. There is no table of
 * civilizations, because the simulation generates cultures endlessly and any
 * table would run out.
 */

import { Era } from '../../sim/types';
import { hashSeed, makeRng } from '../../core/rng';
import type { ArchetypeName } from './archetypes';

export type Rgb = [number, number, number];

export interface Weighted {
  name: ArchetypeName;
  weight: number;
}

export interface TownStyle {
  era: Era;
  /** Ordinary dwellings, drawn by weight. */
  houses: Weighted[];
  /** Working buildings, scattered at the edge of the built area. */
  works: Weighted[];
  /** One civic building near the centre of a town of any size. */
  civic: ArchetypeName[];
  /** The great work: only capitals and metropolises get one. */
  monuments: ArchetypeName[];
  /** Palette ranges. A building samples between the two ends. */
  wallA: Rgb;
  wallB: Rgb;
  roofA: Rgb;
  roofB: Rgb;
  road: Rgb;
  /** Metres. Widens with the era. */
  roadWidth: number;
  /** How tightly buildings pack along a street, in metres of frontage. */
  frontage: number;
  /** Street layout. */
  layout: 'cluster' | 'grid' | 'organic' | 'avenue';
  /** How far the town's built area reaches, as a multiple of the tier radius. */
  spread: number;
  /** Window emission at night, 0..1. A primitive town is nearly dark. */
  lamps: number;
  /** How strongly walls read as courses of a block material, 0..1. */
  courses: number;
}

const BASE: Record<Era, Omit<TownStyle, 'era'>> = {
  [Era.Primitive]: {
    houses: [
      { name: 'hut', weight: 7 },
      { name: 'longhut', weight: 2 },
      { name: 'granary', weight: 2 },
    ],
    works: [
      { name: 'granary', weight: 3 },
      { name: 'well', weight: 1 },
    ],
    civic: ['greathall', 'well'],
    monuments: ['stonecircle', 'greathall'],
    wallA: [0.30, 0.24, 0.17],
    wallB: [0.45, 0.37, 0.26],
    roofA: [0.46, 0.36, 0.17],
    roofB: [0.66, 0.55, 0.28],
    road: [0.29, 0.23, 0.16],
    roadWidth: 2.6,
    frontage: 8.5,
    layout: 'cluster',
    spread: 0.72,
    lamps: 0.30,
    courses: 0.12,
  },
  [Era.Ancient]: {
    houses: [
      { name: 'mudhouse', weight: 7 },
      { name: 'courtyard', weight: 3 },
      { name: 'hut', weight: 1 },
    ],
    works: [
      { name: 'granary', weight: 2 },
      { name: 'stall', weight: 3 },
      { name: 'well', weight: 1 },
    ],
    civic: ['temple', 'obelisk', 'well'],
    monuments: ['ziggurat', 'temple', 'colossus', 'obelisk'],
    wallA: [0.52, 0.46, 0.35],
    wallB: [0.76, 0.70, 0.56],
    // Dusty flat mud at one end, fired terracotta at the other: this era has
    // both, and the range has to cover them because it is one palette.
    roofA: [0.40, 0.35, 0.27],
    roofB: [0.66, 0.36, 0.23],
    road: [0.48, 0.43, 0.34],
    roadWidth: 4.0,
    frontage: 9.5,
    layout: 'grid',
    spread: 0.85,
    lamps: 0.52,
    courses: 0.55,
  },
  [Era.Medieval]: {
    houses: [
      { name: 'cottage', weight: 5 },
      { name: 'timberhouse', weight: 5 },
      { name: 'shophouse', weight: 3 },
    ],
    works: [
      { name: 'workshop', weight: 4 },
      { name: 'windmill', weight: 2 },
      { name: 'stall', weight: 3 },
      { name: 'well', weight: 1 },
      { name: 'watchtower', weight: 1 },
    ],
    civic: ['watchtower', 'well', 'windmill'],
    monuments: ['cathedral', 'keep', 'colossus'],
    wallA: [0.50, 0.46, 0.39],
    wallB: [0.75, 0.71, 0.62],
    roofA: [0.33, 0.21, 0.16],
    roofB: [0.58, 0.31, 0.20],
    road: [0.31, 0.29, 0.27],
    roadWidth: 4.6,
    frontage: 8.0,
    layout: 'organic',
    spread: 1.0,
    lamps: 0.72,
    courses: 0.7,
  },
  [Era.Industrial]: {
    houses: [
      { name: 'terrace', weight: 6 },
      { name: 'tenement', weight: 4 },
      { name: 'shophouse', weight: 2 },
    ],
    works: [
      { name: 'factory', weight: 3 },
      { name: 'warehouse', weight: 4 },
      { name: 'station', weight: 1 },
    ],
    civic: ['clocktower', 'station', 'warehouse'],
    monuments: ['clocktower', 'station', 'colossus'],
    wallA: [0.24, 0.15, 0.12],
    wallB: [0.46, 0.28, 0.20],
    roofA: [0.20, 0.21, 0.24],
    roofB: [0.36, 0.37, 0.41],
    road: [0.16, 0.16, 0.18],
    roadWidth: 6.2,
    frontage: 7.0,
    layout: 'avenue',
    spread: 1.25,
    lamps: 1.0,
    courses: 1.0,
  },
};

function tint(c: Rgb, r: number, g: number, b: number): Rgb {
  return [
    Math.min(1, Math.max(0.02, c[0] * r)),
    Math.min(1, Math.max(0.02, c[1] * g)),
    Math.min(1, Math.max(0.02, c[2] * b)),
  ];
}

const styleCache = new Map<string, TownStyle>();

/**
 * The style for one culture in one era.
 *
 * The tint is deliberately narrow — a fifth either way on each channel. Wider,
 * and neighbouring towns stop looking like the same century; narrower, and a
 * culture stops having a look at all. It is applied more strongly to roofs than
 * to walls, because roofs are what you see from above, which is where the
 * player spends most of their time.
 */
export function townStyle(era: Era, cultureName: string): TownStyle {
  const key = `${era}/${cultureName}`;
  const hit = styleCache.get(key);
  if (hit) return hit;

  const rng = makeRng(hashSeed(cultureName || 'nameless'));
  const base = BASE[era] ?? BASE[Era.Primitive];

  const wr = 0.86 + rng.next() * 0.28;
  const wg = 0.88 + rng.next() * 0.24;
  const wb = 0.82 + rng.next() * 0.34;
  const rr = 0.80 + rng.next() * 0.42;
  const rg = 0.84 + rng.next() * 0.32;
  const rb = 0.78 + rng.next() * 0.40;

  const style: TownStyle = {
    ...base,
    era,
    wallA: tint(base.wallA, wr, wg, wb),
    wallB: tint(base.wallB, wr, wg, wb),
    roofA: tint(base.roofA, rr, rg, rb),
    roofB: tint(base.roofB, rr, rg, rb),
    frontage: base.frontage * (0.9 + rng.next() * 0.24),
    spread: base.spread * (0.9 + rng.next() * 0.22),
  };
  styleCache.set(key, style);
  return style;
}

/** Draw an archetype from a weighted list. */
export function pickWeighted(list: Weighted[], r: number): ArchetypeName {
  let total = 0;
  for (const item of list) total += item.weight;
  let t = r * total;
  for (const item of list) {
    t -= item.weight;
    if (t <= 0) return item.name;
  }
  return list[list.length - 1].name;
}

/** Interpolate between the two ends of a palette range. */
export function samplePalette(a: Rgb, b: Rgb, t: number, jitter = 0): Rgb {
  const j = 1 + jitter;
  return [
    Math.min(1, (a[0] + (b[0] - a[0]) * t) * j),
    Math.min(1, (a[1] + (b[1] - a[1]) * t) * j),
    Math.min(1, (a[2] + (b[2] - a[2]) * t) * j),
  ];
}

/**
 * The simulation.
 *
 * One tick is one year. Every phase is an ordered pass over plain arrays, and
 * every random draw comes from a single seeded generator advanced in a fixed
 * sequence — so a world is completely described by its seed plus the list of
 * times the player moved a dial. That is what makes saves tiny, worlds
 * shareable, and the balance harness in `tools/soak.ts` possible at all.
 *
 * There are no citizen agents. Population is a scalar per cell. The people you
 * see walking about are drawn by the renderer from these numbers, which is what
 * lets a century of absence resolve in milliseconds.
 */

import { makeRng, mixSeed } from '../core/rng';
import type { Rng } from '../core/rng';
import { PlanetField } from '../planet/heightfield';
import { buildCellGraph, cellDistance, NEIGHBOURS } from './world';
import type { CellGraph } from './world';
import { NameGenerator } from './names';
import {
  CellFlag,
  CollapseKind,
  CrisisKind,
  Era,
  ERA_THRESHOLDS,
  POLICY_BUDGET,
  POLICY_COUNT,
} from './types';
import type { Culture, Polity, Religion, Settlement, SimEvent } from './types';

/* ------------------------------------------------------------------ tuning */

/** People a perfectly habitable cell supports with no technology. */
const BASE_CAPACITY = 900;
const GROWTH_RATE = 0.022;
/** Population at which a cell counts as a settlement. */
const SETTLEMENT_THRESHOLD = 420;
const SETTLEMENT_TIERS = [420, 2200, 8000, 26000, 72000, 180000];

const POLICY_INDEX = {
  trade: 0,
  war: 1,
  education: 2,
  expansion: 3,
  conservation: 4,
  culture: 5,
} as const;

export interface SimOptions {
  seed: number;
  /** Cells in the simulation graph. Not drawn; see world.ts. */
  cellCount?: number;
  /** Civilizations seeded at the start of history. */
  startingPolities?: number;
}

export interface SimStats {
  tick: number;
  livingPolities: number;
  population: number;
  settlements: number;
  maxTech: number;
  maxEra: Era;
  collapses: number;
  wars: number;
}

export class Simulation {
  readonly graph: CellGraph;
  readonly seed: number;

  tick = 0;

  // --- Per-cell state ----------------------------------------------------
  owner: Uint16Array;
  population: Float32Array;
  development: Float32Array;
  fertility: Float32Array;
  pollution: Float32Array;
  cultureOf: Uint16Array;
  religionOf: Uint16Array;
  cellFlags: Uint8Array;

  polities: Polity[] = [];
  cultures: Culture[] = [];
  religions: Religion[] = [];
  settlements: Settlement[] = [];
  events: SimEvent[] = [];

  /** Which polity the player influences. */
  playerPolity = 0;

  collapseCount = 0;
  warCount = 0;

  private rng: Rng;
  private names = new Map<number, NameGenerator>();
  private lowStabilityYears = new Map<number, number>();
  /** Tick each polity last suffered a crisis, so shocks do not stack. */
  private lastCrisis = new Map<number, number>();
  /** Reused scratch so the tick loop allocates nothing. */
  private scratch: number[] = [];
  /** Tick each cell first became a settlement, or -1. */
  private settledAt: Int32Array;
  private settlementNames = new Map<number, string>();
  /** Cells held by each polity, rebuilt once per tick. */
  private polityCells: number[][] = [];

  constructor(opts: SimOptions) {
    this.seed = opts.seed >>> 0;
    const cellCount = opts.cellCount ?? 4096;
    const field = new PlanetField(this.seed);
    this.graph = buildCellGraph(field, cellCount);

    this.owner = new Uint16Array(cellCount);
    this.population = new Float32Array(cellCount);
    this.development = new Float32Array(cellCount);
    this.fertility = new Float32Array(cellCount).fill(1);
    this.pollution = new Float32Array(cellCount);
    this.cultureOf = new Uint16Array(cellCount);
    this.religionOf = new Uint16Array(cellCount);
    this.cellFlags = this.graph.flags.slice();
    this.settledAt = new Int32Array(cellCount).fill(-1);

    this.rng = makeRng(mixSeed(this.seed, 0x5eed));
    this.seedCivilizations(opts.startingPolities ?? 3);
  }

  /* --------------------------------------------------------------- setup */

  private nameGen(cultureId: number): NameGenerator {
    let gen = this.names.get(cultureId);
    if (!gen) {
      gen = new NameGenerator(this.cultures[cultureId].seed);
      this.names.set(cultureId, gen);
    }
    return gen;
  }

  private createCulture(parent: number): Culture {
    const culture: Culture = {
      id: this.cultures.length,
      name: '',
      parent,
      born: this.tick,
      died: -1,
      seed: this.rng.int(0, 0x7fffffff),
    };
    this.cultures.push(culture);
    culture.name = this.nameGen(culture.id).culture();
    return culture;
  }

  private createReligion(parent: number, cultureId: number): Religion {
    const religion: Religion = {
      id: this.religions.length,
      name: '',
      parent,
      born: this.tick,
      died: -1,
      tolerance: this.rng.range(0.2, 0.9),
      fervour: this.rng.range(0.25, 0.85),
      seed: this.rng.int(0, 0x7fffffff),
    };
    this.religions.push(religion);
    religion.name = this.nameGen(cultureId).religion();
    return religion;
  }

  private seedCivilizations(count: number): void {
    // Start on the most habitable cells that are far enough apart to have
    // separate histories rather than one shared border war from year one.
    const candidates = Array.from(this.graph.landCells)
      .filter((c) => this.graph.habitability[c] > 0.42)
      .sort((a, b) => this.graph.habitability[b] - this.graph.habitability[a]);

    const chosen: number[] = [];
    const minSeparation = 900;
    for (const cell of candidates) {
      if (chosen.length >= count) break;
      if (chosen.every((c) => cellDistance(this.graph, c, cell) > minSeparation)) {
        chosen.push(cell);
      }
    }
    // Relax the spacing rather than start fewer civilizations on a cramped map.
    for (const cell of candidates) {
      if (chosen.length >= count) break;
      if (!chosen.includes(cell)) chosen.push(cell);
    }

    for (const cell of chosen) {
      const culture = this.createCulture(-1);
      const religion = this.createReligion(-1, culture.id);
      const polity = this.createPolity(cell, culture.id, religion.id, -1);
      this.claim(cell, polity.id);
      this.population[cell] = 240;
      this.emit({ tick: 0, kind: 'founded', weight: 0.5, polity: polity.id, cell });
    }
    this.playerPolity = this.polities.length > 0 ? this.polities[0].id : 0;
  }

  private createPolity(
    capital: number,
    culture: number,
    religion: number,
    predecessor: number,
  ): Polity {
    const policies = new Float32Array(POLICY_COUNT);
    // A starting spread with a cultural bias, so civilizations do not all
    // behave identically before the player has touched anything.
    const bias = makeRng(mixSeed(this.cultures[culture].seed, this.polities.length));
    let total = 0;
    for (let i = 0; i < POLICY_COUNT; i++) {
      policies[i] = 0.5 + bias.next();
      total += policies[i];
    }
    for (let i = 0; i < POLICY_COUNT; i++) policies[i] = (policies[i] / total) * POLICY_BUDGET;

    const polity: Polity = {
      id: this.polities.length,
      name: '',
      culture,
      religion,
      founded: this.tick,
      ended: -1,
      alive: true,
      capital,
      hue: bias.next(),
      treasury: 40,
      tech: 0,
      era: Era.Primitive,
      stability: 0.72,
      legitimacy: predecessor >= 0 ? 0.4 : 0.85,
      warWeariness: 0,
      policies,
      cellCount: 0,
      population: 0,
      capacity: 0,
      pollution: 0,
      atWarWith: -1,
      warSince: -1,
      predecessor,
    };
    this.polities.push(polity);
    polity.name = this.nameGen(culture).polity(polity.era, 1);
    return polity;
  }

  /** Polity ids are stored plus one so that zero can mean unclaimed. */
  private claim(cell: number, polityId: number): void {
    this.owner[cell] = polityId + 1;
    const p = this.polities[polityId];
    this.cultureOf[cell] = p.culture;
    this.religionOf[cell] = p.religion;
  }

  private ownerOf(cell: number): number {
    return this.owner[cell] - 1;
  }

  /**
   * The only way stability is allowed to change outside its own phase.
   *
   * Crises and schisms run after the stability phase has already clamped, so
   * subtracting from the field directly lets it go negative — which it did,
   * and which the soak harness caught before it ever reached a player.
   */
  private adjustStability(polity: Polity, delta: number): void {
    polity.stability = Math.max(0, Math.min(1, polity.stability + delta));
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
    // The log is the save file; keep it from growing without bound over the
    // tens of thousands of years a planet can run.
    if (this.events.length > 4000) this.events.splice(0, 1000);
  }

  /* ---------------------------------------------------------------- tick */

  step(): void {
    this.tick++;

    this.phaseEnvironment();
    this.phasePopulation();
    this.phaseExpansion();
    this.phaseSettlements();
    this.phaseEconomy();
    this.phaseKnowledge();
    this.phaseCulture();
    this.phaseStability();
    this.phaseWar();
    this.phaseCrisis();
    this.phaseCollapse();
  }

  /** Advance many ticks. Used for offline catch-up and by the soak harness. */
  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  /* -------------------------------------------------------------- phases */

  private phaseEnvironment(): void {
    const land = this.graph.landCells;
    for (let i = 0; i < land.length; i++) {
      const c = land[i];
      const pop = this.population[c];
      if (pop > 0) {
        const owner = this.ownerOf(c);
        const conservation = owner >= 0 ? this.polities[owner].policies[POLICY_INDEX.conservation] : 1;
        const cap = this.capacityOf(c);
        // Working land harder than it can bear wears it out; conservation
        // policy and low density let it come back.
        const strain = cap > 0 ? pop / cap : 0;
        const wear = Math.max(0, strain - 0.55) * 0.006;
        const recovery = 0.0035 * (0.4 + conservation * 0.28);
        this.fertility[c] = Math.max(0.25, Math.min(1, this.fertility[c] - wear + recovery));

        const era = owner >= 0 ? this.polities[owner].era : Era.Primitive;
        if (era >= Era.Industrial) {
          this.pollution[c] = Math.min(1, this.pollution[c] + strain * 0.004 * (1.4 - conservation * 0.2));
        }
      }
      this.pollution[c] = Math.max(0, this.pollution[c] - 0.0016);
    }
  }

  private capacityOf(cell: number): number {
    const owner = this.ownerOf(cell);
    const tech = owner >= 0 ? this.polities[owner].tech : 0;
    const base = this.graph.habitability[cell] * BASE_CAPACITY;
    const techBonus = 1 + tech * 0.055;
    const pollutionPenalty = 1 - this.pollution[cell] * 0.55;
    return base * techBonus * this.fertility[cell] * pollutionPenalty * (1 + this.development[cell] * 0.4);
  }

  private phasePopulation(): void {
    const land = this.graph.landCells;
    while (this.polityCells.length < this.polities.length) this.polityCells.push([]);
    for (const p of this.polities) {
      p.population = 0;
      p.cellCount = 0;
      p.capacity = 0;
      p.pollution = 0;
      this.polityCells[p.id].length = 0;
    }

    for (let i = 0; i < land.length; i++) {
      const c = land[i];
      const owner = this.ownerOf(c);
      if (owner < 0) {
        // Unclaimed land still drifts back towards emptiness.
        if (this.population[c] > 0) this.population[c] *= 0.985;
        continue;
      }
      const polity = this.polities[owner];
      const cap = this.capacityOf(c);
      let pop = this.population[c];

      if (cap <= 1) {
        pop *= 0.96;
      } else {
        const r = GROWTH_RATE * (0.45 + polity.stability * 0.75);
        pop += pop * r * (1 - pop / cap);
        // Starvation bites harder than growth helps.
        if (pop > cap) pop -= (pop - cap) * 0.22;
        if (pop < 1 && cap > 20) pop = 1;
      }
      this.population[c] = Math.max(0, pop);

      // Development is infrastructure: slow to build, slow to lose.
      const target = Math.min(1, pop / Math.max(1, cap));
      this.development[c] += (target - this.development[c]) * 0.01;

      polity.population += this.population[c];
      polity.capacity += cap;
      polity.pollution += this.pollution[c];
      polity.cellCount++;
      this.polityCells[owner].push(c);
    }

    for (const p of this.polities) {
      if (p.cellCount > 0) p.pollution /= p.cellCount;
    }
  }

  private phaseExpansion(): void {
    for (const polity of this.polities) {
      if (!polity.alive || polity.cellCount === 0) continue;

      const expansion = polity.policies[POLICY_INDEX.expansion];
      // Crowding is what actually drives expansion; policy sets the appetite.
      const pressure = this.pressureOf(polity);
      const chance = pressure * expansion * 0.08 * polity.stability;
      if (this.rng.next() > chance) continue;
      if (polity.treasury < 12) continue;

      const target = this.bestFrontierCell(polity);
      if (target < 0) continue;

      this.claim(target, polity.id);
      this.population[target] = Math.max(this.population[target], 60);
      polity.treasury -= 12;
    }
  }

  /** How full a polity's existing land is, 0..1+. */
  private pressureOf(polity: Polity): number {
    return polity.capacity > 0 ? Math.min(1.4, polity.population / polity.capacity) : 0;
  }

  /** The most attractive unclaimed cell adjacent to a polity's territory. */
  private bestFrontierCell(polity: Polity): number {
    const held = this.polityCells[polity.id];
    let best = -1;
    let bestScore = 0.02;
    for (let i = 0; i < held.length; i++) {
      const c = held[i];
      for (let k = 0; k < NEIGHBOURS; k++) {
        const n = this.graph.neighbours[c * NEIGHBOURS + k];
        if (n < 0) continue;
        if (!(this.cellFlags[n] & CellFlag.Land)) continue;
        if (this.owner[n] !== 0) continue;
        // Distance from the capital is a real cost: sprawl destabilises.
        const reach = 1 - Math.min(0.85, cellDistance(this.graph, polity.capital, n) / 2600);
        let score = this.graph.habitability[n] * reach;
        // Old ruins are worth resettling: cleared land and salvage.
        if (this.cellFlags[n] & CellFlag.Ruins) score *= 1.35;
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
    }
    return best;
  }

  private phaseSettlements(): void {
    // Rebuild rather than patch: the list is small and this keeps settlement
    // state impossible to desynchronise from cell population.
    this.settlements.length = 0;
    const land = this.graph.landCells;
    for (let i = 0; i < land.length; i++) {
      const c = land[i];
      const pop = this.population[c];
      if (pop < SETTLEMENT_THRESHOLD) {
        // Below half the founding threshold the place is genuinely gone, and
        // becomes ruins for someone else to find.
        if (this.settledAt[c] >= 0 && pop < SETTLEMENT_THRESHOLD * 0.5) {
          this.settledAt[c] = -1;
          this.cellFlags[c] |= CellFlag.Ruins;
        }
        continue;
      }
      const owner = this.ownerOf(c);
      if (owner < 0) continue;

      let tier = 0;
      for (let t = SETTLEMENT_TIERS.length - 1; t >= 0; t--) {
        if (pop >= SETTLEMENT_TIERS[t]) {
          tier = t;
          break;
        }
      }

      // A place keeps its name and its founding date even as the list around
      // it is rebuilt, and even if it is later abandoned and resettled.
      let name = this.settlementNames.get(c);
      if (this.settledAt[c] < 0) {
        this.settledAt[c] = this.tick;
        name = this.nameGen(this.cultureOf[c]).settlement();
        this.settlementNames.set(c, name);
        this.emit({
          tick: this.tick,
          kind: (this.cellFlags[c] & CellFlag.Ruins) !== 0 ? 'resettled' : 'settlement',
          weight: 0.25,
          polity: owner,
          cell: c,
          detail: name,
        });
        this.cellFlags[c] &= ~CellFlag.Ruins;
      }

      this.settlements.push({
        cell: c,
        polity: owner,
        founded: this.settledAt[c],
        tier,
        population: pop,
        name: name ?? '',
      });
    }
  }

  private phaseEconomy(): void {
    for (const polity of this.polities) {
      if (!polity.alive) continue;
      const trade = polity.policies[POLICY_INDEX.trade];
      const war = polity.policies[POLICY_INDEX.war];

      const income = polity.population * 0.00042 * (0.6 + trade * 0.55) * (1 + polity.tech * 0.008);
      const upkeep = polity.cellCount * 0.32 * (1 + war * 0.22) + polity.population * 0.00012;
      polity.treasury += income - upkeep;
      if (polity.treasury > 4000) polity.treasury = 4000;
      if (polity.treasury < -600) polity.treasury = -600;
    }
  }

  private phaseKnowledge(): void {
    for (const polity of this.polities) {
      if (!polity.alive || polity.population < 1) continue;
      const education = polity.policies[POLICY_INDEX.education];
      const trade = polity.policies[POLICY_INDEX.trade];

      // Square-rooted population: ten times the people is not ten times the
      // discoveries, and without the damping the largest empire runs away with
      // history within a few centuries.
      const scholars = Math.sqrt(polity.population / 1000);
      const gain =
        scholars *
        (0.12 + education * 0.28) *
        (0.35 + polity.stability * 0.65) *
        (1 + trade * 0.06) *
        0.024;
      polity.tech += gain;

      const era = eraForTech(polity.tech);
      if (era > polity.era) {
        polity.era = era;
        polity.name = this.nameGen(polity.culture).polity(era, polity.cellCount);
        this.emit({
          tick: this.tick,
          kind: 'era',
          weight: 0.7,
          polity: polity.id,
          value: era,
        });
      }
    }
  }

  private phaseCulture(): void {
    // Cultures and religions spread across the graph independently of who owns
    // what. This is the mechanism that lets a dead empire's faith outlive it.
    const land = this.graph.landCells;
    for (let i = 0; i < land.length; i++) {
      const c = land[i];
      if (this.population[c] < 40) continue;
      const owner = this.ownerOf(c);
      if (owner < 0) continue;
      const polity = this.polities[owner];
      const culturePolicy = polity.policies[POLICY_INDEX.culture];

      if (this.rng.next() > 0.02 * culturePolicy) continue;

      const k = this.rng.int(0, NEIGHBOURS);
      const n = this.graph.neighbours[c * NEIGHBOURS + k];
      if (n < 0 || !(this.cellFlags[n] & CellFlag.Land)) continue;
      if (this.population[n] < 20) continue;

      // A more populous, more fervent neighbour converts the smaller one.
      if (this.population[c] > this.population[n] * 1.4) {
        this.cultureOf[n] = this.cultureOf[c];
        const faith = this.religions[this.religionOf[c]];
        if (this.rng.next() < faith.fervour * 0.5) this.religionOf[n] = this.religionOf[c];
      }
    }

    // Schism: an intolerant faith in a large, unstable polity splits.
    for (const polity of this.polities) {
      if (!polity.alive || polity.cellCount < 12) continue;
      const faith = this.religions[polity.religion];
      const risk = (1 - faith.tolerance) * (1 - polity.stability) * 0.0016;
      if (this.rng.next() < risk) {
        const born = this.createReligion(faith.id, polity.culture);
        polity.religion = born.id;
        this.adjustStability(polity, -0.12);
        this.emit({
          tick: this.tick,
          kind: 'schism',
          weight: 0.55,
          polity: polity.id,
          religion: born.id,
        });
      }
    }
  }

  private phaseStability(): void {
    for (const polity of this.polities) {
      if (!polity.alive) continue;

      const culture = polity.policies[POLICY_INDEX.culture];
      const education = polity.policies[POLICY_INDEX.education];

      // Beyond what its technology can administer, an empire frays.
      const administrable = 10 + polity.tech * 0.35;
      const overextension = Math.max(0, polity.cellCount / administrable - 1);

      const pressure = this.pressureOf(polity);
      const hunger = Math.max(0, pressure - 0.9);
      const broke = polity.treasury < 0 ? Math.min(1, -polity.treasury / 400) : 0;

      // Dynastic fatigue. Institutions that have not been renewed in centuries
      // stop commanding obedience. Without a term like this nothing ever ends:
      // a well-run empire simply accumulates forever and the planet's history
      // becomes one uninterrupted success story, which is the least
      // interesting thing a civilization simulation can produce.
      const age = this.tick - polity.founded;
      const fatigue = Math.min(0.3, (age / 1400) * 0.3);

      let target = 0.7;
      target += culture * 0.07 + education * 0.03;
      target -= overextension * 0.5;
      target -= polity.warWeariness * 0.5;
      target -= hunger * 1.1;
      target -= (1 - polity.legitimacy) * 0.24;
      target -= broke * 0.3;
      target -= fatigue;

      polity.stability += (target - polity.stability) * 0.06;
      polity.stability = Math.max(0, Math.min(1, polity.stability));
      polity.legitimacy = Math.min(1, polity.legitimacy + 0.004);
      polity.warWeariness = Math.max(0, polity.warWeariness - (polity.atWarWith < 0 ? 0.012 : 0));
    }
  }

  private militaryStrength(polity: Polity): number {
    return (
      Math.sqrt(polity.population + 1) *
      (0.5 + polity.policies[POLICY_INDEX.war] * 0.7) *
      (1 + polity.tech * 0.02) *
      (0.4 + polity.stability * 0.6)
    );
  }

  private phaseWar(): void {
    for (const polity of this.polities) {
      if (!polity.alive) continue;

      if (polity.atWarWith >= 0) {
        const enemy = this.polities[polity.atWarWith];
        if (!enemy.alive) {
          polity.atWarWith = -1;
          continue;
        }
        polity.warWeariness = Math.min(1, polity.warWeariness + 0.014);
        polity.treasury -= 1.5 + polity.cellCount * 0.05;

        // Only the attacker's side of the pair resolves, so a war is not
        // fought twice per tick.
        if (polity.id < enemy.id) {
          const a = this.militaryStrength(polity);
          const b = this.militaryStrength(enemy);
          const odds = a / (a + b);
          if (this.rng.next() < 0.14) {
            const winner = this.rng.next() < odds ? polity : enemy;
            const loser = winner === polity ? enemy : polity;
            const cell = this.borderCell(winner, loser);
            if (cell >= 0) {
              this.claim(cell, winner.id);
              this.population[cell] *= 0.6;
              loser.legitimacy = Math.max(0, loser.legitimacy - 0.05);
            }
          }
          // Wars end when someone can no longer afford them.
          const exhausted =
            polity.warWeariness > 0.72 ||
            enemy.warWeariness > 0.72 ||
            polity.treasury < -300 ||
            enemy.treasury < -300;
          if (exhausted) {
            polity.atWarWith = -1;
            enemy.atWarWith = -1;
            this.emit({
              tick: this.tick,
              kind: 'peace',
              weight: 0.45,
              polity: polity.id,
              otherPolity: enemy.id,
              value: this.tick - polity.warSince,
            });
          }
        }
        continue;
      }

      // Declaring war: appetite from policy, opportunity from a shared border.
      const appetite = polity.policies[POLICY_INDEX.war] * polity.stability * 0.011;
      if (this.rng.next() > appetite) continue;
      const neighbourId = this.findNeighbourPolity(polity);
      if (neighbourId < 0) continue;
      const other = this.polities[neighbourId];
      if (other.atWarWith >= 0) continue;

      polity.atWarWith = other.id;
      other.atWarWith = polity.id;
      polity.warSince = this.tick;
      other.warSince = this.tick;
      this.warCount++;
      this.emit({
        tick: this.tick,
        kind: 'war',
        weight: 0.6,
        polity: polity.id,
        otherPolity: other.id,
      });
    }
  }

  private findNeighbourPolity(polity: Polity): number {
    const held = this.polityCells[polity.id];
    for (let i = 0; i < held.length; i++) {
      const c = held[i];
      for (let k = 0; k < NEIGHBOURS; k++) {
        const n = this.graph.neighbours[c * NEIGHBOURS + k];
        if (n < 0) continue;
        const o = this.ownerOf(n);
        if (o >= 0 && o !== polity.id && this.polities[o].alive) return o;
      }
    }
    return -1;
  }

  /** A cell of `loser` that borders `winner`. */
  private borderCell(winner: Polity, loser: Polity): number {
    const held = this.polityCells[loser.id];
    for (let i = 0; i < held.length; i++) {
      const c = held[i];
      for (let k = 0; k < NEIGHBOURS; k++) {
        const n = this.graph.neighbours[c * NEIGHBOURS + k];
        if (n >= 0 && this.ownerOf(n) === winner.id) return c;
      }
    }
    return -1;
  }

  private phaseCrisis(): void {
    for (const polity of this.polities) {
      if (!polity.alive || polity.cellCount === 0) continue;

      const pressure = this.pressureOf(polity);
      const density = polity.population / Math.max(1, polity.cellCount);

      // Every crisis is derived from the state that caused it, never from a
      // bare random draw. A famine has to be earned by overpopulation.
      const famine = Math.max(0, pressure - 0.96) * 0.55;
      const plague = Math.min(0.035, (density / 9000) * polity.policies[POLICY_INDEX.trade] * 0.004);
      const civilWar = Math.max(0, 0.45 - polity.stability) * 0.045;
      const ecological =
        polity.era >= Era.Industrial ? polity.pollution * 0.03 : 0;

      // A civilization needs time to reel. Without a cooldown the same polity
      // draws three civil wars in a decade, which reads as a stuck loop rather
      // than as a troubled century.
      const since = this.tick - (this.lastCrisis.get(polity.id) ?? -999);
      if (since < 18) continue;

      const roll = this.rng.next();
      if (roll < famine) this.applyCrisis(polity, CrisisKind.Famine, 0.22);
      else if (roll < famine + plague) this.applyCrisis(polity, CrisisKind.Plague, 0.3);
      else if (roll < famine + plague + civilWar) this.applyCrisis(polity, CrisisKind.CivilWar, 0.14);
      else if (roll < famine + plague + civilWar + ecological) {
        this.applyCrisis(polity, CrisisKind.Ecological, 0.12);
      }
    }
  }

  private applyCrisis(polity: Polity, kind: CrisisKind, severity: number): void {
    this.lastCrisis.set(polity.id, this.tick);
    const held = this.polityCells[polity.id];
    for (let i = 0; i < held.length; i++) {
      const c = held[i];
      this.population[c] *= 1 - severity;
      if (kind === CrisisKind.Ecological) this.fertility[c] = Math.max(0.2, this.fertility[c] - 0.12);
    }
    this.adjustStability(polity, kind === CrisisKind.CivilWar ? -0.3 : -0.18);
    polity.legitimacy = Math.max(0, polity.legitimacy - 0.1);
    this.emit({
      tick: this.tick,
      kind: 'crisis',
      weight: 0.65,
      polity: polity.id,
      detail: kind,
      value: severity,
    });
  }

  private phaseCollapse(): void {
    // Iterate by index over the list as it was at the start of the phase:
    // collapse() appends successor polities, and a for-of loop would walk
    // straight into them and collapse each one on the tick it was born,
    // because its population has not been counted yet.
    const count = this.polities.length;
    for (let i = 0; i < count; i++) {
      const polity = this.polities[i];
      if (!polity.alive) continue;

      const years = polity.stability < 0.08 ? (this.lowStabilityYears.get(polity.id) ?? 0) + 1 : 0;
      this.lowStabilityYears.set(polity.id, years);

      // A bad decade is a crisis; a bad generation is a collapse. Losing all
      // your land or all your people ends things immediately either way.
      //
      // The probabilistic term matters as much as the deterministic one: an
      // empire does not need to bottom out completely to fall, it just needs
      // to be brittle for long enough that something breaks it. Requiring the
      // hard threshold alone left 87% of worlds with no collapse at all.
      const brittleness = Math.max(0, 0.4 - polity.stability);
      const risk = brittleness * brittleness * 0.9;
      const doomed =
        years >= 12 ||
        polity.cellCount === 0 ||
        polity.population < 25 ||
        this.rng.next() < risk;
      if (!doomed) continue;

      this.collapse(polity);
    }
  }

  private collapse(polity: Polity): void {
    const held: number[] = this.scratch;
    held.length = 0;
    for (const c of this.polityCells[polity.id]) held.push(c);

    polity.alive = false;
    polity.ended = this.tick;
    this.collapseCount++;
    this.lowStabilityYears.delete(polity.id);
    if (polity.atWarWith >= 0) {
      const enemy = this.polities[polity.atWarWith];
      if (enemy) enemy.atWarWith = -1;
      polity.atWarWith = -1;
    }

    // Large states fracture into successors. Small ones simply end, and their
    // land reverts to wasteland that someone may resettle in a few centuries.
    const canFragment = held.length >= 8 && polity.population > 900;
    if (!canFragment) {
      for (const c of held) {
        this.owner[c] = 0;
        this.population[c] *= 0.25;
        this.cellFlags[c] |= CellFlag.Ruins;
      }
      // Nothing survives this one, so the player continues with whichever
      // civilization is now the largest on the planet.
      if (this.playerPolity === polity.id) {
        let heir = -1;
        let best = -1;
        for (const p of this.polities) {
          if (p.alive && p.id !== polity.id && p.population > best) {
            best = p.population;
            heir = p.id;
          }
        }
        if (heir >= 0) this.playerPolity = heir;
      }

      this.emit({
        tick: this.tick,
        kind: 'collapse',
        weight: 0.85,
        polity: polity.id,
        detail: CollapseKind.Wasteland,
        count: 0,
      });
      return;
    }

    const successorCount = 2 + (this.rng.next() < 0.4 ? 1 : 0);
    const seeds: number[] = [];
    for (let i = 0; i < successorCount && held.length > 0; i++) {
      // Spread the successor capitals apart so the map reads as rival states
      // rather than as one country with new colours.
      let bestCell = held[this.rng.int(0, held.length)];
      let bestScore = -1;
      for (const c of held) {
        const nearest = seeds.length
          ? Math.min(...seeds.map((s) => cellDistance(this.graph, s, c)))
          : 1e9;
        const score = this.population[c] * Math.min(1, nearest / 700);
        if (score > bestScore) {
          bestScore = score;
          bestCell = c;
        }
      }
      seeds.push(bestCell);
    }

    const successors = seeds.map((cell, index) => {
      // Successors after the first may drift into a daughter culture. Shared
      // ancestry, separate history — which is how a planet ends up with a
      // family of related peoples rather than three eternal ones.
      let culture = polity.culture;
      if (index > 0 && this.rng.next() < 0.4) {
        const daughter = this.createCulture(polity.culture);
        culture = daughter.id;
        this.emit({
          tick: this.tick,
          kind: 'culture-born',
          weight: 0.5,
          culture: daughter.id,
          polity: polity.id,
        });
      }
      const s = this.createPolity(cell, culture, polity.religion, polity.id);
      // Successors inherit a diminished version of what came before.
      s.tech = polity.tech * 0.72;
      s.era = eraForTech(s.tech);
      s.stability = 0.52;
      s.treasury = Math.max(0, polity.treasury / successorCount);
      s.name = this.nameGen(culture).polity(s.era, 1);
      return s;
    });

    for (const c of held) {
      let best = successors[0];
      let bestDist = Infinity;
      for (const s of successors) {
        const d = cellDistance(this.graph, s.capital, c);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      this.claim(c, best.id);
      this.population[c] *= 0.78;
    }

    // Rivals from birth.
    for (const a of successors) {
      for (const b of successors) {
        if (a.id !== b.id) a.legitimacy = 0.35;
      }
    }

    // If the player's civilization is the one that fell, they carry on with its
    // strongest heir. Collapse is a turn in the story, not an ending.
    if (this.playerPolity === polity.id) {
      let heir = successors[0];
      for (const s of successors) if (s.cellCount > heir.cellCount) heir = s;
      this.playerPolity = heir.id;
    }

    this.emit({
      tick: this.tick,
      kind: 'collapse',
      weight: 0.95,
      polity: polity.id,
      detail: CollapseKind.Fragmentation,
      count: successors.length,
    });
    for (const s of successors) {
      this.emit({
        tick: this.tick,
        kind: 'succession',
        weight: 0.4,
        polity: s.id,
        otherPolity: polity.id,
      });
    }
  }

  /* ----------------------------------------------------------- inspection */

  stats(): SimStats {
    let population = 0;
    let living = 0;
    let maxTech = 0;
    let maxEra = Era.Primitive;
    for (const p of this.polities) {
      if (!p.alive) continue;
      living++;
      population += p.population;
      if (p.tech > maxTech) maxTech = p.tech;
      if (p.era > maxEra) maxEra = p.era;
    }
    return {
      tick: this.tick,
      livingPolities: living,
      population,
      settlements: this.settlements.length,
      maxTech,
      maxEra,
      collapses: this.collapseCount,
      wars: this.warCount,
    };
  }

  /**
   * A cheap order-sensitive hash of the whole simulation state.
   *
   * Determinism is not a nice-to-have here: the save format is the seed plus
   * the player's dial changes, and replaying that has to land on exactly the
   * same planet. The soak harness replays a world and compares this.
   */
  hashState(): number {
    let h = 0x811c9dc5;
    const mix = (v: number): void => {
      h ^= Math.round(v * 1000) | 0;
      h = Math.imul(h, 0x01000193);
      h >>>= 0;
    };
    mix(this.tick);
    for (let i = 0; i < this.owner.length; i++) {
      if (this.owner[i] === 0 && this.population[i] === 0) continue;
      mix(i);
      mix(this.owner[i]);
      mix(this.population[i]);
      mix(this.fertility[i]);
    }
    for (const p of this.polities) {
      mix(p.id);
      mix(p.alive ? 1 : 0);
      mix(p.tech);
      mix(p.stability);
      mix(p.treasury);
      mix(p.cellCount);
    }
    mix(this.cultures.length);
    mix(this.religions.length);
    return h >>> 0;
  }

  /** Set a policy dial, renormalising the rest to the fixed budget. */
  setPolicy(polityId: number, index: number, value: number): void {
    const polity = this.polities[polityId];
    if (!polity || !polity.alive) return;
    polity.policies[index] = Math.max(0, Math.min(POLICY_BUDGET, value));
    let total = 0;
    for (let i = 0; i < POLICY_COUNT; i++) total += polity.policies[i];
    if (total <= 0) return;
    for (let i = 0; i < POLICY_COUNT; i++) {
      polity.policies[i] = (polity.policies[i] / total) * POLICY_BUDGET;
    }
  }
}

export function eraForTech(tech: number): Era {
  let era = Era.Primitive;
  for (let i = ERA_THRESHOLDS.length - 1; i >= 0; i--) {
    if (tech >= ERA_THRESHOLDS[i]) {
      era = i as Era;
      break;
    }
  }
  return era;
}

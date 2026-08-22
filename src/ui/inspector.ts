/**
 * Tap to inspect.
 *
 * The one thing standing between a simulation you watch and a place you visit.
 * Everything the game knows was already there — a hundred named towns, their
 * founding dates, who rules them, what they have lived through — and none of it
 * was reachable, because the only way in was six sliders.
 *
 * Picking is two-stage and deliberately not a raycast against geometry. First
 * the tap is tested against the settlements, in *screen space* with a generous
 * radius, because a town is the thing a player is almost always aiming at and a
 * hamlet is four pixels wide. Only if nothing is within reach does it fall back
 * to the ground: ray against the sea sphere for a world direction, then the
 * nearest simulation cell, which is exactly what the invisible cell graph is
 * already for.
 *
 * Sorting matters more than it sounds. Two towns can overlap on screen from
 * orbit, and the one you meant is the nearer, larger one — so candidates are
 * ranked by screen distance weighted by tier, not by raw pixels.
 */

import * as THREE from 'three';
import { PLANET_RADIUS } from '../planet/config';
import { ERA_NAMES } from '../sim/types';
import { polityColor } from '../sim/protocol';
import type { PolityView, RuinView, SettlementView } from '../sim/protocol';
import type { SimClient } from '../game/simClient';
import type { PlanetField } from '../planet/heightfield';

const TIER_NAMES = ['Hamlet', 'Village', 'Town', 'City', 'Great city', 'Metropolis'];

/** How close a tap has to land on a settlement marker, in CSS pixels. */
const TAP_RADIUS = 46;

export type PickKind = 'settlement' | 'ruin' | 'ground';

export interface Pick {
  kind: PickKind;
  /** Simulation cell, always present: everything on this planet is somewhere. */
  cell: number;
  /** Unit direction of the picked point. */
  direction: THREE.Vector3;
  settlement?: SettlementView;
  ruin?: RuinView;
}

function formatPopulation(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/**
 * A biome name from the same three numbers the terrain shader uses.
 *
 * The shader blends continuously and never names anything, which is right for
 * rendering and useless for a label. This picks the nearest name, which is a
 * lossy read of a continuous field and is exactly what a person standing there
 * would do.
 */
function biomeName(height: number, moisture: number, temperature: number): string {
  if (height <= 0) return 'Open water';
  if (height < 2.5) return moisture > 0.6 ? 'Marsh' : 'Shore';
  if (temperature < 0.16) return 'Ice';
  if (temperature < 0.3) return moisture > 0.4 ? 'Taiga' : 'Tundra';
  if (height > 19) return 'High mountain';
  if (temperature > 0.72) {
    if (moisture < 0.24) return 'Desert';
    if (moisture < 0.46) return 'Savanna';
    return 'Rainforest';
  }
  if (moisture < 0.24) return 'Dry steppe';
  if (moisture < 0.5) return 'Grassland';
  if (moisture < 0.75) return 'Woodland';
  return 'Deep forest';
}

export class Inspector {
  readonly root: HTMLDivElement;

  private sim: SimClient;
  private field: PlanetField;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;

  private current: Pick | null = null;
  private titleEl: HTMLElement;
  private metaEl: HTMLElement;
  private bodyEl: HTMLElement;
  private swatchEl: HTMLElement;
  private linesEl: HTMLElement;

  /** Fly the camera somewhere. Set by the app. */
  onGoTo: ((direction: THREE.Vector3, altitude?: number) => void) | null = null;

  private worldScratch = new THREE.Vector3();
  private projScratch = new THREE.Vector3();
  private forward = new THREE.Vector3();

  constructor(
    sim: SimClient,
    field: PlanetField,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
  ) {
    this.sim = sim;
    this.field = field;
    this.camera = camera;
    this.canvas = canvas;

    this.root = document.createElement('div');
    this.root.className = 'pp-inspect';
    this.root.setAttribute('hidden', '');
    this.root.innerHTML = `
      <button class="pp-inspect-close" id="pp-inspect-close" aria-label="Close">×</button>
      <div class="pp-inspect-head">
        <span class="pp-swatch" id="pp-inspect-swatch"></span>
        <div>
          <b id="pp-inspect-title"></b>
          <i id="pp-inspect-meta"></i>
        </div>
      </div>
      <div class="pp-inspect-body" id="pp-inspect-body"></div>
      <div class="pp-inspect-lines" id="pp-inspect-lines"></div>
      <button class="pp-btn pp-inspect-go" id="pp-inspect-go">Go there</button>
    `;

    this.titleEl = this.root.querySelector('#pp-inspect-title')!;
    this.metaEl = this.root.querySelector('#pp-inspect-meta')!;
    this.bodyEl = this.root.querySelector('#pp-inspect-body')!;
    this.swatchEl = this.root.querySelector('#pp-inspect-swatch')!;
    this.linesEl = this.root.querySelector('#pp-inspect-lines')!;

    this.root.querySelector('#pp-inspect-close')!.addEventListener('click', () => this.close());
    this.root.querySelector('#pp-inspect-go')!.addEventListener('click', () => {
      if (!this.current) return;
      // Low enough that the town is built rather than a marker, high enough to
      // see the whole of it. A metropolis is a couple of hundred metres across.
      const altitude = this.current.kind === 'ground' ? 320 : 190;
      this.onGoTo?.(this.current.direction, altitude);
    });
  }

  close(): void {
    this.current = null;
    this.root.setAttribute('hidden', '');
  }

  get open(): boolean {
    return this.current !== null;
  }

  /** Where the panel is currently pointed, if anywhere. */
  get selection(): Pick | null {
    return this.current;
  }

  /** Handle a tap at a screen position. Returns what it found, if anything. */
  tap(clientX: number, clientY: number, groundDirection: THREE.Vector3 | null): Pick | null {
    const marker = this.pickSettlement(clientX, clientY);
    if (marker) {
      this.show(marker);
      return marker;
    }
    if (!groundDirection) {
      this.close();
      return null;
    }
    const cell = this.nearestCell(groundDirection);
    if (cell < 0) {
      this.close();
      return null;
    }
    const pick: Pick = { kind: 'ground', cell, direction: groundDirection.clone() };
    this.show(pick);
    return pick;
  }

  /** Open the panel on a specific cell, e.g. from a tapped chronicle line. */
  showCell(cell: number): Pick | null {
    const positions = this.sim.cellPositions;
    if (!positions || cell < 0 || cell * 3 + 2 >= positions.length) return null;
    const direction = new THREE.Vector3(
      positions[cell * 3],
      positions[cell * 3 + 1],
      positions[cell * 3 + 2],
    ).normalize();

    const settlement = this.sim.settlements.find((s) => s.cell === cell);
    if (settlement) {
      const pick: Pick = { kind: 'settlement', cell, direction, settlement };
      this.show(pick);
      return pick;
    }
    const ruin = this.sim.ruins.find((r) => r.cell === cell);
    if (ruin) {
      const pick: Pick = { kind: 'ruin', cell, direction, ruin };
      this.show(pick);
      return pick;
    }
    const pick: Pick = { kind: 'ground', cell, direction };
    this.show(pick);
    return pick;
  }

  /** Refresh the open panel from the latest simulation state. */
  refresh(): void {
    if (this.current) this.show(this.current, true);
  }

  // --- Picking -------------------------------------------------------------

  /** Screen position of a cell, or null when it is behind the planet. */
  private project(cell: number, out: THREE.Vector3): boolean {
    const positions = this.sim.cellPositions;
    const heights = this.sim.cellHeights;
    if (!positions || !heights) return false;

    const r = PLANET_RADIUS + Math.max(0, heights[cell]);
    this.worldScratch
      .set(positions[cell * 3], positions[cell * 3 + 1], positions[cell * 3 + 2])
      .multiplyScalar(r);

    // Behind the camera projects to a mirrored position rather than to nothing,
    // so reject it explicitly before projecting.
    this.camera.getWorldDirection(this.forward);
    out.copy(this.worldScratch).sub(this.camera.position);
    if (out.dot(this.forward) <= 0) return false;

    // Over the horizon: the point is on the far side of the planet, and a
    // marker there would be picked through the world.
    const toCamera = this.camera.position.length();
    const horizon = Math.sqrt(Math.max(0, toCamera * toCamera - PLANET_RADIUS * PLANET_RADIUS));
    if (this.worldScratch.distanceTo(this.camera.position) > horizon + PLANET_RADIUS * 0.02) {
      return false;
    }

    out.copy(this.worldScratch).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    out.set(
      rect.left + ((out.x + 1) / 2) * rect.width,
      rect.top + ((1 - out.y) / 2) * rect.height,
      0,
    );
    return true;
  }

  private pickSettlement(clientX: number, clientY: number): Pick | null {
    let best: Pick | null = null;
    let bestScore = Infinity;

    const consider = (cell: number, weight: number, make: () => Pick): void => {
      if (!this.project(cell, this.projScratch)) return;
      const d = Math.hypot(this.projScratch.x - clientX, this.projScratch.y - clientY);
      if (d > TAP_RADIUS) return;
      // A larger place wins a tie: from orbit a metropolis and the village next
      // to it land on the same pixel, and the metropolis is what was meant.
      const score = d / weight;
      if (score < bestScore) {
        bestScore = score;
        best = make();
      }
    };

    for (const s of this.sim.settlements) {
      consider(s.cell, 1 + s.tier * 0.35, () => ({
        kind: 'settlement',
        cell: s.cell,
        direction: this.directionOf(s.cell),
        settlement: s,
      }));
    }
    for (const r of this.sim.ruins) {
      consider(r.cell, 0.9, () => ({
        kind: 'ruin',
        cell: r.cell,
        direction: this.directionOf(r.cell),
        ruin: r,
      }));
    }
    return best;
  }

  private directionOf(cell: number): THREE.Vector3 {
    const p = this.sim.cellPositions!;
    return new THREE.Vector3(p[cell * 3], p[cell * 3 + 1], p[cell * 3 + 2]).normalize();
  }

  /**
   * The cell nearest a direction.
   *
   * A linear scan of four thousand dot products, once per tap. A spatial index
   * would be faster and would also be the first thing to go stale; at this rate
   * it would save a fraction of a millisecond on an interaction the player
   * performs a few times a minute.
   */
  private nearestCell(direction: THREE.Vector3): number {
    const p = this.sim.cellPositions;
    if (!p) return -1;
    let best = -1;
    let bestDot = -2;
    for (let i = 0; i < p.length / 3; i++) {
      const d = direction.x * p[i * 3] + direction.y * p[i * 3 + 1] + direction.z * p[i * 3 + 2];
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    return best;
  }

  // --- Rendering -----------------------------------------------------------

  private polityOf(cell: number): PolityView | undefined {
    const owner = this.sim.cellOwner;
    if (!owner || cell >= owner.length) return undefined;
    const id = owner[cell];
    if (id === 0) return undefined;
    return this.sim.polities.find((p) => p.id === id);
  }

  private show(pick: Pick, quiet = false): void {
    this.current = pick;
    const direction = pick.direction;
    const sample = this.field.sample(direction.x, direction.y, direction.z, 1);
    const holder = this.polityOf(pick.cell);

    const rows: string[] = [];
    let title = '';
    let meta = '';
    let hue: number | null = holder ? holder.hue : null;

    if (pick.kind === 'settlement' && pick.settlement) {
      const s = pick.settlement;
      const ruler = this.sim.polities.find((p) => p.id === s.polity) ?? holder;
      hue = ruler ? ruler.hue : hue;
      const age = Math.max(0, this.sim.tick - s.founded);
      title = s.name;
      meta = `${TIER_NAMES[Math.min(TIER_NAMES.length - 1, s.tier)]} · ${formatPopulation(s.population)} people`;

      rows.push(`Founded in year ${s.founded}, ${age} year${age === 1 ? '' : 's'} ago.`);
      if (ruler) {
        rows.push(`Held by ${ruler.name}.`);
        rows.push(`${ERA_NAMES[ruler.era]} age · ${ruler.culture} · ${ruler.religion}.`);
        if (ruler.capital === s.cell) rows.push('The seat of government.');
        if (ruler.atWarWith >= 0) {
          const enemy = this.sim.polities.find((p) => p.id === ruler.atWarWith);
          if (enemy) rows.push(`At war with ${enemy.name}.`);
        }
      } else {
        rows.push('Held by no one.');
      }
      rows.push(`${biomeName(sample.height, sample.moisture, sample.temperature)}, ${sample.height.toFixed(0)} m above the sea.`);
    } else if (pick.kind === 'ruin' && pick.ruin) {
      const age = Math.max(0, this.sim.tick - pick.ruin.abandoned);
      title = pick.ruin.name;
      meta = 'Ruins';
      rows.push(`Abandoned in year ${pick.ruin.abandoned}, ${age} year${age === 1 ? '' : 's'} ago.`);
      rows.push(
        holder
          ? `The land is claimed by ${holder.name}, but no one lives here.`
          : 'Unclaimed. Nothing has come back.',
      );
      rows.push(`${biomeName(sample.height, sample.moisture, sample.temperature)}, ${sample.height.toFixed(0)} m above the sea.`);
      hue = holder ? holder.hue : null;
    } else {
      title = biomeName(sample.height, sample.moisture, sample.temperature);
      meta =
        sample.height > 0
          ? `${sample.height.toFixed(0)} m above the sea`
          : `${(-sample.height).toFixed(0)} m below the sea`;
      const warmth = Math.round(sample.temperature * 100);
      const wet = Math.round(sample.moisture * 100);
      rows.push(`Warmth ${warmth}%, moisture ${wet}%.`);
      rows.push(holder ? `Claimed by ${holder.name}.` : 'Claimed by no one.');
      const near = this.nearestSettlement(pick.cell);
      if (near) rows.push(`Nearest settlement: ${near.name}.`);
    }

    this.titleEl.textContent = title;
    this.metaEl.textContent = meta;
    if (hue !== null) {
      const [r, g, b] = polityColor(hue);
      this.swatchEl.setAttribute(
        'style',
        `background: rgb(${(r * 255) | 0}, ${(g * 255) | 0}, ${(b * 255) | 0})`,
      );
      this.swatchEl.removeAttribute('hidden');
    } else {
      this.swatchEl.setAttribute('hidden', '');
    }

    this.bodyEl.innerHTML = '';
    for (const row of rows) {
      const el = document.createElement('p');
      el.textContent = row;
      this.bodyEl.appendChild(el);
    }

    this.renderHistory(pick.cell);
    this.root.removeAttribute('hidden');
    if (!quiet) {
      // Restart the entrance animation only when the selection actually
      // changed, so a per-tick refresh does not make the panel flash.
      this.root.classList.remove('pp-in');
      void this.root.offsetWidth;
      this.root.classList.add('pp-in');
    }
  }

  private nearestSettlement(cell: number): SettlementView | null {
    const p = this.sim.cellPositions;
    if (!p) return null;
    let best: SettlementView | null = null;
    let bestDot = -2;
    const x = p[cell * 3], y = p[cell * 3 + 1], z = p[cell * 3 + 2];
    for (const s of this.sim.settlements) {
      const d = x * p[s.cell * 3] + y * p[s.cell * 3 + 1] + z * p[s.cell * 3 + 2];
      if (d > bestDot) {
        bestDot = d;
        best = s;
      }
    }
    return best;
  }

  /** Chronicle lines that happened here. A place's own history, in place. */
  private renderHistory(cell: number): void {
    this.linesEl.innerHTML = '';
    const here = this.sim.chronicle.filter((l) => l.cell === cell).slice(-4);
    for (const line of here) {
      const el = document.createElement('div');
      el.className = 'pp-inspect-line';
      el.innerHTML = `<span>${line.tick}</span>`;
      el.appendChild(document.createTextNode(line.text));
      this.linesEl.appendChild(el);
    }
  }
}

/**
 * Ground detail: which towns get built, and when.
 *
 * The layers below this one know how to draw a building, a road, a tree and a
 * person. This decides which of them exist. On a planet with three hundred
 * settlements and a camera that can be anywhere from six metres to four
 * thousand kilometres up, that decision is the whole system.
 *
 * Three budgets, in order of how expensive it is to get them wrong:
 *
 *   **Planning.** Laying out a metropolis costs a few milliseconds of terrain
 *   sampling. At most one town is planned per frame, and plans are cached until
 *   the town's tier, era or culture actually changes — conquest does not
 *   rebuild a town, it repaints the banners, which is also what conquest looks
 *   like.
 *
 *   **Upload.** Instances are pooled across every town, so the whole visible
 *   world is a handful of draw calls. Buffers are only rewritten when the set
 *   of visible towns changes, not per frame.
 *
 *   **Distance.** Each layer has its own range, and they are deliberately
 *   nested rather than equal: roads appear first because a road is legible from
 *   far higher up than the buildings beside it, then buildings, then the fields,
 *   then people last — because people only pay off in the final few metres of a
 *   descent, and everything else reads from much higher.
 */

import * as THREE from 'three';
import { PLANET_RADIUS } from '../../planet/config';
import { Era } from '../../sim/types';
import type { PlanetField } from '../../planet/heightfield';
import type { SharedUniforms } from '../environment';
import type { PolityView, SettlementView, WonderView } from '../../sim/protocol';
import { polityColor } from '../../sim/protocol';
import { BUILDING_FAR, BUILDING_NEAR, BuildingLayer } from './buildings';
import { ROAD_FAR, ROAD_NEAR, RoadLayer } from './roads';
import { PROP_FAR, PROP_NEAR, PropLayer } from './props';
import { PEOPLE_FAR, PEOPLE_NEAR, PeopleLayer } from './people';
import { planTown, signatureOf } from './plan';
import type { ArchetypeName } from './archetypes';
import { kitShowcase } from './showcase';
import type { TownPlan, TownRequest } from './plan';
import { townStyle } from './style';
import type { Rgb } from './style';

/** Most towns detailed at once. Beyond this the far ones are simply dropped. */
const MAX_TOWNS = 40;

/** How long may be spent planning towns in one frame. */
const PLAN_BUDGET_MS = 3.5;

/** A settlement that is gone but not forgotten. */
export interface RuinView {
  cell: number;
  name: string;
  abandoned: number;
}

interface Active {
  cell: number;
  distance: number;
  plan: TownPlan;
  banner: Rgb;
  lamps: number;
  roadColor: Rgb;
}

export class GroundDetail {
  readonly group = new THREE.Group();

  private buildings: BuildingLayer;
  private roads: RoadLayer;
  private props: PropLayer;
  private people: PeopleLayer;

  private field: PlanetField;
  private worldSeed: number;

  private plans = new Map<number, TownPlan>();
  private pending: TownRequest[] = [];
  private cellPositions: Float32Array | null = null;

  /** What the last upload was built from. */
  private uploaded = '';
  private lastPlanMs = 0;
  private townCount = 0;

  private cameraPos = new THREE.Vector3();
  private unit = new THREE.Vector3();

  constructor(shared: SharedUniforms, field: PlanetField, worldSeed: number) {
    this.field = field;
    this.worldSeed = worldSeed;

    this.buildings = new BuildingLayer(shared);
    this.roads = new RoadLayer(shared);
    this.props = new PropLayer(shared);
    this.people = new PeopleLayer(shared);

    this.group.name = 'ground-detail';
    this.group.add(this.buildings.group, this.roads.mesh, this.props.mesh, this.people.mesh);
  }

  setCellData(positions: Float32Array): void {
    this.cellPositions = positions;
  }

  /**
   * Scale every range by a quality factor. One dial, because the four ranges
   * are tuned against each other and moving one alone breaks the nesting.
   */
  setRangeScale(scale: number): void {
    this.buildings.setRange(BUILDING_NEAR * scale, BUILDING_FAR * scale);
    this.roads.setRange(ROAD_NEAR * scale, ROAD_FAR * scale);
    this.props.setRange(PROP_NEAR * scale, PROP_FAR * scale);
    this.people.setRange(PEOPLE_NEAR * scale, PEOPLE_FAR * scale);
    this.rangeScale = scale;
  }

  private rangeScale = 1;

  /**
   * Coast test, done here rather than in the simulation.
   *
   * Four samples at a hundred metres. The simulation has this information in
   * its cell flags, but sending it would grow the state message for one
   * cosmetic decision — whether a great city gets a lighthouse.
   */
  private isCoastal(dir: THREE.Vector3): boolean {
    const probe = new THREE.Vector3();
    const ref = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const east = new THREE.Vector3().crossVectors(ref, dir).normalize();
    const north = new THREE.Vector3().crossVectors(dir, east);
    const d = 140 / PLANET_RADIUS;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      probe.copy(dir).addScaledVector(east, a * d).addScaledVector(north, b * d).normalize();
      if (this.field.height(probe.x, probe.y, probe.z, 4) < -0.5) return true;
    }
    return false;
  }

  /**
   * Show the whole model catalogue instead of the world's towns.
   *
   * A development view, reachable with `?kit=1`. It replaces the town selection
   * entirely rather than adding to it, so nothing else can wander into frame
   * while a model is being judged.
   */
  setShowcase(row: number | 'all' | null): void {
    this.showcase = row;
    this.uploaded = '';
  }

  private showcase: number | 'all' | null = null;

  /**
   * Where the camera is actually looking, on the ground.
   *
   * Not the point below the camera. The rig tilts towards the horizon as it
   * descends, so by a couple of hundred metres up the nadir is off the bottom
   * of the screen — and a sheet of models centred on it is a sheet of models
   * nobody can see.
   */
  private viewCentre(camera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    camera.getWorldPosition(this.cameraPos);
    camera.getWorldDirection(out);
    const radius = PLANET_RADIUS + 12;
    const b = this.cameraPos.dot(out);
    const c = this.cameraPos.lengthSq() - radius * radius;
    const disc = b * b - c;
    const t = disc > 0 ? -b - Math.sqrt(disc) : -b;
    return out.multiplyScalar(Math.max(t, 0)).add(this.cameraPos).normalize();
  }

  /**
   * Choose the visible towns, plan what needs planning, and upload.
   *
   * Called every frame; almost every frame it does nothing but a distance sort.
   */
  update(
    camera: THREE.PerspectiveCamera,
    settlements: SettlementView[],
    polities: PolityView[],
    ruins: RuinView[],
    wonders: WonderView[] = [],
  ): void {
    if (this.showcase !== null) {
      this.viewCentre(camera, this.unit);
      const key = `kit:${this.showcase}:${this.unit.toArray().map((v) => v.toFixed(3)).join(',')}`;
      if (this.uploaded !== key) {
        this.uploaded = key;
        const plan = kitShowcase(this.field, this.unit, this.showcase);
        this.townCount = 1;
        this.upload([
          {
            cell: -1,
            distance: 0,
            plan,
            banner: [0.85, 0.3, 0.25],
            lamps: 1,
            roadColor: [0.3, 0.28, 0.26],
          },
        ]);
      }
      return;
    }

    const positions = this.cellPositions;
    if (!positions) return;

    camera.getWorldPosition(this.cameraPos);
    const altitude = this.cameraPos.length() - PLANET_RADIUS;

    // Nothing below this altitude band can be close enough to matter, and
    // skipping the sort entirely is what keeps the orbital view free.
    const reach = ROAD_FAR * this.rangeScale;
    if (altitude > reach * 1.6) {
      if (this.townCount !== 0) this.clear();
      return;
    }

    const byPolity = new Map<number, PolityView>();
    for (const p of polities) byPolity.set(p.id, p);
    const wonderAt = new Map<number, ArchetypeName>();
    for (const w of wonders) wonderAt.set(w.cell, w.kind as ArchetypeName);

    const candidates: {
      cell: number;
      distance: number;
      request: TownRequest;
      banner: Rgb;
      style: ReturnType<typeof townStyle>;
    }[] = [];

    const consider = (
      cell: number,
      tier: number,
      era: Era,
      culture: string,
      hue: number,
      capital: boolean,
      ruined: boolean,
    ): void => {
      const c = cell * 3;
      this.unit.set(positions[c], positions[c + 1], positions[c + 2]);
      const height = this.field.height(this.unit.x, this.unit.y, this.unit.z, 8);
      const distance =
        this.cameraPos.distanceTo(
          new THREE.Vector3().copy(this.unit).multiplyScalar(PLANET_RADIUS + height),
        );
      if (distance > reach) return;
      candidates.push({
        cell,
        distance,
        banner: polityColor(hue),
        style: townStyle(era, culture),
        request: {
          cell,
          tier,
          era,
          culture,
          capital,
          coastal: false,
          ruined,
          wonder: wonderAt.get(cell),
          unit: this.unit.clone(),
        },
      });
    };

    for (const s of settlements) {
      const polity = byPolity.get(s.polity);
      if (!polity) continue;
      consider(
        s.cell,
        s.tier,
        polity.era,
        polity.culture,
        polity.hue,
        polity.capital === s.cell,
        false,
      );
    }
    for (const r of ruins) {
      consider(r.cell, 2, Era.Ancient, 'ruin', 0.1, false, true);
    }

    candidates.sort((a, b) => a.distance - b.distance);
    if (candidates.length > MAX_TOWNS) candidates.length = MAX_TOWNS;

    // --- Plan whatever is missing or stale, within the frame's budget -------

    this.pending.length = 0;
    for (const c of candidates) {
      const plan = this.plans.get(c.cell);
      if (!plan || plan.signature !== signatureOf(c.request)) this.pending.push(c.request);
    }

    const start = performance.now();
    let planned = 0;
    for (const request of this.pending) {
      request.coastal = this.isCoastal(request.unit);
      this.plans.set(request.cell, planTown(request, this.field, this.worldSeed));
      planned++;
      if (performance.now() - start > PLAN_BUDGET_MS) break;
    }
    if (planned > 0) this.lastPlanMs = performance.now() - start;

    // Forget towns that have been out of range for a while. The cap is generous
    // because replanning is far more expensive than holding a few hundred
    // kilobytes of positions.
    if (this.plans.size > MAX_TOWNS * 6) {
      const live = new Set(candidates.map((c) => c.cell));
      for (const cell of this.plans.keys()) {
        if (!live.has(cell)) this.plans.delete(cell);
        if (this.plans.size <= MAX_TOWNS * 4) break;
      }
    }

    // --- Upload, but only when something actually changed -------------------

    const active: Active[] = [];
    let signature = '';
    for (const c of candidates) {
      const plan = this.plans.get(c.cell);
      if (!plan) continue;
      active.push({
        cell: c.cell,
        distance: c.distance,
        plan,
        banner: c.banner,
        lamps: c.style.lamps,
        roadColor: c.style.road,
      });
      // Distance is quantised so ordinary camera motion does not force a
      // rebuild every frame, but crossing a band boundary does.
      signature += `${c.cell}:${plan.signature}:${(c.distance / 64) | 0}|`;
    }

    this.townCount = active.length;
    if (signature === this.uploaded) return;
    this.uploaded = signature;
    this.upload(active);
  }

  private upload(active: Active[]): void {
    this.buildings.begin();
    this.roads.begin();
    this.props.begin();
    this.people.begin();

    const scale = this.rangeScale;
    let lampWeight = 0;
    let lampTotal = 0;

    for (const town of active) {
      const { plan } = town;
      const near = town.distance - plan.radius;

      for (const road of plan.roads) this.roads.add(road, town.roadColor);

      if (near < BUILDING_FAR * scale) {
        for (const b of plan.buildings) this.buildings.add(b, town.banner);
        lampTotal += town.lamps;
        lampWeight++;
      }
      if (near < PROP_FAR * scale) {
        for (const p of plan.props) this.props.add(p);
      }
      if (near < PEOPLE_FAR * scale) {
        for (const p of plan.people) this.people.add(p, town.banner);
      }
    }

    this.buildings.commit();
    this.roads.commit();
    this.props.commit();
    this.people.commit();

    // Window and street lighting follows whoever is actually on screen, so
    // flying from a medieval town to an industrial one brightens the night.
    const lamps = lampWeight > 0 ? lampTotal / lampWeight : 0.7;
    this.buildings.setLamps(lamps);
    this.roads.setLamps(lamps);
  }

  private clear(): void {
    this.buildings.begin();
    this.roads.begin();
    this.props.begin();
    this.people.begin();
    this.buildings.commit();
    this.roads.commit();
    this.props.commit();
    this.people.commit();
    this.townCount = 0;
    this.uploaded = '';
  }

  getStats(): Record<string, number> {
    return {
      towns: this.townCount,
      buildings: this.buildings.instanceCount,
      buildingDraws: this.buildings.drawCalls,
      roadTris: this.roads.triangles,
      plants: this.props.instanceCount,
      people: this.people.instanceCount,
      planMs: this.lastPlanMs,
      cachedPlans: this.plans.size,
    };
  }

  /** The plan for a cell, if one has been built. Used by the inspector. */
  planFor(cell: number): TownPlan | undefined {
    return this.plans.get(cell);
  }

  dispose(): void {
    this.buildings.dispose();
    this.roads.dispose();
    this.props.dispose();
    this.people.dispose();
    this.plans.clear();
  }
}

/**
 * Ground detail: which towns get built, and when.
 *
 * The layers below this one know how to draw a building, a road, a tree, a
 * person, a fire and a banner. This decides which of them exist. On a planet
 * with three hundred settlements and a camera that can be anywhere from six
 * metres to four thousand kilometres up, that decision is the whole system.
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
import { FIRE_FAR, FIRE_NEAR, FireLayer } from './fires';
import { BANNER_FAR, BANNER_NEAR, BannerLayer } from './banners';
import { SIEGE_FAR, SIEGE_NEAR, SMOKE_FAR, SMOKE_NEAR, SiegeLayer, SmokeLayer } from './war';
import type { ShotPlacement } from './war';
import { makeRng, mixSeed } from '../../core/rng';
import { TIER_RADIUS, planTown, signatureOf } from './plan';
import type { ArchetypeName } from './archetypes';
import { kitShowcase } from './showcase';
import { RoadNetwork } from './network';
import type { NetworkTown } from './network';
import { Wilderness } from './wilderness';
import type { RoadPath, TownPlan, TownRequest } from './plan';
import { townStyle } from './style';
import type { Rgb } from './style';

/** Most towns detailed at once. Beyond this the far ones are simply dropped. */
const MAX_TOWNS = 40;

/**
 * Most towns considered for the road network.
 *
 * Deliberately larger than `MAX_TOWNS`. A road is drawn from far higher up than
 * the buildings at either end of it, and a network computed only over the forty
 * towns that are close enough to have streets would stop dead at an invisible
 * boundary — every road leaving the region cut off in a field.
 */
const MAX_LINKED = 160;

/** How long may be spent planning towns in one frame. */
const PLAN_BUDGET_MS = 3.5;

/** A settlement that is gone but not forgotten. */
export interface RuinView {
  cell: number;
  name: string;
  abandoned: number;
}

/**
 * The colour of a road between towns.
 *
 * One colour for the whole network rather than each town's own, because a road
 * is a single object that happens to have two ends, and shading half of it in
 * one culture's palette and half in another's makes it read as two roads that
 * meet.
 */
const ROUTE_COLOR: Rgb = [0.34, 0.30, 0.25];

interface Active {
  cell: number;
  distance: number;
  plan: TownPlan;
  banner: Rgb;
  lamps: number;
  roadColor: Rgb;
  /**
   * The enemy this town is on the front line against, as a unit position, or
   * null if nobody is fighting over it. It is a direction rather than a flag
   * because the arrows have to come from somewhere, and coming from the enemy's
   * side of the town is most of what makes a siege read as a siege.
   */
  attacker: THREE.Vector3 | null;
}

/** Columns of smoke over a settlement on the front line. */
const BURNING_MAX = 5;

/** Arrows in the air over a besieged town at any one time. */
const SIEGE_SHOTS = 14;

export class GroundDetail {
  readonly group = new THREE.Group();

  private buildings: BuildingLayer;
  private roads: RoadLayer;
  private props: PropLayer;
  private people: PeopleLayer;
  private fires: FireLayer;
  private banners: BannerLayer;
  private smoke: SmokeLayer;
  private siege: SiegeLayer;

  private field: PlanetField;
  private worldSeed: number;
  private wild: Wilderness;
  private network: RoadNetwork;
  private networkTowns = new Map<number, NetworkTown>();
  private networkRoads: RoadPath[] = [];

  private plans = new Map<number, TownPlan>();
  private pending: TownRequest[] = [];
  private cellPositions: Float32Array | null = null;

  /** What the last upload was built from. */
  private uploaded = '';
  private lastPlanMs = 0;
  private townCount = 0;

  /**
   * Which settlements a war is being fought over, and from where.
   *
   * A war in this simulation is a state of two polities, not a set of armies
   * with positions, so the front has to be inferred: the pair of settlements —
   * one on each side — that are closest to each other. That is where the
   * fighting is, it is the town that changes hands, and it is a far better
   * choice than burning every settlement of a belligerent, which would set a
   * continent alight because two kingdoms fell out over a border.
   *
   * Memoised on the identity of the arrays it was computed from. Those are
   * replaced wholesale by each state message from the worker, so this is exact:
   * it recomputes when the simulation says something changed and at no other
   * time, which matters because the scan is quadratic in settlements per war.
   */
  private frontOf = new Map<number, THREE.Vector3>();
  private frontKey: unknown = null;

  private cameraPos = new THREE.Vector3();
  private unit = new THREE.Vector3();
  private wildCentre = new THREE.Vector3();
  private wildExclude: { centre: THREE.Vector3; radius: number }[] = [];
  private shots: ShotPlacement[] = [];

  constructor(shared: SharedUniforms, field: PlanetField, worldSeed: number) {
    this.field = field;
    this.worldSeed = worldSeed;

    this.wild = new Wilderness(field, worldSeed);
    this.network = new RoadNetwork(field);
    this.buildings = new BuildingLayer(shared);
    this.roads = new RoadLayer(shared);
    this.props = new PropLayer(shared);
    this.people = new PeopleLayer(shared);
    this.fires = new FireLayer(shared);
    this.banners = new BannerLayer(shared);
    this.smoke = new SmokeLayer(shared);
    this.siege = new SiegeLayer(shared);

    this.group.name = 'ground-detail';
    this.group.add(
      this.buildings.group,
      this.roads.mesh,
      this.props.mesh,
      this.people.mesh,
      this.fires.mesh,
      this.banners.mesh,
      this.smoke.mesh,
      this.siege.arrows,
      this.siege.impacts,
    );
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
    this.fires.setRange(FIRE_NEAR * scale, FIRE_FAR * scale);
    this.banners.setRange(BANNER_NEAR * scale, BANNER_FAR * scale);
    this.smoke.setRange(SMOKE_NEAR * scale, SMOKE_FAR * scale);
    this.siege.setRange(SIEGE_NEAR * scale, SIEGE_FAR * scale);
    this.rangeScale = scale;
    this.wild.invalidate();
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
    // The sheet shows the catalogue and nothing else; a stale wilderness would
    // otherwise stay uploaded and put a forest through the middle of it.
    this.wild.clear();
  }

  private showcase: number | 'all' | null = null;

  /**
   * Besiege every town in view, whether or not anybody is at war.
   *
   * A development view, reachable with `?siege=1`, and the counterpart of
   * `?kit=`. A war is a thing the simulation decides on its own schedule
   * somewhere on a planet with three hundred settlements, which makes the one
   * part of the ground detail that only exists during a war nearly impossible
   * to look at on purpose — and looking at it is how everything else here got
   * tuned.
   */
  setSiege(on: boolean): void {
    if (this.siegeAll === on) return;
    this.siegeAll = on;
    this.uploaded = '';
  }

  private siegeAll = false;

  /** An imaginary enemy just east of the town, for `setSiege`. */
  private mockAttacker(cell: number, positions: Float32Array): THREE.Vector3 | null {
    if (!this.siegeAll) return null;
    const c = cell * 3;
    return new THREE.Vector3(positions[c], positions[c + 1], positions[c + 2])
      .add(new THREE.Vector3(0.02, 0, 0.02))
      .normalize();
  }

  private front(
    settlements: SettlementView[],
    polities: PolityView[],
    positions: Float32Array,
  ): Map<number, THREE.Vector3> {
    if (this.frontKey === settlements) return this.frontOf;
    this.frontKey = settlements;
    this.frontOf.clear();

    const enemyOf = new Map<number, number>();
    for (const p of polities) if (p.alive && p.atWarWith >= 0) enemyOf.set(p.id, p.atWarWith);
    if (enemyOf.size === 0) return this.frontOf;

    // Both ends of every war, not only the states that named one: a polity can
    // be at war without its own `atWarWith` pointing back, and a front with
    // only one side to it is not a front.
    const belligerents = new Set<number>(enemyOf.keys());
    for (const enemy of enemyOf.values()) belligerents.add(enemy);

    const towns = new Map<number, SettlementView[]>();
    for (const s of settlements) {
      if (!belligerents.has(s.polity)) continue;
      const list = towns.get(s.polity);
      if (list) list.push(s);
      else towns.set(s.polity, [s]);
    }

    const at = (cell: number, out: THREE.Vector3): THREE.Vector3 =>
      out.set(positions[cell * 3], positions[cell * 3 + 1], positions[cell * 3 + 2]);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    const done = new Set<number>();
    for (const [side, enemy] of enemyOf) {
      // Each war once, from whichever end names it first.
      const pair = side < enemy ? side * 65536 + enemy : enemy * 65536 + side;
      if (done.has(pair)) continue;
      done.add(pair);

      const ours = towns.get(side);
      const theirs = towns.get(enemy);
      if (!ours || !theirs) continue;

      let best = Infinity;
      let ourCell = -1;
      let theirCell = -1;
      for (const x of ours) {
        at(x.cell, a);
        for (const y of theirs) {
          const d = a.distanceToSquared(at(y.cell, b));
          if (d >= best) continue;
          best = d;
          ourCell = x.cell;
          theirCell = y.cell;
        }
      }
      if (ourCell < 0) continue;
      // Each end of the front is besieged by the other, which is what points
      // the arrows over the right wall.
      this.frontOf.set(ourCell, at(theirCell, new THREE.Vector3()));
      this.frontOf.set(theirCell, at(ourCell, new THREE.Vector3()));
    }
    return this.frontOf;
  }

  /**
   * Where a besieging line stands, and what it is shooting at.
   *
   * Loosed from outside the built radius on the enemy's side of the town and
   * dropped inside it. Seeded from the cell, so the same siege is the same
   * siege every time it is uploaded rather than a new volley per frame.
   */
  private siegeShots(plan: TownPlan, attacker: THREE.Vector3, out: ShotPlacement[]): void {
    const up = plan.centre.clone().normalize();
    const ref = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const east = new THREE.Vector3().crossVectors(ref, up).normalize();
    const north = new THREE.Vector3().crossVectors(up, east);

    // The enemy's bearing, flattened onto the ground the town stands on.
    const toEnemy = attacker.clone().addScaledVector(up, -attacker.dot(up));
    const bearing = toEnemy.lengthSq() > 1e-9
      ? Math.atan2(toEnemy.dot(north), toEnemy.dot(east))
      : 0;

    const rng = makeRng(mixSeed(this.worldSeed, plan.cell * 7717 + 13));
    const dir = new THREE.Vector3();
    const ground = (a: number, b: number, lift: number): THREE.Vector3 => {
      dir
        .copy(up)
        .addScaledVector(east, a / PLANET_RADIUS)
        .addScaledVector(north, b / PLANET_RADIUS)
        .normalize();
      const h = this.field.height(dir.x, dir.y, dir.z, 0.5);
      return dir.clone().multiplyScalar(PLANET_RADIUS + h + lift);
    };

    for (let i = 0; i < SIEGE_SHOTS; i++) {
      // A line, not a ring: an army is on one side of the town.
      const from = bearing + rng.range(-0.7, 0.7);
      const into = from + rng.range(-0.5, 0.5);
      const out0 = plan.radius * rng.range(1.35, 1.85);
      const in0 = plan.radius * rng.range(0.05, 0.9);
      out.push({
        from: ground(Math.cos(from) * out0, Math.sin(from) * out0, 1.6),
        to: ground(Math.cos(into) * in0, Math.sin(into) * in0, 0.2),
        arc: rng.range(7, 16),
        rate: rng.range(0.22, 0.42),
        phase: rng.next(),
      });
    }
  }

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
            attacker: null,
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
      polity: number;
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
      polity: number,
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
        polity,
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
        s.polity,
      );
    }
    for (const r of ruins) {
      consider(r.cell, 2, Era.Ancient, 'ruin', 0.1, false, true, -1);
    }

    candidates.sort((a, b) => a.distance - b.distance);

    // --- The road network between them --------------------------------------
    //
    // Built from a wider set than the one that gets streets, and before the
    // list is truncated, so that a road leaving the detailed region still has
    // somewhere to go. Ruins are left out: nobody maintains the road to a town
    // that emptied four centuries ago, and drawing one is the strongest
    // possible statement that somebody does.
    this.networkTowns.clear();
    const linkable: NetworkTown[] = [];
    for (const c of candidates) {
      if (c.request.ruined) continue;
      if (linkable.length >= MAX_LINKED) break;
      const tier = Math.min(TIER_RADIUS.length - 1, Math.max(0, c.request.tier));
      const town: NetworkTown = {
        cell: c.cell,
        unit: c.request.unit,
        radius: TIER_RADIUS[tier] * c.style.spread,
        polity: c.polity,
        tier,
        era: c.request.era,
      };
      linkable.push(town);
      this.networkTowns.set(c.cell, town);
    }
    const networkChanged = this.network.update(linkable);

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

    const front = this.front(settlements, polities, positions);
    const active: Active[] = [];
    let signature = '';
    for (const c of candidates) {
      const plan = this.plans.get(c.cell);
      if (!plan) continue;
      const attacker = front.get(c.cell) ?? this.mockAttacker(c.cell, positions);
      active.push({
        cell: c.cell,
        distance: c.distance,
        plan,
        banner: c.banner,
        lamps: c.style.lamps,
        roadColor: c.style.road,
        attacker,
      });
      // Distance is quantised so ordinary camera motion does not force a
      // rebuild every frame, but crossing a band boundary does. Whether the
      // town is burning is not quantised: a war starting is exactly the kind of
      // change that has to reach the screen the moment the simulation says so.
      signature += `${c.cell}:${plan.signature}:${(c.distance / 64) | 0}:${attacker ? 1 : 0}|`;
    }

    // Vegetation outside the towns. Follows the view centre rather than the
    // camera's nadir for the same reason the kit sheet does: at any altitude
    // worth scattering for, the two are a long way apart.
    this.viewCentre(camera, this.wildCentre);
    const wildReach =
      altitude < PROP_FAR * this.rangeScale ? PROP_FAR * this.rangeScale * 0.95 : 0;
    this.wildExclude.length = 0;
    for (const c of candidates) {
      const plan = this.plans.get(c.cell);
      if (plan) this.wildExclude.push({ centre: plan.centre, radius: plan.radius });
    }
    const wildChanged = this.wild.update(this.wildCentre, wildReach, this.wildExclude);

    this.townCount = active.length;
    if (signature === this.uploaded && !wildChanged && !networkChanged) return;
    this.uploaded = signature;
    this.upload(active);
  }

  private upload(active: Active[]): void {
    this.buildings.begin();
    this.roads.begin();
    this.props.begin();
    this.people.begin();
    this.fires.begin();
    this.banners.begin();
    this.smoke.begin();
    this.siege.begin();

    const scale = this.rangeScale;
    let lampWeight = 0;
    let lampTotal = 0;

    for (const p of this.wild.props) this.props.add(p);

    // The routes between towns, before the towns themselves: an inter-town road
    // should read as the thing the streets join, not as something laid over
    // them.
    this.networkRoads.length = 0;
    this.network.roads(this.networkTowns, this.networkRoads);
    for (const road of this.networkRoads) this.roads.add(road, ROUTE_COLOR);

    for (const town of active) {
      const { plan } = town;
      const near = town.distance - plan.radius;

      for (const road of plan.roads) this.roads.add(road, town.roadColor);
      for (const plaza of plan.plazas) this.roads.addPlaza(plaza, town.roadColor);

      if (near < BUILDING_FAR * scale) {
        for (const b of plan.buildings) this.buildings.add(b, town.banner);
        lampTotal += town.lamps;
        lampWeight++;
      }
      if (near < PROP_FAR * scale) {
        for (const p of plan.props) this.props.add(p);
      }
      if (near < PEOPLE_FAR * scale) {
        for (const p of plan.people) this.people.add(p, town.banner, plan.era);
      }
      if (near < FIRE_FAR * scale) {
        for (const f of plan.fires) this.fires.add(f);
      }
      if (near < BANNER_FAR * scale) {
        for (const b of plan.banners) this.banners.add(b, town.banner);
      }

      // --- The war, if there is one here ------------------------------------

      if (!town.attacker) continue;
      if (near < SMOKE_FAR * scale) {
        // Rooted on the roofs of buildings spread through the town rather than
        // on a ring around it: what is burning is the settlement, and a column
        // standing in an empty field beside one reads as a bonfire.
        const all = plan.buildings;
        const columns = Math.min(BURNING_MAX, 2 + ((all.length / 26) | 0));
        const stride = Math.max(1, (all.length / columns) | 0);
        for (let n = 0; n < columns; n++) {
          const b = all[n * stride];
          if (!b) break;
          this.smoke.add({
            origin: b.origin,
            size: 34 + (n % 3) * 16,
            phase: (n * 0.37) % 1,
          });
        }
      }
      if (near < SIEGE_FAR * scale) {
        this.shots.length = 0;
        this.siegeShots(plan, town.attacker, this.shots);
        for (const shot of this.shots) this.siege.add(shot);
      }
    }

    this.buildings.commit();
    this.roads.commit();
    this.props.commit();
    this.people.commit();
    this.fires.commit();
    this.banners.commit();
    this.smoke.commit();
    this.siege.commit();

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
    this.fires.begin();
    this.banners.begin();
    this.smoke.begin();
    this.siege.begin();
    this.buildings.commit();
    this.roads.commit();
    this.props.commit();
    this.people.commit();
    this.fires.commit();
    this.banners.commit();
    this.smoke.commit();
    this.siege.commit();
    this.townCount = 0;
    this.uploaded = '';
    this.wild.clear();
    this.network.clear();
  }

  getStats(): Record<string, number> {
    return {
      towns: this.townCount,
      buildings: this.buildings.instanceCount,
      buildingDraws: this.buildings.drawCalls,
      roadTris: this.roads.triangles,
      plants: this.props.instanceCount,
      people: this.people.instanceCount,
      fires: this.fires.instanceCount,
      banners: this.banners.instanceCount,
      burning: this.smoke.instanceCount,
      shots: this.siege.instanceCount,
      planMs: this.lastPlanMs,
      wildMs: this.wild.buildMs,
      wildPlants: this.wild.props.length,
      routes: this.network.routeCount,
      routeMs: this.network.routedMs,
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
    this.fires.dispose();
    this.banners.dispose();
    this.smoke.dispose();
    this.siege.dispose();
    this.plans.clear();
  }
}

/**
 * The kit sheet: every model in the catalogue, laid out on real ground.
 *
 * This exists because judging a building by looking for it in a town does not
 * work. In a town a model is small, half-occluded, at whatever angle the street
 * put it, and lit by whatever the sun happened to be doing — so a roof with the
 * wrong pitch or a wall with no windows on one side can survive a dozen
 * screenshots unnoticed. Lined up on a grid, at a known distance, in known
 * light, every one of those is obvious in a single frame.
 *
 * It is placed on the actual terrain rather than on a flat plane on purpose:
 * how a model sits on uneven ground is one of the things most worth checking,
 * and a debug view that removes the hard part is a debug view that lies.
 */

import * as THREE from 'three';
import { PLANET_RADIUS } from '../../planet/config';
import { Era } from '../../sim/types';
import type { PlanetField } from '../../planet/heightfield';
import { ARCHETYPE_NAMES, archetypes } from './archetypes';
import { samplePalette, townStyle } from './style';
import type { TownPlan } from './plan';

/** Which era's palette suits each model, for the sheet only. */
const PALETTE_ERA: Record<string, Era> = {
  hut: Era.Primitive,
  longhut: Era.Primitive,
  granary: Era.Primitive,
  greathall: Era.Primitive,
  stonecircle: Era.Primitive,
  mudhouse: Era.Ancient,
  courtyard: Era.Ancient,
  temple: Era.Ancient,
  ziggurat: Era.Ancient,
  obelisk: Era.Ancient,
  cottage: Era.Medieval,
  timberhouse: Era.Medieval,
  shophouse: Era.Medieval,
  workshop: Era.Medieval,
  windmill: Era.Medieval,
  watchtower: Era.Medieval,
  keep: Era.Medieval,
  cathedral: Era.Medieval,
  terrace: Era.Industrial,
  tenement: Era.Industrial,
  warehouse: Era.Industrial,
  factory: Era.Industrial,
  clocktower: Era.Industrial,
  station: Era.Industrial,
  lighthouse: Era.Ancient,
  colossus: Era.Ancient,
  well: Era.Medieval,
  stall: Era.Medieval,
  ruin: Era.Ancient,
};

/**
 * Lay the whole kit out around a point.
 *
 * Spacing follows the largest model rather than the average, because a castle
 * is forty metres across and the point of the sheet is that nothing overlaps.
 */
export function kitShowcase(
  field: PlanetField,
  unit: THREE.Vector3,
  row: number | 'all' = 'all',
): TownPlan {
  const up = unit.clone().normalize();
  const ref = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(ref, up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east);

  const columns = 6;
  const names =
    row === 'all'
      ? ARCHETYPE_NAMES
      : ARCHETYPE_NAMES.slice(row * columns, row * columns + columns);
  const rows = Math.ceil(names.length / columns);

  // Spacing follows the largest model actually on the sheet, not a constant.
  // A fixed forty-six metres is what a castle needs and is four times what a
  // well needs — so the row of small props spread out over three hundred
  // metres and could only be photographed from an altitude that made every one
  // of them nine pixels wide.
  const models = archetypes();
  let widest = 0;
  for (const name of names) {
    widest = Math.max(widest, models[name].width, models[name].depth);
  }
  const spacing = Math.max(12, widest * 1.35);

  const buildings: TownPlan['buildings'] = [];
  const direction = new THREE.Vector3();

  names.forEach((name, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const a = (col - (columns - 1) / 2) * spacing;
    const b = (row - (rows - 1) / 2) * spacing;

    direction
      .copy(up)
      .addScaledVector(east, a / PLANET_RADIUS)
      .addScaledVector(north, b / PLANET_RADIUS)
      .normalize();
    const height = field.height(direction.x, direction.y, direction.z, 0.5);

    const style = townStyle(PALETTE_ERA[name] ?? Era.Medieval, 'kit-sheet');
    buildings.push({
      archetype: name,
      origin: direction.clone().multiplyScalar(PLANET_RADIUS + height - 0.3),
      // A slight turn off square: face-on, a box has no depth cue at all, and
      // half the models would look like flat rectangles.
      rot: 0.42,
      scale: new THREE.Vector3(1, 1, 1),
      wall: samplePalette(style.wallA, style.wallB, 0.55, 0),
      roof: samplePalette(style.roofA, style.roofB, 0.5, 0),
      style: style.courses,
    });
  });

  const centreHeight = field.height(up.x, up.y, up.z, 0.5);

  return {
    cell: -1,
    tier: 5,
    era: Era.Medieval,
    signature: 'kit-sheet',
    centre: up.clone().multiplyScalar(PLANET_RADIUS + centreHeight),
    radius: (columns * spacing) / 2,
    buildings,
    roads: [],
    plazas: [],
    props: [],
    people: [],
  };
}
